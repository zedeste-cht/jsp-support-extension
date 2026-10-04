/**
 * Go-to-definition for Java code inside a JSP page.
 *
 * The page's Java fragments are parsed as a virtual servlet (see
 * virtualJava.ts). Expressions are typed with a small resolver that handles
 * locals, fields, imports, generics, method chains and inheritance; class
 * sources come from the ClassRepository (jdt.ls, workspace, jars).
 */
import type { Node, Tree } from 'web-tree-sitter';
import { JspDocument } from '../jsp/jspParser';
import { VirtualJava, buildVirtualJava } from '../jsp/virtualJava';
import { parseJava } from './javaParser';
import { MethodInfo, FieldInfo, PRIMITIVES, TypeText, extractCompilationUnit, findLocalType, parseTypeText } from './javaModel';
import { ClassRepository, NameContext, ResolvedType, Target } from './classRepository';

export interface TypeRef {
    fqn: string;
    args: (TypeRef | null)[];
    dims: number;
}

type Bindings = Map<string, TypeRef | null>;

interface MemberHit<T> {
    owner: ResolvedType;
    member: T;
    bindings: Bindings;
}

interface LocalDecl {
    nameNode: Node;
    typeText?: string;
    /** Initializer (for `var`) or iterable (for enhanced-for `var`). */
    valueNode?: Node;
    /** For enhanced for: the declared variable is an element of valueNode. */
    element?: boolean;
}

const JSP_DEFAULT_WILDCARDS = [
    'javax.servlet', 'javax.servlet.http', 'javax.servlet.jsp',
    'jakarta.servlet', 'jakarta.servlet.http', 'jakarta.servlet.jsp',
];

const MAX_HIERARCHY_DEPTH = 12;

/** Parsed JSP page ready for Java resolution. */
export class JspJavaPage {
    private constructor(
        readonly jsp: JspDocument,
        readonly virt: VirtualJava,
        readonly tree: Tree,
        readonly page: ResolvedType,
    ) { }

    static async create(jsp: JspDocument, uri: string, fsPath: string | undefined): Promise<JspJavaPage> {
        const virt = buildVirtualJava(jsp);
        const tree = await parseJava(virt.text);
        const cu = extractCompilationUnit(tree.rootNode);
        const type = findLocalType(cu, virt.className)!;

        const singleImports = new Map<string, string>();
        const wildcards = [...JSP_DEFAULT_WILDCARDS];
        for (const imp of jsp.imports) {
            if (imp.fqn.endsWith('.*')) { wildcards.push(imp.fqn.slice(0, -2)); }
            else { singleImports.set(imp.fqn.substring(imp.fqn.lastIndexOf('.') + 1), imp.fqn); }
        }
        const page: ResolvedType = {
            fqn: virt.className,
            source: { uri, text: virt.text },
            cu,
            type,
            nameContext: { pkg: '', singleImports, wildcards, enclosing: [], fromFile: fsPath },
            mapTarget: (start, end) => {
                const s = virt.toJsp(start);
                const e = virt.toJsp(end);
                return s === undefined ? undefined : { uri, text: jsp.text, start: s, end: e ?? s };
            },
        };
        return new JspJavaPage(jsp, virt, tree, page);
    }

    dispose(): void {
        this.tree.delete();
    }
}

export class JavaResolver {
    constructor(private readonly repo: ClassRepository) { }

    // ─── Entry points ───────────────────────────────────────────────────────

    /** Definition for the Java token at `jspOffset`. */
    async definitionAt(page: JspJavaPage, jspOffset: number): Promise<Target[]> {
        const v = page.virt.toVirtual(jspOffset);
        if (v === undefined) { return []; }
        const node = identifierAt(page.tree.rootNode, v);
        if (!node) { return []; }
        const s = new Scope(this, page);
        return s.definitionOf(node);
    }

    /** Resolve a (possibly simple) type name in the page context and return its declaration. */
    async typeDefinition(page: JspJavaPage, typeName: string): Promise<Target[]> {
        const fqn = await this.resolveTypeName(typeName, this.repo.contextFor(page.page));
        if (!fqn) { return []; }
        const rt = await this.repo.findClass(fqn, page.page.nameContext?.fromFile);
        return rt ? [typeTarget(rt)] : [];
    }

