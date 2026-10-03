/**
 * Extracts a lightweight declaration model from Java source:
 * package, imports, types (with generics, supertypes, members, nested types).
 * Positions are UTF-16 offsets into the source text.
 */
import type { Node } from 'web-tree-sitter';
import { parseJava } from './javaParser';

export interface ImportDecl {
    name: string;
    isStatic: boolean;
    wildcard: boolean;
}

export interface MethodInfo {
    name: string;
    params: string[];
    varargs: boolean;
    /** Raw return type text; null for constructors. */
    returnType: string | null;
    typeParams: string[];
    nameStart: number;
    nameEnd: number;
    isConstructor: boolean;
}

export interface FieldInfo {
    name: string;
    type: string;
    nameStart: number;
    nameEnd: number;
}

export type TypeKind = 'class' | 'interface' | 'enum' | 'record' | 'annotation';

export interface TypeInfo {
    name: string;
    kind: TypeKind;
    /** Dotted name of this type within its compilation unit, e.g. `Map.Entry`. */
    localName: string;
    typeParams: string[];
    superclass?: string;
    interfaces: string[];
    methods: MethodInfo[];
    fields: FieldInfo[];
    nested: TypeInfo[];
    nameStart: number;
    nameEnd: number;
}

export interface CompilationUnit {
    pkg: string;
    imports: ImportDecl[];
    types: TypeInfo[];
}

const TYPE_DECLS: Record<string, TypeKind> = {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    record_declaration: 'record',
    annotation_type_declaration: 'annotation',
};

export async function parseCompilationUnit(text: string): Promise<CompilationUnit> {
    const tree = await parseJava(text);
    try {
        return extractCompilationUnit(tree.rootNode);
    } finally {
        tree.delete();
    }
}

export function extractCompilationUnit(root: Node): CompilationUnit {
    const cu: CompilationUnit = { pkg: '', imports: [], types: [] };
    for (const child of root.namedChildren) {
        if (!child) { continue; }
        if (child.type === 'package_declaration') {
            const id = child.namedChildren.find(n => n && (n.type === 'scoped_identifier' || n.type === 'identifier'));
            cu.pkg = id?.text.replace(/\s+/g, '') ?? '';
        } else if (child.type === 'import_declaration') {
            const txt = child.text.replace(/^import\s+/, '').replace(/;\s*$/, '');
            const isStatic = /^static\s/.test(txt);
            const name = txt.replace(/^static\s+/, '').replace(/\s+/g, '');
            const wildcard = name.endsWith('.*');
            cu.imports.push({ name: wildcard ? name.slice(0, -2) : name, isStatic, wildcard });
        } else if (TYPE_DECLS[child.type]) {
            cu.types.push(extractType(child, ''));
        }
    }
    return cu;
}

export function extractType(node: Node, outer: string): TypeInfo {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text ?? '';
    const info: TypeInfo = {
        name,
        kind: TYPE_DECLS[node.type] ?? 'class',
        localName: outer ? `${outer}.${name}` : name,
        typeParams: typeParamNames(node.childForFieldName('type_parameters')),
        interfaces: [],
        methods: [],
        fields: [],
        nested: [],
        nameStart: nameNode?.startIndex ?? node.startIndex,
        nameEnd: nameNode?.endIndex ?? node.startIndex,
    };

    const superclass = node.childForFieldName('superclass');
    if (superclass) {
        const t = superclass.namedChildren[0];
        if (t) { info.superclass = t.text; }
    }
    // class: `interfaces` (super_interfaces); interface: extends_interfaces child
    for (const child of node.namedChildren) {
        if (!child) { continue; }
        if (child.type === 'super_interfaces' || child.type === 'extends_interfaces') {
            const list = child.namedChildren.find(n => n?.type === 'type_list');
            for (const t of list?.namedChildren ?? []) {
                if (t) { info.interfaces.push(t.text); }
            }
        }
    }

    if (info.kind === 'record') {
        const params = node.childForFieldName('parameters');
        for (const p of params?.namedChildren ?? []) {
            if (!p || p.type !== 'formal_parameter') { continue; }
            const pn = p.childForFieldName('name');
            const pt = p.childForFieldName('type');
            if (pn && pt) {
                info.fields.push({ name: pn.text, type: pt.text, nameStart: pn.startIndex, nameEnd: pn.endIndex });
                info.methods.push({
                    name: pn.text, params: [], varargs: false, returnType: pt.text, typeParams: [],
                    nameStart: pn.startIndex, nameEnd: pn.endIndex, isConstructor: false,
                });
            }
        }
    }

    const body = node.childForFieldName('body');
    if (body) { extractBody(body, info); }
    return info;
}

