/**
 * Finds Java types by fully-qualified name through a chain of locators
 * (jdt.ls, workspace/jar index, ...) and caches their parsed models.
 */
import { CompilationUnit, TypeInfo, findLocalType, parseCompilationUnit } from './javaModel';

export interface ClassSource {
    /** URI string usable in a vscode Location (file://, jdt://, jsp-src:). */
    uri: string;
    text: string;
}

export interface ClassLocator {
    readonly name: string;
    /** Locate the source of a *top-level* type. `fromFile` scopes the lookup to a module. */
    locate(fqn: string, fromFile?: string): Promise<ClassSource | null>;
}

/** Name-resolution context for type names appearing in some source. */
export interface NameContext {
    pkg: string;
    singleImports: Map<string, string>;
    /** Packages (or types) imported on demand. */
    wildcards: string[];
    /** Enclosing types, innermost first. */
    enclosing: ResolvedType[];
    fromFile?: string;
}

export interface ResolvedType {
    fqn: string;
    source: ClassSource;
    cu: CompilationUnit;
    type: TypeInfo;
    /** Overrides the context derived from `cu` (used for the JSP page class). */
    nameContext?: NameContext;
    /** Maps an offset in `source.text` to the location shown to the user. */
    mapTarget?: (start: number, end: number) => Target | undefined;
}

export interface Target {
    uri: string;
    /** Text the offsets refer to (used to compute line/column). */
    text: string;
    start: number;
    end: number;
}

const NEGATIVE_TTL_MS = 15_000;

export class ClassRepository {
    private readonly located = new Map<string, { at: number; value: Promise<ClassSource | null> }>();
    private readonly parsed = new Map<string, { text: string; cu: Promise<CompilationUnit> }>();

    constructor(
        private readonly locators: ClassLocator[],
        /** Returns a cache key for the module scope of a file. */
        private readonly scopeOf: (fromFile?: string) => string = () => '',
    ) { }

    clear(): void {
        this.located.clear();
        this.parsed.clear();
    }

    async findClass(fqn: string, fromFile?: string): Promise<ResolvedType | null> {
        const found = await this.findClassExact(fqn, fromFile);
        if (found) { return found; }
        if (fqn.startsWith('javax.')) {
            return this.findClassExact('jakarta.' + fqn.substring(6), fromFile);
        }
        return null;
    }

    private async findClassExact(fqn: string, fromFile?: string): Promise<ResolvedType | null> {
        const segs = fqn.split('.');
        let firstUpper = segs.findIndex(s => /^[A-Z_$]/.test(s));
        if (firstUpper < 0) { firstUpper = segs.length - 1; }
        for (let i = firstUpper; i < segs.length; i++) {
            const top = segs.slice(0, i + 1).join('.');
            const src = await this.locateTop(top, fromFile);
            if (!src) { continue; }
            const cu = await this.parse(src);
            const localName = segs.slice(i).join('.');
            const type = findLocalType(cu, localName);
            if (type) { return { fqn, source: src, cu, type }; }
        }
        return null;
    }

    /** Resolve the chain of enclosing types for a nested type (innermost first, including itself). */
    enclosingChain(rt: ResolvedType): ResolvedType[] {
        const chain: ResolvedType[] = [];
        const localParts = rt.type.localName.split('.');
        const pkgPrefix = rt.cu.pkg ? rt.cu.pkg + '.' : '';
        for (let n = localParts.length; n >= 1; n--) {
            const local = localParts.slice(0, n).join('.');
            const type = n === localParts.length ? rt.type : findLocalType(rt.cu, local);
            if (type) {
                chain.push({ ...rt, fqn: rt.nameContext ? rt.fqn : pkgPrefix + local, type });
            }
        }
        return chain;
    }

    contextFor(rt: ResolvedType): NameContext {
        if (rt.nameContext) {
            return { ...rt.nameContext, enclosing: this.enclosingChain(rt) };
        }
        const singleImports = new Map<string, string>();
        const wildcards: string[] = [];
        for (const imp of rt.cu.imports) {
            if (imp.isStatic) { continue; }
            if (imp.wildcard) { wildcards.push(imp.name); }
            else { singleImports.set(imp.name.substring(imp.name.lastIndexOf('.') + 1), imp.name); }
        }
        return { pkg: rt.cu.pkg, singleImports, wildcards, enclosing: this.enclosingChain(rt), fromFile: undefined };
    }

    async exists(fqn: string, fromFile?: string): Promise<boolean> {
        return (await this.findClass(fqn, fromFile)) !== null;
    }

    private locateTop(fqn: string, fromFile?: string): Promise<ClassSource | null> {
        const key = `${fqn}|${this.scopeOf(fromFile)}`;
        const hit = this.located.get(key);
        if (hit) {
            return hit.value.then(v => {
                if (v === null && Date.now() - hit.at > NEGATIVE_TTL_MS) {
                    this.located.delete(key);
                    return this.locateTop(fqn, fromFile);
                }
                return v;
            });
        }
        const value = (async () => {
            for (const loc of this.locators) {
                try {
                    const src = await loc.locate(fqn, fromFile);
                    if (src) { return src; }
                } catch (e) {
                    console.error(`[jsp-support] locator ${loc.name} failed for ${fqn}:`, e);
                }
            }
            return null;
        })();
        this.located.set(key, { at: Date.now(), value });
        return value;
    }

    parse(src: ClassSource): Promise<CompilationUnit> {
        const hit = this.parsed.get(src.uri);
        if (hit && hit.text === src.text) { return hit.cu; }
        const cu = parseCompilationUnit(src.text);
        this.parsed.set(src.uri, { text: src.text, cu });
        return cu;
    }
}
