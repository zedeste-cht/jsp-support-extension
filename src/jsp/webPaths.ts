import * as fs from 'fs';
import * as path from 'path';

/**
 * Turn a web path as written in a JSP (include file, script src) into
 * candidate files on disk.
 *
 * Handles `${ctx}/js/a.js`, `<%=request.getContextPath()%>/a.js`,
 * `<c:url value='/a.js'/>`, query strings, and context-path prefixes.
 */
export function resolveWebPath(raw: string, fromFile: string, webappRoots: string[]): string[] {
    let p = raw.trim();
    const cUrl = /<c:url\s[^>]*value\s*=\s*["']([^"']+)["'][^>]*>/i.exec(p);
    if (cUrl) { p = cUrl[1]; }
    p = p.replace(/<%=[\s\S]*?%>/g, '').replace(/[$#]\{[^}]*\}/g, '');
    p = p.replace(/[?#].*$/, '').trim();
    if (!p || /^[a-z][\w+.-]*:/i.test(p) || p.startsWith('//')) { return []; }

    const candidates: string[] = [];
    if (p.startsWith('/')) {
        const segs = p.split('/').filter(Boolean);
        for (const root of webappRoots) {
            candidates.push(path.join(root, ...segs));
        }
        // First segment may be the application context path (/myapp/js/a.js).
        if (segs.length > 1) {
            for (const root of webappRoots) { candidates.push(path.join(root, ...segs.slice(1))); }
        }
    } else {
        candidates.push(path.resolve(path.dirname(fromFile), p));
        for (const root of webappRoots) { candidates.push(path.join(root, p)); }
    }
    return [...new Set(candidates)].filter(c => {
        try { return fs.statSync(c).isFile(); } catch { return false; }
    });
}
