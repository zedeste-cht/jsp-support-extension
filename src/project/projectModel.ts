/**
 * Workspace module model (Maven / Gradle / plain folders).
 * Answers: which module owns a file, its source and webapp roots, and how
 * to rank candidates from several modules for a given JSP.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Coord, MavenResolver, readRawPom } from './maven';

export type ModuleKind = 'maven' | 'gradle' | 'folder';

export interface Module {
    dir: string;
    kind: ModuleKind;
    name: string;
    buildFile?: string;
    coord?: Coord;
    sourceDirs: string[];
    webappDirs: string[];
    /** Workspace modules this module depends on (direct). */
    dependsOn: Module[];
}

export interface ProjectModelOptions {
    workspaceFolders: string[];
    /** Absolute paths of pom.xml / build.gradle(.kts) files in the workspace. */
    buildFiles: string[];
    /** Extra source paths (relative to each workspace folder) from settings. */
    extraSourcePaths?: string[];
    resolver: MavenResolver;
}

const WEBAPP_GUESSES = ['src/main/webapp', 'WebContent', 'WebRoot', 'webapp', 'web'];
const SOURCE_GUESSES = ['src/main/java', 'src'];

const exists = async (p: string) => fs.promises.stat(p).then(s => s.isDirectory(), () => false);
const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
};
const isUnder = (file: string, dir: string) => {
    const f = norm(file);
    const d = norm(dir);
    return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
};

export class ProjectModel {
    private constructor(readonly modules: Module[], readonly resolver: MavenResolver) { }