    /** Definition of a fully-qualified class name (imports, useBean class). */
    async classDefinition(fqn: string, fromFile?: string): Promise<Target[]> {
        const rt = await this.repo.findClass(fqn, fromFile);
        return rt ? [typeTarget(rt)] : [];
    }

    // ─── Type names ─────────────────────────────────────────────────────────

    async resolveTypeName(name: string, ctx: NameContext): Promise<string | null> {
        name = name.replace(/\s+/g, '');
        if (PRIMITIVES.has(name)) { return name; }
        const parts = name.split('.');
        const first = parts[0];
        const rest = parts.slice(1);
        const join = (base: string) => [base, ...rest].join('.');
        const exists = (fqn: string) => this.repo.exists(fqn, ctx.fromFile);

        // 1. Enclosing types and their member types.
        for (const enc of ctx.enclosing) {
            if (enc.type.name === first) { return join(enc.fqn); }
            const nested = enc.type.nested.find(t => t.name === first);
            if (nested) { return join(`${enc.fqn}.${nested.name}`); }
        }
        // 2. Single-type imports.
        const imported = ctx.singleImports.get(first);
        if (imported) { return join(imported); }
        // Everything below probes the locators. Lowercase names are packages or
        // variables far more often than classes, so only probe qualified ones.
        const upper = (s: string) => /^[A-Z_$]/.test(s);
        if (!parts.some(upper)) { return null; }
        // 3. Same package.
        const samePkg = ctx.pkg ? `${ctx.pkg}.${first}` : first;
        if (upper(first) && await exists(samePkg)) { return join(samePkg); }
        // 4. java.lang and on-demand imports (same precedence in the JLS; java.lang
        //    first because it is the most common hit and saves locator probes).
        if (upper(first)) {
            if (await exists(`java.lang.${first}`)) { return join(`java.lang.${first}`); }
            for (const w of ctx.wildcards) {
                if (await exists(`${w}.${first}`)) { return join(`${w}.${first}`); }
            }
        }
        // 5. Fully qualified.
        if (parts.length > 1 && await exists(name)) { return name; }
        return null;
    }

    async resolveTypeText(tt: TypeText | null, ctx: NameContext, bindings: Bindings): Promise<TypeRef | null> {
        if (!tt) { return null; }
        if (PRIMITIVES.has(tt.name)) { return { fqn: tt.name, args: [], dims: tt.dims }; }
        if (bindings.has(tt.name)) {
            const b = bindings.get(tt.name);
            return b ? { ...b, dims: b.dims + tt.dims } : (tt.dims ? { fqn: 'java.lang.Object', args: [], dims: tt.dims } : null);
        }
        const fqn = await this.resolveTypeName(tt.name, ctx);
        if (!fqn) { return null; }
        const args = await Promise.all(tt.args.map(a => this.resolveTypeText(a, ctx, bindings)));
        return { fqn, args, dims: tt.dims };
    }

    // ─── Members ────────────────────────────────────────────────────────────

    findMethod(recv: TypeRef, name: string, argCount: number, fromFile?: string): Promise<MemberHit<MethodInfo> | null> {
        return this.searchHierarchy(recv, fromFile, (rt) => {
            const all = rt.type.methods.filter(m => m.name === name && !m.isConstructor);
            const exact = all.find(m => arityMatches(m, argCount));
            return { exact, any: all[0] };
        });
    }

    findField(recv: TypeRef, name: string, fromFile?: string): Promise<MemberHit<FieldInfo> | null> {
        return this.searchHierarchy(recv, fromFile, (rt) => {
            const f = rt.type.fields.find(x => x.name === name);
            return { exact: f, any: f };
        });
    }

