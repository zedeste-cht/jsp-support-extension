/**
 * Maven POM model: parent inheritance, property interpolation,
 * dependencyManagement (incl. imported BOMs) and transitive resolution.
 *
 * Used for module discovery and for the fallback jar index when jdt.ls is
 * unavailable; jdt.ls does the authoritative resolution when present.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XmlElement, child, children, parseXml, textOf } from '../util/xml';

export interface Coord {
    groupId: string;
    artifactId: string;
    version: string;
}

export interface Dependency extends Coord {
    scope: string;
    type: string;
    classifier?: string;
    optional: boolean;
    systemPath?: string;
    exclusions: string[]; // "g:a", "*" wildcards allowed
}

export interface RawPom {
    file: string;
    xml: XmlElement;
    groupId?: string;
    artifactId: string;
    version?: string;
    packaging: string;
    parent?: { groupId: string; artifactId: string; version: string; relativePath?: string };
    modules: string[];
    properties: Map<string, string>;
    sourceDirectory?: string;
    testSourceDirectory?: string;
    warSourceDirectory?: string;
}

export interface EffectivePom {
    raw: RawPom;
    coord: Coord;
    properties: Map<string, string>;
    dependencies: Dependency[];
    managed: Map<string, Dependency>; // "g:a" -> managed dep
    sourceDirectory: string;
    warSourceDirectory: string;
}

export function readRawPom(file: string, text?: string): RawPom | undefined {
    let src: string;
    try {
        src = text ?? fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
    const xml = child(parseXml(src), 'project');
    if (!xml) { return undefined; }

    const parentEl = child(xml, 'parent');
    const parent = parentEl && textOf(parentEl, 'artifactId') ? {
        groupId: textOf(parentEl, 'groupId') ?? '',
        artifactId: textOf(parentEl, 'artifactId')!,
        version: textOf(parentEl, 'version') ?? '',
        relativePath: child(parentEl, 'relativePath') ? (textOf(parentEl, 'relativePath') ?? '') : undefined,
    } : undefined;

    const properties = new Map<string, string>();
    for (const p of child(xml, 'properties')?.children ?? []) {
        properties.set(p.name, p.text.trim());
    }

    let warSourceDirectory: string | undefined;
    const plugins = [
        ...children(child(xml, 'build', 'plugins'), 'plugin'),
        ...children(child(xml, 'build', 'pluginManagement', 'plugins'), 'plugin'),
    ];
    for (const pl of plugins) {
        if (textOf(pl, 'artifactId') === 'maven-war-plugin') {
            warSourceDirectory = textOf(pl, 'configuration', 'warSourceDirectory') ?? warSourceDirectory;
        }
    }

    return {
        file,
        xml,
        groupId: textOf(xml, 'groupId'),
        artifactId: textOf(xml, 'artifactId') ?? path.basename(path.dirname(file)),
        version: textOf(xml, 'version'),
        packaging: textOf(xml, 'packaging') ?? 'jar',
        parent,
        modules: children(child(xml, 'modules'), 'module').map(m => m.text.trim()).filter(Boolean),
        properties,
        sourceDirectory: textOf(xml, 'build', 'sourceDirectory'),
        testSourceDirectory: textOf(xml, 'build', 'testSourceDirectory'),
        warSourceDirectory,
    };
}

function readDeps(el: XmlElement | undefined): Dependency[] {
    return children(el, 'dependency').map(d => ({
        groupId: textOf(d, 'groupId') ?? '',
        artifactId: textOf(d, 'artifactId') ?? '',
        version: textOf(d, 'version') ?? '',
        scope: textOf(d, 'scope') ?? '',
        type: textOf(d, 'type') ?? 'jar',
        classifier: textOf(d, 'classifier'),
        optional: textOf(d, 'optional') === 'true',
        systemPath: textOf(d, 'systemPath'),
        exclusions: children(child(d, 'exclusions'), 'exclusion').map(e => `${textOf(e, 'groupId') ?? '*'}:${textOf(e, 'artifactId') ?? '*'}`),
    }));
}

export function defaultMavenRepository(): string {
    const settingsFiles = [
        path.join(os.homedir(), '.m2', 'settings.xml'),
        process.env.M2_HOME ? path.join(process.env.M2_HOME, 'conf', 'settings.xml') : '',
        process.env.MAVEN_HOME ? path.join(process.env.MAVEN_HOME, 'conf', 'settings.xml') : '',
    ].filter(Boolean);
    for (const f of settingsFiles) {
        try {
            const repo = textOf(child(parseXml(fs.readFileSync(f, 'utf8')), 'settings'), 'localRepository');
            if (repo) { return repo.replace(/\$\{user\.home\}/g, os.homedir()); }
        } catch { /* missing */ }
    }
    return path.join(os.homedir(), '.m2', 'repository');
}

