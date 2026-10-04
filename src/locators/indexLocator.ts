/**
 * Locator that works without jdt.ls:
 *  1. workspace source folders (module-scoped, direct path lookup, no scan)
 *  2. jars on the module classpath (Maven transitive deps, systemPath,
 *     WEB-INF/lib, lib/) – uses `-sources.jar` or jars that contain .java
 *  3. JDK src.zip
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ClassLocator, ClassSource } from '../java/classRepository';
import { ProjectModel, Module } from '../project/projectModel';
import { artifactPath } from '../project/maven';
import { ZipFile } from '../util/zip';

export const JAR_SCHEME = 'jsp-src';

export function jarEntryUri(zipPath: string, entry: string): string {
    return `${JAR_SCHEME}:/${entry}?${encodeURIComponent(zipPath)}`;
}

interface JarHit { zip: string; entry: string }

export type IndexPart = 'sources' | 'jars';

export class IndexLocator implements ClassLocator {
    readonly name: string;
    private readonly zips = new Map<string, Promise<ZipFile | null>>();
    private readonly moduleIndex = new Map<string, Promise<Map<string, JarHit>>>();
    private jdkIndex?: Promise<Map<string, JarHit>>;

    constructor(
        private readonly model: () => ProjectModel | undefined,
        private readonly javaHome: () => string | undefined,
        private readonly parts: IndexPart[] = ['sources', 'jars'],
        /** When true, only loose jars are indexed (build-tool classpath is skipped). */
        private readonly looseJarsOnly: () => boolean = () => false,
    ) {
        this.name = `index(${parts.join('+')})`;
    }

    /** Drop jar indexes (e.g. after pom changes or new sources downloaded). */
    reset(): void {
        this.moduleIndex.clear();
        this.zips.clear();
        this.jdkIndex = undefined;
    }

    async locate(fqn: string, fromFile?: string): Promise<ClassSource | null> {
        const model = this.model();
        const rel = fqn.replace(/\./g, '/') + '.java';

        if (this.parts.includes('sources')) {
            for (const dir of model?.sourceDirsInScope(fromFile) ?? []) {
                const file = path.join(dir, rel);
                const text = await fs.promises.readFile(file, 'utf8').catch(() => null);
                if (text !== null) { return { uri: pathToFileURL(file).toString(), text }; }
            }
        }
        if (!this.parts.includes('jars')) { return null; }

        if (model) {
            for (const m of model.modulesInScope(fromFile)) {
                const hit = (await this.indexFor(m, model)).get(rel);
                if (hit) { return this.readHit(hit); }
            }
        }

        // The JDK is checked even with jdt.ls up: src.zip is cheap and covers
        // lookups jdt.ls cannot answer (e.g. its symbol search still warming up).
        const jdkHit = (await this.jdk()).get(rel);
        return jdkHit ? this.readHit(jdkHit) : null;
    }

    async readEntry(zipPath: string, entry: string): Promise<string | null> {
        const zip = await this.zip(zipPath);
        return zip ? zip.readText(entry) : null;
    }

    private async readHit(hit: JarHit): Promise<ClassSource | null> {
        const text = await this.readEntry(hit.zip, hit.entry);
        return text === null ? null : { uri: jarEntryUri(hit.zip, hit.entry), text };
    }

    private zip(p: string): Promise<ZipFile | null> {
        let z = this.zips.get(p);
        if (!z) {
            z = ZipFile.open(p).catch(() => null);
            this.zips.set(p, z);
        }
        return z;
    }

    private indexFor(m: Module, model: ProjectModel): Promise<Map<string, JarHit>> {
        const loose = this.looseJarsOnly();
        const key = `${m.dir}|${loose}`;
        let idx = this.moduleIndex.get(key);
        if (!idx) {
            idx = this.buildIndex(this.jarsFor(m, model, !loose));
            this.moduleIndex.set(key, idx);
        }
        return idx;
    }

    /** Candidate archives for a module, sources jars first. */
    jarsFor(m: Module, model: ProjectModel, includeBuildClasspath = true): string[] {
        const jars: string[] = [];
        const addWithSources = (jar: string) => {
            jars.push(jar.replace(/\.jar$/i, '-sources.jar'), jar);
        };
        if (includeBuildClasspath && m.kind === 'maven' && m.buildFile) {
            const repo = model.resolver.repo;
            for (const d of model.resolver.resolveTransitive(m.buildFile)) {
                if (d.workspacePom || d.type === 'pom') { continue; }
                if (d.scope === 'system' && d.systemPath) {
                    addWithSources(d.systemPath);
                } else {
                    jars.push(artifactPath(repo, d, 'sources'), artifactPath(repo, d, d.classifier));
                }
            }
        }
        for (const dir of [...m.webappDirs.map(w => path.join(w, 'WEB-INF', 'lib')), path.join(m.dir, 'lib'), path.join(m.dir, 'libs')]) {
            let names: string[] = [];
            try { names = fs.readdirSync(dir); } catch { continue; }
            for (const n of names) {
                if (/\.jar$/i.test(n) && !/-sources\.jar$/i.test(n)) { addWithSources(path.join(dir, n)); }
            }
        }
        return [...new Set(jars)];
    }

    private async buildIndex(jars: string[], stripModulePrefix = false): Promise<Map<string, JarHit>> {
        const idx = new Map<string, JarHit>();
        for (const jar of jars) {
            const zip = await this.zip(jar);
            if (!zip) { continue; }
            for (const entry of zip.entries.keys()) {
                if (!entry.endsWith('.java')) { continue; }
                let rel = entry;
                if (stripModulePrefix) {
                    // JDK 9+: java.base/java/lang/String.java
                    const slash = entry.indexOf('/');
                    if (slash > 0 && entry.substring(0, slash).includes('.')) { rel = entry.substring(slash + 1); }
                }
                if (!idx.has(rel)) { idx.set(rel, { zip: jar, entry }); }
            }
        }
        return idx;
    }

    private jdk(): Promise<Map<string, JarHit>> {
        if (!this.jdkIndex) {
            const home = this.javaHome();
            const candidates = home ? [path.join(home, 'lib', 'src.zip'), path.join(home, 'src.zip')] : [];
            this.jdkIndex = this.buildIndex(candidates.filter(c => fs.existsSync(c)).slice(0, 1), true);
        }
        return this.jdkIndex;
    }
}