    /**
     * Walk the type hierarchy (class, superclasses, interfaces, Object).
     * Prefers an exact match anywhere over a name-only match.
     */
    private async searchHierarchy<T>(
        recv: TypeRef,
        fromFile: string | undefined,
        pick: (rt: ResolvedType) => { exact?: T; any?: T },
    ): Promise<MemberHit<T> | null> {
        const visited = new Set<string>();
        let fallback: MemberHit<T> | null = null;
        const queue: { ref: TypeRef; depth: number }[] = [{ ref: recv, depth: 0 }];
        let objectQueued = false;

        while (queue.length) {
            const { ref, depth } = queue.shift()!;
            if (visited.has(ref.fqn) || depth > MAX_HIERARCHY_DEPTH) { continue; }
            visited.add(ref.fqn);
            const rt = ref.fqn === this.currentPage?.fqn ? this.currentPage : await this.repo.findClass(ref.fqn, fromFile);
            if (!rt) { continue; }
            const bindings = bindTypeParams(rt.type.typeParams, ref.args);
            const { exact, any } = pick(rt);
            if (exact) { return { owner: rt, member: exact, bindings }; }
            if (any && !fallback) { fallback = { owner: rt, member: any, bindings }; }

            const ctx = this.repo.contextFor(rt);
            ctx.fromFile = fromFile;
            const supers = [rt.type.superclass, ...rt.type.interfaces].filter((s): s is string => !!s);
            for (const s of supers) {
                const sref = await this.resolveTypeText(parseTypeText(s), ctx, bindings);
                if (sref) { queue.push({ ref: sref, depth: depth + 1 }); }
            }
            if (!objectQueued && ref.fqn !== 'java.lang.Object') {
                // Object is visited last (after the interface chain).
                objectQueued = true;
                queue.push({ ref: { fqn: 'java.lang.Object', args: [], dims: 0 }, depth: MAX_HIERARCHY_DEPTH });
            }
        }
        return fallback;
    }

    /** Set while resolving inside a page so the virtual page class is found. */
    currentPage?: ResolvedType;

    async memberType(hit: MemberHit<MethodInfo | FieldInfo>, typeText: string | null, fromFile?: string): Promise<TypeRef | null> {
        if (!typeText) { return null; }
        const bindings = new Map(hit.bindings);
        if ('typeParams' in hit.member) {
            for (const tp of hit.member.typeParams) { bindings.set(tp, null); }
        }
        const ctx = this.repo.contextFor(hit.owner);
        ctx.fromFile = fromFile ?? ctx.fromFile;
        return this.resolveTypeText(parseTypeText(typeText), ctx, bindings);
    }

    findClass(fqn: string, fromFile?: string) {
        return this.repo.findClass(fqn, fromFile);
    }

    contextFor(rt: ResolvedType) {
        return this.repo.contextFor(rt);
    }
}

/** Expression typing within one JSP page. */
class Scope {
    private readonly fromFile?: string;
    private readonly pageCtx: NameContext;
    private readonly pageRef: TypeRef;

    constructor(private readonly r: JavaResolver, private readonly page: JspJavaPage) {
        this.fromFile = page.page.nameContext?.fromFile;
        this.pageCtx = r.contextFor(page.page);
        this.pageRef = { fqn: page.page.fqn, args: [], dims: 0 };
        r.currentPage = page.page;
    }