export function artifactPath(repo: string, c: Coord, classifier?: string, ext = 'jar'): string {
    const file = `${c.artifactId}-${c.version}${classifier ? '-' + classifier : ''}.${ext}`;
    return path.join(repo, ...c.groupId.split('.'), c.artifactId, c.version, file);
}

const key = (g: string, a: string) => `${g}:${a}`;

export class MavenResolver {
    private readonly effective = new Map<string, EffectivePom | undefined>();
    /** Workspace poms by coordinate, so reactor modules resolve locally. */
    private readonly workspacePoms = new Map<string, string>();

    constructor(readonly repo: string) { }

    registerWorkspacePom(raw: RawPom): void {
        const ep = this.loadEffective(raw.file);
        if (ep) { this.workspacePoms.set(key(ep.coord.groupId, ep.coord.artifactId), raw.file); }
    }

    workspacePomFor(groupId: string, artifactId: string): string | undefined {
        return this.workspacePoms.get(key(groupId, artifactId));
    }

    loadEffective(file: string, depth = 0): EffectivePom | undefined {
        if (this.effective.has(file)) { return this.effective.get(file); }
        this.effective.set(file, undefined); // cycle guard
        const raw = readRawPom(file);
        if (!raw || depth > 20) { return undefined; }

        let parent: EffectivePom | undefined;
        if (raw.parent) {
            const rel = raw.parent.relativePath === undefined ? '../pom.xml' : raw.parent.relativePath;
            const candidates: string[] = [];
            if (rel) {
                const p = path.resolve(path.dirname(file), rel);
                candidates.push(p.endsWith('.xml') ? p : path.join(p, 'pom.xml'));
            }
            for (const c of candidates) {
                const pr = fs.existsSync(c) ? readRawPom(c) : undefined;
                if (pr && pr.artifactId === raw.parent.artifactId) { parent = this.loadEffective(c, depth + 1); break; }
            }
            if (!parent) {
                parent = this.loadEffective(artifactPath(this.repo, raw.parent, undefined, 'pom'), depth + 1);
            }
        }

        const coord: Coord = {
            groupId: raw.groupId ?? raw.parent?.groupId ?? '',
            artifactId: raw.artifactId,
            version: raw.version ?? raw.parent?.version ?? '',
        };
        const props = new Map<string, string>(parent?.properties ?? []);
        for (const [k, v] of raw.properties) { props.set(k, v); }
        for (const [k, v] of Object.entries({
            'project.groupId': coord.groupId, 'pom.groupId': coord.groupId, groupId: coord.groupId,
            'project.artifactId': coord.artifactId, 'project.version': coord.version, 'pom.version': coord.version, version: coord.version,
            'project.parent.version': raw.parent?.version ?? '', 'parent.version': raw.parent?.version ?? '',
            'project.parent.groupId': raw.parent?.groupId ?? '',
            'project.basedir': path.dirname(file), basedir: path.dirname(file),
            'user.home': os.homedir(),
        })) { props.set(k, v); }
        const interp = (s: string) => interpolate(s, props);
        coord.groupId = interp(coord.groupId);
        coord.version = interp(coord.version);

        const fix = (d: Dependency): Dependency => ({
            ...d,
            groupId: interp(d.groupId), artifactId: interp(d.artifactId), version: interp(d.version),
            scope: interp(d.scope), classifier: d.classifier && interp(d.classifier),
            systemPath: d.systemPath && path.normalize(interp(d.systemPath)),
        });

        const managed = new Map<string, Dependency>(parent?.managed ?? []);
        for (const d of readDeps(child(raw.xml, 'dependencyManagement', 'dependencies')).map(fix)) {
            if (d.scope === 'import' && d.type === 'pom') {
                const bom = this.loadEffective(artifactPath(this.repo, d, undefined, 'pom'), depth + 1);
                for (const [k, v] of bom?.managed ?? []) { if (!managed.has(k)) { managed.set(k, v); } }
            } else {
                managed.set(key(d.groupId, d.artifactId), d);
            }
        }

        const deps = new Map<string, Dependency>();
        for (const d of parent?.dependencies ?? []) { deps.set(key(d.groupId, d.artifactId), d); }
        for (const d of readDeps(child(raw.xml, 'dependencies')).map(fix)) {
            const m = managed.get(key(d.groupId, d.artifactId));
            deps.set(key(d.groupId, d.artifactId), {
                ...d,
                version: d.version || m?.version || '',
                scope: d.scope || m?.scope || 'compile',
                exclusions: d.exclusions.length ? d.exclusions : (m?.exclusions ?? []),
            });
        }

        const ep: EffectivePom = {
            raw, coord, properties: props, dependencies: [...deps.values()], managed,
            sourceDirectory: interp(raw.sourceDirectory ?? parent?.raw.sourceDirectory ?? 'src/main/java'),
            warSourceDirectory: interp(raw.warSourceDirectory ?? parent?.warSourceDirectory ?? 'src/main/webapp'),
        };
        this.effective.set(file, ep);
        return ep;
    }