function extractBody(body: Node, info: TypeInfo): void {
    for (const member of body.namedChildren) {
        if (!member) { continue; }
        switch (member.type) {
            case 'method_declaration':
            case 'constructor_declaration':
            case 'compact_constructor_declaration':
            case 'annotation_type_element_declaration':
                info.methods.push(extractMethod(member));
                break;
            case 'field_declaration':
            case 'constant_declaration': {
                const type = member.childForFieldName('type')?.text ?? '';
                for (const d of member.childrenForFieldName('declarator')) {
                    const n = d?.childForFieldName('name');
                    if (n) {
                        const dims = d!.childForFieldName('dimensions')?.text ?? '';
                        info.fields.push({ name: n.text, type: type + dims, nameStart: n.startIndex, nameEnd: n.endIndex });
                    }
                }
                break;
            }
            case 'enum_constant': {
                const n = member.childForFieldName('name');
                if (n) { info.fields.push({ name: n.text, type: info.localName, nameStart: n.startIndex, nameEnd: n.endIndex }); }
                break;
            }
            case 'enum_body_declarations':
                extractBody(member, info);
                break;
            default:
                if (TYPE_DECLS[member.type]) {
                    info.nested.push(extractType(member, info.localName));
                }
        }
    }
}

function extractMethod(node: Node): MethodInfo {
    const nameNode = node.childForFieldName('name');
    const isConstructor = node.type !== 'method_declaration' && node.type !== 'annotation_type_element_declaration';
    const params: string[] = [];
    let varargs = false;
    const plist = node.childForFieldName('parameters');
    for (const p of plist?.namedChildren ?? []) {
        if (!p) { continue; }
        if (p.type === 'formal_parameter') {
            params.push(p.childForFieldName('type')?.text ?? '');
        } else if (p.type === 'spread_parameter') {
            varargs = true;
            const t = p.namedChildren.find(n => n && n.type !== 'modifiers' && n.type !== 'variable_declarator');
            params.push((t?.text ?? 'Object') + '[]');
        }
    }
    return {
        name: nameNode?.text ?? '',
        params,
        varargs,
        returnType: isConstructor ? null : (node.childForFieldName('type')?.text ?? null),
        typeParams: typeParamNames(node.childForFieldName('type_parameters')),
        nameStart: nameNode?.startIndex ?? node.startIndex,
        nameEnd: nameNode?.endIndex ?? node.startIndex,
        isConstructor,
    };
}

function typeParamNames(node: Node | null): string[] {
    if (!node) { return []; }
    const names: string[] = [];
    for (const tp of node.namedChildren) {
        if (tp?.type === 'type_parameter') {
            const id = tp.namedChildren.find(n => n?.type === 'type_identifier' || n?.type === 'identifier');
            if (id) { names.push(id.text); }
        }
    }
    return names;
}

/** Find a type by its local dotted name (`Outer.Inner`) in a compilation unit. */
export function findLocalType(cu: CompilationUnit, localName: string): TypeInfo | undefined {
    const parts = localName.split('.');
    let candidates = cu.types;
    let found: TypeInfo | undefined;
    for (const part of parts) {
        found = candidates.find(t => t.name === part);
        if (!found) { return undefined; }
        candidates = found.nested;
    }
    return found;
}

// ─── Type text parsing ──────────────────────────────────────────────────────

export interface TypeText {
    /** Possibly qualified name, e.g. `Map.Entry`, `java.util.List`, `int`. */
    name: string;
    args: TypeText[];
    dims: number;
}

/** Parse a Java type as written in source (`Map.Entry<String, List<Foo>>[]`). */
export function parseTypeText(src: string): TypeText | null {
    const s = src.replace(/@[\w.]+(\([^)]*\))?/g, ' ').replace(/\bfinal\b/g, ' ');
    let pos = 0;
    const ws = () => { while (pos < s.length && /\s/.test(s[pos])) { pos++; } };
    const parse = (): TypeText | null => {
        ws();
        if (s[pos] === '?') {
            pos++; ws();
            const m = /^(extends|super)\b/.exec(s.slice(pos));
            if (m) {
                pos += m[0].length;
                const bound = parse();
                return m[1] === 'extends' ? bound : { name: 'java.lang.Object', args: [], dims: 0 };
            }
            return { name: 'java.lang.Object', args: [], dims: 0 };
        }
        const nm = /^[\w$]+(\s*\.\s*[\w$]+)*/.exec(s.slice(pos));
        if (!nm) { return null; }
        pos += nm[0].length;
        let name = nm[0].replace(/\s+/g, '');
        let args: TypeText[] = [];
        ws();
        if (s[pos] === '<') {
            pos++;
            for (;;) {
                ws();
                if (s[pos] === '>') { pos++; break; }
                const a = parse();
                if (a) { args.push(a); }
                ws();
                if (s[pos] === ',') { pos++; continue; }
                if (s[pos] === '>') { pos++; break; }
                break;
            }
            ws();
            // Qualified type after generic: Outer<T>.Inner
            if (s[pos] === '.') {
                pos++;
                const rest = parse();
                if (rest) { name = `${name}.${rest.name}`; args = rest.args; return { name, args, dims: rest.dims }; }
            }
        }
        let dims = 0;
        for (;;) {
            ws();
            if (s[pos] === '[' ) { const close = s.indexOf(']', pos); if (close < 0) { break; } pos = close + 1; dims++; continue; }
            if (s.startsWith('...', pos)) { pos += 3; dims++; continue; }
            break;
        }
        return { name, args, dims };
    };
    return parse();
}

export const PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double', 'void']);