    async definitionOf(node: Node): Promise<Target[]> {
        const p = node.parent;
        if (!p) { return []; }

        // Method name in a call: recv.name(...) or name(...)
        if (p.type === 'method_invocation' && sameNode(p.childForFieldName('name'), node)) {
            const obj = p.childForFieldName('object');
            const recv = obj ? await this.typeOf(obj) : this.pageRef;
            if (!recv) { return []; }
            const argc = p.childForFieldName('arguments')?.namedChildCount ?? 0;
            const hit = await this.r.findMethod(recv, node.text, argc, this.fromFile);
            if (hit) { return targets(memberTarget(hit.owner, hit.member)); }
            // Unknown method: at least go to the receiver's class.
            const rt = await this.r.findClass(recv.fqn, this.fromFile);
            return rt ? [typeTarget(rt)] : [];
        }

        // Field access: recv.name
        if (p.type === 'field_access' && sameNode(p.childForFieldName('field'), node)) {
            const obj = p.childForFieldName('object')!;
            const recv = await this.typeOf(obj);
            if (recv) {
                const hit = await this.r.findField(recv, node.text, this.fromFile);
                if (hit) { return targets(memberTarget(hit.owner, hit.member)); }
                const nested = await this.r.findClass(`${recv.fqn}.${node.text}`, this.fromFile);
                if (nested) { return [typeTarget(nested)]; }
            }
            // Package-qualified class name: com.foo.Bar
            const rt = await this.classFromText(p.text);
            return rt ? [typeTarget(rt)] : [];
        }

        // Type names (declarations, casts, generics, new Foo()).
        if (node.type === 'type_identifier') {
            let typeNode: Node = node;
            // For scoped types (Map.Entry) use the prefix up to the clicked part.
            while (typeNode.parent?.type === 'scoped_type_identifier' && sameNode(typeNode.parent.lastNamedChild, typeNode)) {
                typeNode = typeNode.parent;
            }
            const text = typeNode.text;
            const fqn = await this.r.resolveTypeName(text, this.pageCtx);
            const rt = fqn ? await this.r.findClass(fqn, this.fromFile) : null;
            return rt ? [typeTarget(rt)] : [];
        }

        if (node.type === 'identifier') {
            // Local variable / parameter / page field.
            const decl = this.findLocalDecl(node);
            if (decl && !sameNode(decl.nameNode, node)) {
                return targets(this.page.page.mapTarget!(decl.nameNode.startIndex, decl.nameNode.endIndex));
            }
            if (decl) {
                // On the declaration itself: go to its type.
                const t = await this.declType(decl);
                const rt = t ? await this.r.findClass(t.fqn, this.fromFile) : null;
                return rt ? [typeTarget(rt)] : [];
            }
            const field = await this.r.findField(this.pageRef, node.text, this.fromFile);
            if (field) { return targets(memberTarget(field.owner, field.member)); }
            // Class used statically: Foo.bar(), Foo.CONST
            const fqn = await this.r.resolveTypeName(node.text, this.pageCtx);
            const rt = fqn ? await this.r.findClass(fqn, this.fromFile) : null;
            return rt ? [typeTarget(rt)] : [];
        }
        return [];
    }

    // ─── Expression types ───────────────────────────────────────────────────

