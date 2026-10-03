/**
 * JavaScript go-to-definition backed by the TypeScript language service.
 * A JSP's JS projection (same offsets as the JSP), the projections of the
 * pages it includes and the external scripts it loads are put in one
 * script-mode program, so globals defined in any of them resolve.
 */
import type * as TS from 'typescript';

export interface JsInput {
    /** Real file path (JSP or .js) – reported back in results. */
    path: string;
    /** Text given to TypeScript (the projection for JSP files). */
    text: string;
}

export interface JsTarget {
    path: string;
    start: number;
    end: number;
}

const JSP_SUFFIX = '.__jsp__.js';
const LIB_NAME = '/__jsp_support_lib__.d.ts';
const LIB_TEXT = `
interface Array<T> { length: number; [n: number]: T; }
interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {}
interface IArguments {} interface Number {} interface Object {} interface RegExp {} interface String {}
`;

export class JsDefinitionService {
    private ts?: typeof TS;
    private ls?: TS.LanguageService;
    private readonly files = new Map<string, { text: string; version: number }>();
    private current: string[] = [];

    constructor(private readonly loadTs: () => typeof TS) { }

    definition(main: JsInput, others: JsInput[], offset: number): JsTarget[] {
        const ts = (this.ts ??= this.loadTs());
        const inputs = [main, ...others];
        const names = inputs.map(i => this.fileName(i.path));
        inputs.forEach((i, n) => this.setFile(names[n], i.text));
        this.current = [LIB_NAME, ...names];
        this.setFile(LIB_NAME, LIB_TEXT);

        const ls = (this.ls ??= ts.createLanguageService(this.host(ts), ts.createDocumentRegistry()));
        const defs = ls.getDefinitionAtPosition(names[0], offset) ?? [];
        return defs
            .filter(d => d.fileName !== LIB_NAME)
            .map(d => ({ path: this.realPath(d.fileName), start: d.textSpan.start, end: d.textSpan.start + d.textSpan.length }));
    }

    private fileName(p: string): string {
        const unix = p.replace(/\\/g, '/');
        return /\.jsp[fx]?$/i.test(unix) ? unix + JSP_SUFFIX : unix;
    }

    private realPath(name: string): string {
        const p = name.endsWith(JSP_SUFFIX) ? name.slice(0, -JSP_SUFFIX.length) : name;
        return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
    }

    private setFile(name: string, text: string): void {
        const cur = this.files.get(name);
        if (!cur) { this.files.set(name, { text, version: 1 }); }
        else if (cur.text !== text) { this.files.set(name, { text, version: cur.version + 1 }); }
    }

    private host(ts: typeof TS): TS.LanguageServiceHost {
        const options: TS.CompilerOptions = {
            allowJs: true,
            checkJs: false,
            noLib: true,
            noResolve: true,
            types: [],
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.None,
            allowNonTsExtensions: true,
        };
        return {
            getCompilationSettings: () => options,
            getScriptFileNames: () => this.current,
            getScriptVersion: (f) => String(this.files.get(f)?.version ?? 0),
            getScriptSnapshot: (f) => {
                const file = this.files.get(f);
                return file ? ts.ScriptSnapshot.fromString(file.text) : undefined;
            },
            getScriptKind: (f) => f.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
            getCurrentDirectory: () => '/',
            getDefaultLibFileName: () => LIB_NAME,
            fileExists: (f) => this.files.has(f),
            readFile: (f) => this.files.get(f)?.text,
        };
    }
}

// ─── Heuristic fallback index ───────────────────────────────────────────────

const DEF_PATTERNS = [
    /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/gd,
    /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/gd,
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\b/gd,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/gd,
];

/** Extract `name -> offsets` of function definitions from JS-ish text. */
export function scanFunctionDefs(text: string): Map<string, number[]> {
    const defs = new Map<string, number[]>();
    for (const re of DEF_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const name = m[1];
            const at = m.indices![1][0];
            const list = defs.get(name) ?? [];
            if (!list.includes(at)) { list.push(at); }
            defs.set(name, list);
        }
    }
    return defs;
}