    static async build(opts: ProjectModelOptions): Promise<ProjectModel> {
        const modules: Module[] = [];
        const byDir = new Map<string, Module>();
        const extra = opts.extraSourcePaths ?? [];

        const poms = opts.buildFiles.filter(f => path.basename(f) === 'pom.xml');
        const gradles = opts.buildFiles.filter(f => /^build\.gradle(\.kts)?$/.test(path.basename(f)));

        // Maven
        for (const pom of poms) {
            const raw = readRawPom(pom);
            if (!raw) { continue; }
            opts.resolver.registerWorkspacePom(raw);
        }
        for (const pom of poms) {
            const ep = opts.resolver.loadEffective(pom);
            if (!ep) { continue; }
            const dir = path.dirname(pom);
            const m: Module = {
                dir, kind: 'maven', name: ep.coord.artifactId, buildFile: pom, coord: ep.coord,
                sourceDirs: await existing(dir, [ep.sourceDirectory, ...extra]),
                webappDirs: await existing(dir, [ep.warSourceDirectory, ...WEBAPP_GUESSES]),
                dependsOn: [],
            };
            modules.push(m);
            byDir.set(norm(dir), m);
        }
        for (const m of modules) {
            const ep = opts.resolver.loadEffective(m.buildFile!);
            for (const d of ep?.dependencies ?? []) {
                const wsPom = opts.resolver.workspacePomFor(d.groupId, d.artifactId);
                const dep = wsPom && byDir.get(norm(path.dirname(wsPom)));
                if (dep && dep !== m) { m.dependsOn.push(dep); }
            }
        }

        // Gradle (conventions only; jdt.ls resolves the real classpath)
        const gradleModules: { m: Module; text: string }[] = [];
        for (const g of gradles) {
            const dir = path.dirname(g);
            if (byDir.has(norm(dir))) { continue; }
            const text = await fs.promises.readFile(g, 'utf8').catch(() => '');
            const m: Module = {
                dir, kind: 'gradle', name: path.basename(dir), buildFile: g,
                sourceDirs: await existing(dir, ['src/main/java', ...extra]),
                webappDirs: await existing(dir, ['src/main/webapp', ...WEBAPP_GUESSES]),
                dependsOn: [],
            };
            modules.push(m);
            byDir.set(norm(dir), m);
            gradleModules.push({ m, text });
        }
        for (const { m, text } of gradleModules) {
            const root = await gradleRoot(m.dir);
            const re = /project\(\s*(?:path\s*:\s*)?['"](:[\w\-.:]*)['"]\s*\)/g;
            let r: RegExpExecArray | null;
            while ((r = re.exec(text)) !== null) {
                const depDir = path.join(root, ...r[1].split(':').filter(Boolean));
                const dep = byDir.get(norm(depDir));
                if (dep && dep !== m) { m.dependsOn.push(dep); }
            }
        }

        // Plain folders without any build file.
        for (const wf of opts.workspaceFolders) {
            if (modules.some(m => isUnder(m.dir, wf) || isUnder(wf, m.dir))) { continue; }
            modules.push({
                dir: wf, kind: 'folder', name: path.basename(wf),
                sourceDirs: await existing(wf, [...SOURCE_GUESSES, ...extra]),
                webappDirs: await existing(wf, WEBAPP_GUESSES),
                dependsOn: [],
            });
        }

        // Deepest first so moduleOf() finds the innermost module.
        modules.sort((a, b) => b.dir.length - a.dir.length);
        return new ProjectModel(modules, opts.resolver);
    }

    moduleOf(file: string | undefined): Module | undefined {
        if (!file) { return undefined; }
        return this.modules.find(m => isUnder(file, m.dir));
    }

    scopeKey(file: string | undefined): string {
        return this.moduleOf(file)?.dir ?? '';
    }

    /** The file's module, then its (transitive) workspace dependencies, then all other modules. */
    modulesInScope(file: string | undefined): Module[] {
        const own = this.moduleOf(file);
        const ordered: Module[] = [];
        const seen = new Set<Module>();
        const visit = (m: Module) => {
            if (seen.has(m)) { return; }
            seen.add(m);
            ordered.push(m);
            m.dependsOn.forEach(visit);
        };
        if (own) { visit(own); }
        // Parent modules of the owner (aggregators often hold shared sources).
        for (const m of this.modules) {
            if (own && m !== own && isUnder(own.dir, m.dir)) { visit(m); }
        }
        for (const m of this.modules) { visit(m); }
        return ordered;
    }

    sourceDirsInScope(file: string | undefined): string[] {
        return unique(this.modulesInScope(file).flatMap(m => m.sourceDirs));
    }

    /**
     * Webapp roots to resolve `/absolute` web paths against, most specific first:
     * the nearest ancestor with WEB-INF, the owning module's webapp dirs, then
     * the webapp dirs of other modules (war overlays).
     */
    webappRootsFor(file: string | undefined): string[] {
        const roots: string[] = [];
        if (file) {
            let dir = path.dirname(file);
            const own = this.moduleOf(file);
            for (let i = 0; i < 30; i++) {
                if (fs.existsSync(path.join(dir, 'WEB-INF'))) { roots.push(dir); break; }
                const up = path.dirname(dir);
                if (up === dir || (own && !isUnder(up, own.dir))) { break; }
                dir = up;
            }
        }
        for (const m of this.modulesInScope(file)) {
            const containing = m.webappDirs.filter(w => file && isUnder(file, w));
            roots.push(...containing, ...m.webappDirs);
        }
        return unique(roots);
    }

    /** Sort URIs/paths so candidates from modules in scope come first. */
    rank<T>(items: T[], pathOf: (t: T) => string | undefined, file: string | undefined): T[] {
        const order = this.modulesInScope(file);
        const score = (t: T) => {
            const p = pathOf(t);
            if (!p) { return order.length + 1; } // jars etc. after workspace sources
            const m = this.moduleOf(p);
            const i = m ? order.indexOf(m) : -1;
            return i < 0 ? order.length : i;
        };
        return [...items].map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => a.s - b.s || a.i - b.i).map(x => x.t);
    }
}

async function existing(base: string, rels: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const r of unique(rels.filter(Boolean))) {
        const abs = path.resolve(base, r);
        if (await exists(abs)) { out.push(abs); }
    }
    return out;
}

async function gradleRoot(dir: string): Promise<string> {
    let cur = dir;
    for (let i = 0; i < 20; i++) {
        for (const f of ['settings.gradle', 'settings.gradle.kts']) {
            if (await fs.promises.stat(path.join(cur, f)).then(() => true, () => false)) { return cur; }
        }
        const up = path.dirname(cur);
        if (up === cur) { break; }
        cur = up;
    }
    return dir;
}

function unique<T>(xs: T[]): T[] {
    return [...new Set(xs)];
}

export { isUnder };
