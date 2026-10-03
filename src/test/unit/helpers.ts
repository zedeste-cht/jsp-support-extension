import * as path from 'path';
import { initJavaParser } from '../../java/javaParser';
import { ClassLocator, ClassSource } from '../../java/classRepository';

/** Repo root (out/test/unit → ../../..). */
export const ROOT = path.resolve(__dirname, '..', '..', '..');

export function initParser() {
    return initJavaParser(path.join(ROOT, 'dist'));
}

/** In-memory locator keyed by top-level FQN. */
export class MemoryLocator implements ClassLocator {
    readonly name = 'memory';
    readonly calls: string[] = [];
    private readonly classes = new Map<string, string>();

    add(fqn: string, text: string): this {
        this.classes.set(fqn, text);
        return this;
    }

    async locate(fqn: string): Promise<ClassSource | null> {
        this.calls.push(fqn);
        const text = this.classes.get(fqn);
        return text === undefined ? null : { uri: `mem:/${fqn.replace(/\./g, '/')}.java`, text };
    }
}

/** Offset of the n-th occurrence of `needle` (plus `delta`). */
export function offsetOf(text: string, needle: string, nth = 0, delta = 0): number {
    let i = -1;
    for (let n = 0; n <= nth; n++) {
        i = text.indexOf(needle, i + 1);
        if (i < 0) { throw new Error(`"${needle}" #${nth} not found`); }
    }
    return i + delta;
}