    /**
     * Breadth-first transitive resolution (nearest wins, like Maven).
     * Reactor modules are returned with `workspacePom` set instead of a jar.
     */
    resolveTransitive(rootPom: string, limit = 3000): (Dependency & { workspacePom?: string })[] {
        const root = this.loadEffective(rootPom);
        if (!root) { return []; }
        const out = new Map<string, Dependency & { workspacePom?: string }>();
        type Item = { dep: Dependency; exclusions: string[]; depth: number };
        const queue: Item[] = root.dependencies.map(d => ({ dep: d, exclusions: d.exclusions, depth: 0 }));

        while (queue.length && out.size < limit) {
            const { dep, exclusions, depth } = queue.shift()!;
            const k = key(dep.groupId, dep.artifactId);
            if (out.has(k) || !dep.version) { continue; }
            const managedVersion = depth > 0 ? root.managed.get(k)?.version : undefined;
            const resolved = { ...dep, version: managedVersion || dep.version };
            const wsPom = this.workspacePoms.get(k);
            out.set(k, { ...resolved, workspacePom: wsPom });

            if (resolved.scope === 'system' || depth > 12) { continue; }
            const pomFile = wsPom ?? artifactPath(this.repo, resolved, undefined, 'pom');
            const ep = fs.existsSync(pomFile) ? this.loadEffective(pomFile) : undefined;
            if (!ep) { continue; }
            for (const td of ep.dependencies) {
                if (td.optional || td.scope === 'test' || td.scope === 'provided' || td.scope === 'system') { continue; }
                if (isExcluded(td, exclusions)) { continue; }
                queue.push({ dep: td, exclusions: [...exclusions, ...td.exclusions], depth: depth + 1 });
            }
        }
        return [...out.values()];
    }
}

function isExcluded(d: Coord, exclusions: string[]): boolean {
    return exclusions.some(e => {
        const [g, a] = e.split(':');
        return (g === '*' || g === d.groupId) && (a === '*' || a === d.artifactId);
    });
}

export function interpolate(s: string, props: Map<string, string>, depth = 0): string {
    if (!s.includes('${') || depth > 10) { return s; }
    const out = s.replace(/\$\{([^}]+)\}/g, (m, name: string) => {
        if (props.has(name)) { return props.get(name)!; }
        if (name.startsWith('env.')) { return process.env[name.substring(4)] ?? m; }
        return m;
    });
    return out === s ? out : interpolate(out, props, depth + 1);
}
