import * as path from 'path';
import { Parser, Language, Tree } from 'web-tree-sitter';

let parserPromise: Promise<Parser> | undefined;

/**
 * Initialise tree-sitter once. `wasmDir` must contain `tree-sitter.wasm`
 * (runtime) and `tree-sitter-java.wasm` (grammar).
 */
export function initJavaParser(wasmDir: string): Promise<Parser> {
    if (!parserPromise) {
        parserPromise = (async () => {
            await Parser.init({ locateFile: (name: string) => path.join(wasmDir, name) });
            const java = await Language.load(path.join(wasmDir, 'tree-sitter-java.wasm'));
            const parser = new Parser();
            parser.setLanguage(java);
            return parser;
        })();
    }
    return parserPromise;
}

export async function parseJava(text: string): Promise<Tree> {
    if (!parserPromise) { throw new Error('Java parser not initialised'); }
    const parser = await parserPromise;
    const tree = parser.parse(text);
    if (!tree) { throw new Error('tree-sitter failed to parse'); }
    return tree;
}
