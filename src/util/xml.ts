/** Minimal XML reader – enough for pom.xml / settings.xml. */

export interface XmlElement {
    name: string;
    children: XmlElement[];
    text: string;
}

export function parseXml(src: string): XmlElement {
    const root: XmlElement = { name: '#root', children: [], text: '' };
    const stack: XmlElement[] = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.\-]+)\s*>|<([\w:.\-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) {
            top.text += m[1];
        } else if (m[2] !== undefined) {
            // Close tag: pop to the matching element (tolerates malformed input).
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name === m[2]) { stack.length = i; break; }
            }
        } else if (m[3] !== undefined) {
            const el: XmlElement = { name: localName(m[3]), children: [], text: '' };
            top.children.push(el);
            if (!m[5]) { stack.push(el); }
        } else if (m[6] !== undefined) {
            top.text += decodeEntities(m[6]);
        }
    }
    return root;
}

function localName(name: string): string {
    const i = name.indexOf(':');
    return i >= 0 ? name.substring(i + 1) : name;
}

function decodeEntities(s: string): string {
    return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e]);
}

export function child(el: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
    let cur = el;
    for (const p of path) {
        cur = cur?.children.find(c => c.name === p);
        if (!cur) { return undefined; }
    }
    return cur;
}

export function children(el: XmlElement | undefined, name: string): XmlElement[] {
    return el ? el.children.filter(c => c.name === name) : [];
}

export function textOf(el: XmlElement | undefined, ...path: string[]): string | undefined {
    const c = child(el, ...path);
    const t = c?.text.trim();
    return t ? t : undefined;
}
