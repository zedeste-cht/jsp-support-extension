/**
 * JSP tokenizer. Splits a JSP page into regions (directives, scriptlets,
 * expressions, declarations, EL, script/style bodies) and collects the
 * page-level facts the resolvers need (imports, includes, useBeans,
 * script sources, inline event handlers).
 *
 * Pure module: no vscode dependency, all offsets are UTF-16 indices into the
 * original text.
 */

export type JavaRegionKind = 'declaration' | 'expression' | 'scriptlet';
export type RegionKind = JavaRegionKind | 'comment' | 'directive' | 'el' | 'script' | 'style';

export interface Region {
    kind: RegionKind;
    /** Offset of the opening delimiter (e.g. `<%=`). */
    start: number;
    /** Offset just past the closing delimiter. */
    end: number;
    /** Content between the delimiters. */
    contentStart: number;
    contentEnd: number;
}

export interface Attr {
    name: string;
    value: string;
    /** Value offsets, excluding quotes. */
    valueStart: number;
    valueEnd: number;
}

export interface Directive {
    name: string;
    attrs: Attr[];
    start: number;
    end: number;
}

export interface ImportRef {
    fqn: string;
    start: number;
    end: number;
}

export interface IncludeRef {
    path: string;
    kind: 'directive' | 'action';
    attr: Attr;
}

export interface UseBean {
    id: string;
    /** Declared type: `type` attribute, falling back to `class`. */
    typeName: string;
    idAttr: Attr;
    classAttr?: Attr;
    typeAttr?: Attr;
}

export interface ScriptBlock {
    src?: Attr;
    contentStart: number;
    contentEnd: number;
    isJavaScript: boolean;
}

export interface TagInfo {
    name: string;
    start: number;
    end: number;
    attrs: Attr[];
}

export interface JspDocument {
    text: string;
    /** All regions in document order (nested JSP regions inside script/style/attributes included). */
    regions: Region[];
    directives: Directive[];
    imports: ImportRef[];
    includes: IncludeRef[];
    useBeans: UseBean[];
    scripts: ScriptBlock[];
    /** Value ranges of on* attributes and `javascript:` URLs. */
    eventHandlers: { start: number; end: number }[];
    tags: TagInfo[];
}

const JS_SCRIPT_TYPES = new Set([
    '', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript',
    'application/ecmascript', 'text/jsx', 'text/babel',
]);

export function parseJsp(text: string): JspDocument {
    const doc: JspDocument = {
        text, regions: [], directives: [], imports: [], includes: [],
        useBeans: [], scripts: [], eventHandlers: [], tags: [],
    };
    new Scanner(text, doc).scanContent(0, text.length, true);
    doc.regions.sort((a, b) => a.start - b.start);
    return doc;
}

class Scanner {
    constructor(private readonly text: string, private readonly doc: JspDocument) { }

    /**
     * Scan [from, to). When `html` is true, HTML tags are interpreted;
     * otherwise only JSP constructs and EL are recognised (script/style bodies).
     */
    scanContent(from: number, to: number, html: boolean): void {
        const t = this.text;
        let i = from;
        while (i < to) {
            const ch = t.charCodeAt(i);
            if (ch === 0x3C /* < */) {
                const jspEnd = this.tryJsp(i, to);
                if (jspEnd > i) { i = jspEnd; continue; }
                if (html) {
                    const tagEnd = this.tryTag(i, to);
                    if (tagEnd > i) { i = tagEnd; continue; }
                }
            } else if ((ch === 0x24 /* $ */ || ch === 0x23 /* # */) && t.charCodeAt(i + 1) === 0x7B /* { */) {
                if (i === 0 || t[i - 1] !== '\\') {
                    i = this.readEl(i, to);
                    continue;
                }
            }
            i++;
        }
    }

    /** Try to read a JSP construct starting at `i`. Returns the end offset, or `i` when none. */
    tryJsp(i: number, to: number): number {
        const t = this.text;
        if (t.charCodeAt(i + 1) !== 0x25 /* % */) { return i; }

        if (t.startsWith('<%--', i)) {
            const close = t.indexOf('--%>', i + 4);
            const end = close < 0 ? to : close + 4;
            this.push('comment', i, end, i + 4, close < 0 ? to : close);
            return end;
        }

        const close = t.indexOf('%>', i + 2);
        const contentEnd = close < 0 ? to : close;
        const end = close < 0 ? to : close + 2;
        const marker = t[i + 2];

        if (marker === '@') {
            this.push('directive', i, end, i + 3, contentEnd);
            this.readDirective(i, i + 3, contentEnd, end);
        } else if (marker === '!') {
            this.push('declaration', i, end, i + 3, contentEnd);
        } else if (marker === '=') {
            this.push('expression', i, end, i + 3, contentEnd);
        } else {
            this.push('scriptlet', i, end, i + 2, contentEnd);
        }
        return end;
    }