    async typeOf(node: Node): Promise<TypeRef | null> {
        switch (node.type) {
            case 'identifier': {
                const decl = this.findLocalDecl(node);
                if (decl) { return this.declType(decl); }
                const field = await this.r.findField(this.pageRef, node.text, this.fromFile);
                if (field) { return this.r.memberType(field, field.member.type, this.fromFile); }
                const fqn = await this.r.resolveTypeName(node.text, this.pageCtx);
                return fqn ? { fqn, args: [], dims: 0 } : null;
            }
            case 'this':
                return this.pageRef;
            case 'field_access': {
                const obj = node.childForFieldName('object')!;
                const name = node.childForFieldName('field')!.text;
                const recv = await this.typeOf(obj);
                if (recv) {
                    if (recv.dims > 0 && name === 'length') { return { fqn: 'int', args: [], dims: 0 }; }
                    const hit = await this.r.findField(recv, name, this.fromFile);
                    if (hit) { return this.r.memberType(hit, hit.member.type, this.fromFile); }
                    if (await this.r.findClass(`${recv.fqn}.${name}`, this.fromFile)) {
                        return { fqn: `${recv.fqn}.${name}`, args: [], dims: 0 };
                    }
                }
                const rt = await this.classFromText(node.text);
                return rt ? { fqn: rt.fqn, args: [], dims: 0 } : null;
            }
            case 'method_invocation': {
                const obj = node.childForFieldName('object');
                const name = node.childForFieldName('name')!.text;
                const argc = node.childForFieldName('arguments')?.namedChildCount ?? 0;
                const recv = obj ? await this.typeOf(obj) : this.pageRef;
                if (!recv) { return null; }
                if (name === 'getClass' && argc === 0) { return { fqn: 'java.lang.Class', args: [recv], dims: 0 }; }
                const hit = await this.r.findMethod(recv, name, argc, this.fromFile);
                return hit ? this.r.memberType(hit, hit.member.returnType, this.fromFile) : null;
            }
            case 'object_creation_expression':
            case 'array_creation_expression':
            case 'cast_expression': {
                const t = node.childForFieldName('type');
                if (!t) { return null; }
                const ref = await this.r.resolveTypeText(parseTypeText(t.text), this.pageCtx, new Map());
                if (ref && node.type === 'array_creation_expression') {
                    const dims = (node.text.match(/\[/g) ?? []).length;
                    return { ...ref, dims };
                }
                return ref;
            }
            case 'parenthesized_expression': {
                const inner = node.namedChildren[0];
                return inner ? this.typeOf(inner) : null;
            }
            case 'string_literal':
            case 'text_block':
                return { fqn: 'java.lang.String', args: [], dims: 0 };
            case 'array_access': {
                const arr = node.childForFieldName('array');
                const t = arr ? await this.typeOf(arr) : null;
                return t && t.dims > 0 ? { ...t, dims: t.dims - 1 } : null;
            }
            case 'ternary_expression': {
                const c = node.childForFieldName('consequence');
                return c ? this.typeOf(c) : null;
            }
            case 'binary_expression': {
                const op = node.childForFieldName('operator')?.text;
                if (op === '+') {
                    const l = node.childForFieldName('left');
                    const rr = node.childForFieldName('right');
                    const lt = l ? await this.typeOf(l) : null;
                    if (lt?.fqn === 'java.lang.String') { return lt; }
                    const rtp = rr ? await this.typeOf(rr) : null;
                    if (rtp?.fqn === 'java.lang.String') { return rtp; }
                }
                return null;
            }
            default:
                return null;
        }
    }

    private async declType(decl: LocalDecl): Promise<TypeRef | null> {
        if (decl.typeText && decl.typeText !== 'var') {
            return this.r.resolveTypeText(parseTypeText(decl.typeText), this.pageCtx, new Map());
        }
        if (!decl.valueNode) { return null; }
        const vt = await this.typeOf(decl.valueNode);
        if (!vt || !decl.element) { return vt; }
        if (vt.dims > 0) { return { ...vt, dims: vt.dims - 1 }; }
        // Iterable<T>: take the iterator() element via the hierarchy.
        const hit = await this.r.findMethod(vt, 'iterator', 0, this.fromFile);
        const it = hit ? await this.r.memberType(hit, hit.member.returnType, this.fromFile) : null;
        return it?.args[0] ?? null;
    }

    private async classFromText(text: string): Promise<ResolvedType | null> {
        const clean = text.replace(/\s+/g, '');
        const fqn = await this.r.resolveTypeName(clean, this.pageCtx);
        return fqn ? this.r.findClass(fqn, this.fromFile) : null;
    }

    // ─── Local declarations ─────────────────────────────────────────────────

    findLocalDecl(ident: Node): LocalDecl | undefined {
        const name = ident.text;
        let cur: Node = ident;
        while (cur.parent) {
            const p: Node = cur.parent;
            switch (p.type) {
                case 'block':
                case 'constructor_body':
                case 'switch_block_statement_group':
                case 'switch_block': {
                    let found: LocalDecl | undefined;
                    for (const child of p.namedChildren) {
                        if (!child || child.startIndex >= cur.startIndex) { break; }
                        if (child.type === 'local_variable_declaration') {
                            found = declFrom(child, name) ?? found;
                        }
                    }
                    if (found) { return found; }
                    break;
                }
                case 'enhanced_for_statement': {
                    const n = p.childForFieldName('name');
                    if (n?.text === name) {
                        return { nameNode: n, typeText: p.childForFieldName('type')?.text, valueNode: p.childForFieldName('value') ?? undefined, element: true };
                    }
                    break;
                }
                case 'for_statement': {
                    for (const init of p.childrenForFieldName('init')) {
                        if (init?.type === 'local_variable_declaration') {
                            const d = declFrom(init, name);
                            if (d) { return d; }
                        }
                    }
                    break;
                }
                case 'method_declaration':
                case 'constructor_declaration':
                case 'lambda_expression': {
                    const params = p.childForFieldName('parameters');
                    for (const prm of params?.namedChildren ?? []) {
                        if (!prm) { continue; }
                        if (prm.type === 'identifier' && prm.text === name) { return { nameNode: prm }; }
                        const n = prm.childForFieldName('name') ?? prm.namedChildren.find(c => c?.type === 'variable_declarator')?.childForFieldName('name');
                        if (n?.text === name) {
                            const t = prm.childForFieldName('type') ?? prm.namedChildren.find(c => c && c.type !== 'modifiers' && c.type !== 'variable_declarator' && c.type !== 'identifier');
                            return { nameNode: n, typeText: prm.type === 'spread_parameter' ? `${t?.text}[]` : t?.text };
                        }
                    }
                    if (p.type === 'lambda_expression' && params?.type === 'identifier' && params.text === name) {
                        return { nameNode: params };
                    }
                    break;
                }
                case 'catch_clause': {
                    const prm = p.namedChildren.find(c => c?.type === 'catch_formal_parameter');
                    const n = prm?.childForFieldName('name');
                    if (n?.text === name) {
                        const ct = prm!.namedChildren.find(c => c?.type === 'catch_type');
                        return { nameNode: n, typeText: ct?.namedChildren[0]?.text };
                    }
                    break;
                }
                case 'try_with_resources_statement': {
                    const res = p.childForFieldName('resources');
                    for (const r of res?.namedChildren ?? []) {
                        const n = r?.childForFieldName('name');
                        if (n?.text === name) {
                            return { nameNode: n, typeText: r!.childForFieldName('type')?.text, valueNode: r!.childForFieldName('value') ?? undefined };
                        }
                    }
                    break;
                }
                case 'class_body': {
                    for (const member of p.namedChildren) {
                        if (member?.type === 'field_declaration') {
                            const d = declFrom(member, name);
                            if (d) { return d; }
                        }
                    }
                    break;
                }
            }
            cur = p;
        }
        return undefined;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function declFrom(declNode: Node, name: string): LocalDecl | undefined {
    const typeText = declNode.childForFieldName('type')?.text;
    for (const d of declNode.childrenForFieldName('declarator')) {
        const n = d?.childForFieldName('name');
        if (n?.text === name) {
            const dims = d!.childForFieldName('dimensions')?.text ?? '';
            return { nameNode: n, typeText: typeText ? typeText + dims : undefined, valueNode: d!.childForFieldName('value') ?? undefined };
        }
    }
    return undefined;
}

function identifierAt(root: Node, offset: number): Node | null {
    const isIdent = (n: Node | null) => !!n && (n.type === 'identifier' || n.type === 'type_identifier');
    let n = root.descendantForIndex(offset);
    if (isIdent(n)) { return n; }
    if (offset > 0) {
        n = root.descendantForIndex(offset - 1);
        if (isIdent(n)) { return n; }
    }
    return null;
}

function sameNode(a: Node | null | undefined, b: Node): boolean {
    return !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

function arityMatches(m: MethodInfo, argc: number): boolean {
    if (m.varargs) { return argc >= m.params.length - 1; }
    return m.params.length === argc;
}

function bindTypeParams(params: string[], args: (TypeRef | null)[]): Bindings {
    const b: Bindings = new Map();
    params.forEach((p, i) => b.set(p, args[i] ?? null));
    return b;
}

export function typeTarget(rt: ResolvedType): Target {
    return rangeTarget(rt, rt.type.nameStart, rt.type.nameEnd)!;
}

function memberTarget(rt: ResolvedType, m: MethodInfo | FieldInfo): Target | undefined {
    return rangeTarget(rt, m.nameStart, m.nameEnd);
}

function rangeTarget(rt: ResolvedType, start: number, end: number): Target | undefined {
    if (rt.mapTarget) { return rt.mapTarget(start, end); }
    return { uri: rt.source.uri, text: rt.source.text, start, end };
}

function targets(t: Target | undefined): Target[] {
    return t ? [t] : [];
}
