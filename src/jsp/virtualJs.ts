/**
 * Projects the JavaScript parts of a JSP page into a same-length document:
 * everything that isn't JS becomes whitespace (newlines kept), so an offset in
 * the projection is the same offset in the JSP.
 *
 * JSP constructs embedded in JS (`<%= x %>`, `${x}`) are replaced with a
 * neutral literal so the surrounding JS still parses.
 */
import { JspDocument } from './jspParser';

export function buildVirtualJs(doc: JspDocument): string {
    const src = doc.text;
    const out = new Array<string>(src.length);
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        out[i] = c === '\n' || c === '\r' ? c : ' ';
    }

    const reveal = (start: number, end: number) => {
        for (let i = start; i < end; i++) { out[i] = src[i]; }
    };

    for (const s of doc.scripts) {
        if (s.isJavaScript && !s.src) {
            reveal(s.contentStart, s.contentEnd);
            // Separate consecutive script blocks.
            if (s.contentEnd < src.length && out[s.contentEnd] === ' ') { out[s.contentEnd] = ';'; }
        }
    }
    for (const h of doc.eventHandlers) {
        reveal(h.start, h.end);
        // `onclick="a()"` → ` a() ;` – terminate the handler statement.
        if (h.end < src.length) { out[h.end] = ';'; }
        if (h.start > 0 && out[h.start - 1] !== '\n') { out[h.start - 1] = ';'; }
    }

    // Neutralise JSP/EL inside revealed JS.
    for (const r of doc.regions) {
        if (r.kind === 'script' || r.kind === 'style') { continue; }
        if (out[r.start] === ' ' || out[r.start] === '\n') { continue; } // not inside revealed JS
        let first = true;
        for (let i = r.start; i < r.end; i++) {
            const c = src[i];
            if (c === '\n' || c === '\r') { out[i] = c; continue; }
            out[i] = first ? '0' : ' ';
            first = false;
        }
    }
    return out.join('');
}