    readEl(i: number, to: number): number {
        const t = this.text;
        let depth = 0;
        let quote = '';
        for (let j = i + 2; j < to; j++) {
            const c = t[j];
            if (quote) {
                if (c === '\\') { j++; continue; }
                if (c === quote) { quote = ''; }
                continue;
            }
            if (c === '"' || c === "'") { quote = c; continue; }
            if (c === '{') { depth++; continue; }
            if (c === '}') {
                if (depth === 0) {
                    this.push('el', i, j + 1, i + 2, j);
                    return j + 1;
                }
                depth--;
            }
            if (c === '\n' && depth === 0 && j - i > 2000) { break; }
        }
        // Unterminated EL: don't swallow the rest of the page.
        return i + 2;
    }

    readDirective(start: number, contentStart: number, contentEnd: number, end: number): void {
        const t = this.text;
        let p = contentStart;
        while (p < contentEnd && /\s/.test(t[p])) { p++; }
        const nameStart = p;
        while (p < contentEnd && /[\w.]/.test(t[p])) { p++; }
        const name = t.substring(nameStart, p);
        const attrs = this.readAttrs(p, contentEnd).attrs;
        const directive: Directive = { name, attrs, start, end };
        this.doc.directives.push(directive);

        if (name === 'page') {
            for (const a of attrs) {
                if (a.name === 'import') { this.splitImports(a); }
            }
        } else if (name === 'include') {
            const file = attrs.find(a => a.name === 'file');
            if (file) { this.doc.includes.push({ path: file.value, kind: 'directive', attr: file }); }
        }
    }

