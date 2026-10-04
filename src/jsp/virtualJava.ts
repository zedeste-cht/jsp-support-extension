/**
 * Builds a servlet-like Java compilation unit from a JSP page so the Java
 * fragments can be parsed as one program (scriptlets often open a block in
 * one `<% %>` and close it in another).
 *
 * Every copied fragment is recorded in a segment table so offsets can be
 * mapped between the JSP and the virtual source in both directions.
 */
import { JspDocument, isJavaRegion } from './jspParser';

export interface Segment {
    jspStart: number;
    virtStart: number;
    length: number;
}

export interface VirtualJava {
    text: string;
    segments: Segment[];
    /** Name of the generated page class. */
    className: string;
    toVirtual(jspOffset: number): number | undefined;
    toJsp(virtOffset: number): number | undefined;
}

export const PAGE_CLASS = '__JspPage';

/** Implicit JSP objects; javax types are re-tried as jakarta by the resolver. */
const IMPLICIT_OBJECTS = [
    'javax.servlet.jsp.PageContext pageContext = null;',
    'javax.servlet.http.HttpSession session = null;',
    'javax.servlet.ServletContext application = null;',
    'javax.servlet.ServletConfig config = null;',
    'javax.servlet.jsp.JspWriter out = null;',
    'java.lang.Object page = this;',
    'java.lang.Throwable exception = null;',
];

export function buildVirtualJava(doc: JspDocument): VirtualJava {
    const segments: Segment[] = [];
    let text = '';

    const emit = (s: string) => { text += s; };
    const copy = (start: number, end: number) => {
        if (end > start) {
            segments.push({ jspStart: start, virtStart: text.length, length: end - start });
            text += doc.text.substring(start, end);
        }
    };

    const javaRegions = doc.regions.filter(isJavaRegion);

    emit(`public class ${PAGE_CLASS} extends javax.servlet.http.HttpServlet {\n`);
    for (const r of javaRegions) {
        if (r.kind === 'declaration') {
            copy(r.contentStart, r.contentEnd);
            emit('\n');
        }
    }
    emit('public void _jspService(javax.servlet.http.HttpServletRequest request, javax.servlet.http.HttpServletResponse response) throws java.lang.Throwable {\n');
    emit(IMPLICIT_OBJECTS.join('\n') + '\n');

    // useBean declarations are interleaved in document order with scriptlets
    // so their scope matches the page.
    type Item = { at: number; run: () => void };
    const items: Item[] = [];
    for (const r of javaRegions) {
        if (r.kind === 'scriptlet') {
            items.push({ at: r.start, run: () => { copy(r.contentStart, r.contentEnd); emit('\n'); } });
        } else if (r.kind === 'expression') {
            items.push({ at: r.start, run: () => { emit('out.print('); copy(r.contentStart, r.contentEnd); emit(');\n'); } });
        }
    }
    for (const b of doc.useBeans) {
        const typeAttr = b.typeAttr ?? b.classAttr!;
        items.push({
            at: b.idAttr.valueStart, run: () => {
                copy(typeAttr.valueStart, typeAttr.valueEnd);
                emit(' ');
                copy(b.idAttr.valueStart, b.idAttr.valueEnd);
                emit(' = null;\n');
            }
        });
    }
    items.sort((a, b) => a.at - b.at);
    for (const it of items) { it.run(); }

    emit('}\n}\n');

    return {
        text,
        segments,
        className: PAGE_CLASS,
        toVirtual: (o) => mapOffset(segments, o, 'jspStart', 'virtStart'),
        toJsp: (o) => mapOffset(segments, o, 'virtStart', 'jspStart'),
    };
}

function mapOffset(segments: Segment[], offset: number, from: 'jspStart' | 'virtStart', to: 'jspStart' | 'virtStart'): number | undefined {
    // Segments are sorted by virtStart; jspStart order may differ (declarations
    // are hoisted, useBeans interleaved), so scan linearly. Pages are small.
    for (const s of segments) {
        const base = s[from];
        if (offset >= base && offset <= base + s.length) {
            return s[to] + (offset - base);
        }
    }
    return undefined;
}