    splitImports(a: Attr): void {
        const re = /[^,]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(a.value)) !== null) {
            const raw = m[0];
            const lead = raw.length - raw.trimStart().length;
            const fqn = raw.trim().replace(/\s+/g, '');
            if (!fqn) { continue; }
            const s = a.valueStart + m.index + lead;
            this.doc.imports.push({ fqn, start: s, end: s + raw.trim().length });
        }
    }

    /**
     * Try to read an HTML/JSP-action tag at `i`. Returns end offset (after the
     * tag and, for script/style, after the element body), or `i` if not a tag.
     */
    tryTag(i: number, to: number): number {
        const t = this.text;
        let p = i + 1;
        const closing = t[p] === '/';
        if (closing) { p++; }
        if (!/[A-Za-z]/.test(t[p] ?? '')) {
            if (t.startsWith('<!--', i)) {
                // HTML comments still execute JSP inside; just step over the opener.
                return i + 4;
            }
            return i;
        }
        const nameStart = p;
        while (p < to && /[\w:.\-]/.test(t[p])) { p++; }
        const name = t.substring(nameStart, p);
        if (closing) {
            const gt = t.indexOf('>', p);
            return gt < 0 ? to : gt + 1;
        }

        const { attrs, end: attrsEnd } = this.readAttrs(p, to, true);
        const end = attrsEnd;
        const tag: TagInfo = { name, start: i, end, attrs };
        this.doc.tags.push(tag);
        const lname = name.toLowerCase();
        const selfClosing = t[end - 2] === '/';

        if (lname === 'jsp:include' || lname === 'jsp:directive.include') {
            const page = attrs.find(a => a.name === 'page' || a.name === 'file');
            if (page) { this.doc.includes.push({ path: page.value, kind: 'action', attr: page }); }
        } else if (lname === 'jsp:usebean') {
            const idAttr = attrs.find(a => a.name === 'id');
            const classAttr = attrs.find(a => a.name === 'class');
            const typeAttr = attrs.find(a => a.name === 'type');
            const typeName = (typeAttr ?? classAttr)?.value;
            if (idAttr && typeName) {
                this.doc.useBeans.push({ id: idAttr.value, typeName, idAttr, classAttr, typeAttr });
            }
        } else if (!lname.includes(':')) {
            for (const a of attrs) {
                const an = a.name.toLowerCase();
                if (an.startsWith('on') && an.length > 2) {
                    this.doc.eventHandlers.push({ start: a.valueStart, end: a.valueEnd });
                } else if ((an === 'href' || an === 'action') && /^\s*javascript:/i.test(a.value)) {
                    this.doc.eventHandlers.push({ start: a.valueStart, end: a.valueEnd });
                }
            }
        }

        if ((lname === 'script' || lname === 'style') && !selfClosing) {
            const closeRe = new RegExp(`</${lname}\\s*>`, 'ig');
            closeRe.lastIndex = end;
            const m = closeRe.exec(t);
            const bodyEnd = m ? m.index : to;
            const after = m ? m.index + m[0].length : to;
            this.push(lname as RegionKind, i, after, end, bodyEnd);
            if (lname === 'script') {
                const type = (attrs.find(a => a.name.toLowerCase() === 'type')?.value ?? '').trim().toLowerCase();
                const src = attrs.find(a => a.name.toLowerCase() === 'src');
                this.doc.scripts.push({ src, contentStart: end, contentEnd: bodyEnd, isJavaScript: JS_SCRIPT_TYPES.has(type) });
            }
            this.scanContent(end, bodyEnd, false);
            return after;
        }
        return end;
    }

    /**
     * Read attributes from `p` until `>` (when `untilGt`) or `to`.
     * JSP constructs inside attribute values are recorded as regions.
     */
    readAttrs(p: number, to: number, untilGt = false): { attrs: Attr[]; end: number } {
        const t = this.text;
        const attrs: Attr[] = [];
        while (p < to) {
            const c = t[p];
            if (untilGt && c === '>') { return { attrs, end: p + 1 }; }
            if (c === '<' && t[p + 1] === '%') {
                p = this.tryJsp(p, to);
                continue;
            }
            if (!/[\w:@\-.]/.test(c)) { p++; continue; }

            const nameStart = p;
            while (p < to && /[\w:@\-.]/.test(t[p])) { p++; }
            const name = t.substring(nameStart, p);
            let q = p;
            while (q < to && /\s/.test(t[q])) { q++; }
            if (t[q] !== '=') { attrs.push({ name, value: '', valueStart: p, valueEnd: p }); continue; }
            q++;
            while (q < to && /\s/.test(t[q])) { q++; }

            const quote = t[q];
            if (quote === '"' || quote === "'") {
                const valueStart = q + 1;
                let r = valueStart;
                while (r < to && t[r] !== quote) {
                    if (t[r] === '<' && t[r + 1] === '%') { r = this.tryJsp(r, to); continue; }
                    if ((t[r] === '$' || t[r] === '#') && t[r + 1] === '{') { r = this.readEl(r, to); continue; }
                    r++;
                }
                attrs.push({ name, value: t.substring(valueStart, r), valueStart, valueEnd: r });
                p = r + 1;
            } else {
                const valueStart = q;
                let r = q;
                while (r < to && !/[\s>]/.test(t[r])) { r++; }
                attrs.push({ name, value: t.substring(valueStart, r), valueStart, valueEnd: r });
                p = r;
            }
        }
        return { attrs, end: to };
    }

    push(kind: RegionKind, start: number, end: number, contentStart: number, contentEnd: number): void {
        this.doc.regions.push({ kind, start, end, contentStart, contentEnd });
    }
}

// ─── Queries ────────────────────────────────────────────────────────────────

/** Innermost region containing `offset` (content-inclusive at the end boundary). */
export function regionAt(doc: JspDocument, offset: number): Region | undefined {
    let best: Region | undefined;
    for (const r of doc.regions) {
        if (r.start > offset) { break; }
        if (offset >= r.contentStart && offset <= r.contentEnd) {
            if (!best || r.start >= best.start) { best = r; }
        }
    }
    return best;
}

export function isJavaRegion(r: Region | undefined): r is Region & { kind: JavaRegionKind } {
    return !!r && (r.kind === 'declaration' || r.kind === 'expression' || r.kind === 'scriptlet');
}

export function attrAt<T extends { attr?: Attr }>(items: T[], offset: number): T | undefined {
    return items.find(i => i.attr && offset >= i.attr.valueStart && offset <= i.attr.valueEnd);
}

export function inAttr(a: Attr | undefined, offset: number): boolean {
    return !!a && offset >= a.valueStart && offset <= a.valueEnd;
}
