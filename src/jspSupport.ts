/**
 * Service container: owns the project model, class repository, resolvers and
 * caches, and keeps them up to date with workspace changes.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type * as TS from 'typescript';
import { JspDocument, parseJsp } from './jsp/jspParser';
import { buildVirtualJs } from './jsp/virtualJs';
import { resolveWebPath } from './jsp/webPaths';
import { initJavaParser } from './java/javaParser';
import { ClassLocator, ClassRepository, Target } from './java/classRepository';
import { JavaResolver, JspJavaPage } from './java/javaResolver';
import { IndexLocator } from './locators/indexLocator';
import { JdtLocator } from './locators/jdtLocator';
import { ProjectModel } from './project/projectModel';
import { MavenResolver, defaultMavenRepository } from './project/maven';
import { JsDefinitionService, JsInput, JsTarget, scanFunctionDefs } from './js/jsService';

const BUILD_GLOB = '**/{pom.xml,build.gradle,build.gradle.kts}';
const EXCLUDE_GLOB = '**/{node_modules,target,build,bin,out,.git,.idea,.settings}/**';
const MAX_JS_BYTES = 1024 * 1024;

export class JspSupport implements vscode.Disposable {
    readonly log: vscode.OutputChannel;
    private model?: ProjectModel;
    private modelPromise?: Promise<ProjectModel>;
    private readonly sources: IndexLocator;
    private readonly jars: IndexLocator;
    private readonly jdt: JdtLocator;
    readonly repo: ClassRepository;
    readonly java: JavaResolver;
    private readonly js: JsDefinitionService;
    private readonly jspCache = new Map<string, { version: number; doc: JspDocument }>();
    private readonly pageCache = new Map<string, { version: number; page: Promise<JspJavaPage> }>();
    private readonly fnIndex = new Map<string, { mtime: number; defs: Map<string, number[]> }>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        this.log = createLog(context);
        void initJavaParser(path.join(context.extensionPath, 'dist'));

        const getModel = () => this.model;
        // (lookups await ensureModel() first, see javaPage)
        const javaHome = () => this.javaHome();
        this.sources = new IndexLocator(getModel, javaHome, ['sources']);
        this.jdt = new JdtLocator(getModel, this.log);
        // With jdt.ls up, Maven/Gradle classpaths are its job; the jar index then
        // only covers loose jars (WEB-INF/lib, lib/) jdt.ls may not know, plus the
        // JDK src.zip as a fallback.
        this.jars = new IndexLocator(getModel, javaHome, ['jars'], () => this.jdt.isReady);
        const locators: ClassLocator[] = [this.sources, this.jdt, this.jars];
        this.repo = new ClassRepository(locators, f => this.model?.scopeKey(f) ?? '', m => this.log.appendLine(m));
        this.java = new JavaResolver(this.repo);
        this.js = new JsDefinitionService(() => this.loadTypeScript());

        this.watch();
        void this.ensureModel();
    }

    // ─── Project model ──────────────────────────────────────────────────────

    ensureModel(): Promise<ProjectModel> {
        if (!this.modelPromise) {
            this.modelPromise = this.buildModel().then(m => {
                this.model = m;
                return m;
            }, e => {
                this.log.appendLine(`Failed to build project model: ${e?.stack ?? e}`);
                this.modelPromise = undefined;
                throw e;
            });
        }
        return this.modelPromise;
    }

    private async buildModel(): Promise<ProjectModel> {
        const started = Date.now();
        const cfg = vscode.workspace.getConfiguration('jsp-support');
        const buildFiles = (await vscode.workspace.findFiles(BUILD_GLOB, EXCLUDE_GLOB)).map(u => u.fsPath);
        const repo = cfg.get<string>('mavenRepository') || defaultMavenRepository();
        const model = await ProjectModel.build({
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
            buildFiles,
            extraSourcePaths: cfg.get<string[]>('javaSourcePaths') ?? [],
            resolver: new MavenResolver(repo),
        });
        this.log.appendLine(`Project model: ${model.modules.length} module(s) in ${Date.now() - started}ms`);
        for (const m of model.modules) {
            this.log.appendLine(`  [${m.kind}] ${m.name} ${m.dir}`);
            this.log.appendLine(`      sources: ${m.sourceDirs.join(', ') || '-'}`);
            this.log.appendLine(`      webapp:  ${m.webappDirs.join(', ') || '-'}`);
            if (m.dependsOn.length) { this.log.appendLine(`      depends: ${m.dependsOn.map(d => d.name).join(', ')}`); }
        }
        return model;
    }

    private invalidateModel(): void {
        this.modelPromise = undefined;
        this.jars.reset();
        this.repo.clear();
        void this.ensureModel();
    }

    private javaHome(): string | undefined {
        const cfg = vscode.workspace.getConfiguration();
        return cfg.get<string>('jsp-support.javaHome')
            || cfg.get<string>('java.jdt.ls.java.home')
            || cfg.get<{ path: string; default?: boolean }[]>('java.configuration.runtimes')?.find(r => r.default)?.path
            || process.env.JAVA_HOME
            || undefined;
    }

    private watch(): void {
        const buildWatcher = vscode.workspace.createFileSystemWatcher(BUILD_GLOB);
        buildWatcher.onDidChange(() => this.invalidateModel());
        buildWatcher.onDidCreate(() => this.invalidateModel());
        buildWatcher.onDidDelete(() => this.invalidateModel());

        // Java sources changed: drop parsed class models (cheap to rebuild).
        const javaWatcher = vscode.workspace.createFileSystemWatcher('**/*.java');
        const clearRepo = () => this.repo.clear();
        javaWatcher.onDidChange(clearRepo);
        javaWatcher.onDidCreate(clearRepo);
        javaWatcher.onDidDelete(clearRepo);

        this.disposables.push(
            buildWatcher, javaWatcher,
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('jsp-support') || e.affectsConfiguration('java.jdt.ls.java.home')) {
                    this.invalidateModel();
                }
            }),
            vscode.workspace.onDidCloseTextDocument(d => {
                const key = d.uri.toString();
                this.jspCache.delete(key);
                const page = this.pageCache.get(key);
                if (page) {
                    void page.page.then(p => p.dispose(), () => undefined);
                    this.pageCache.delete(key);
                }
            }),
        );
    }

    // ─── Per-document caches ────────────────────────────────────────────────

    jspDocument(doc: vscode.TextDocument): JspDocument {
        const key = doc.uri.toString();
        const hit = this.jspCache.get(key);
        if (hit && hit.version === doc.version) { return hit.doc; }
        const parsed = parseJsp(doc.getText());
        this.jspCache.set(key, { version: doc.version, doc: parsed });
        return parsed;
    }

    async javaPage(doc: vscode.TextDocument): Promise<JspJavaPage> {
        // Module scoping needs the project model; build it before the first lookup.
        await Promise.all([initJavaParser(path.join(this.context.extensionPath, 'dist')), this.ensureModel().catch(() => undefined)]);
        const key = doc.uri.toString();
        const hit = this.pageCache.get(key);
        if (hit && hit.version === doc.version) { return hit.page; }
        if (hit) { void hit.page.then(p => p.dispose(), () => undefined); }
        const page = JspJavaPage.create(this.jspDocument(doc), key, doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined);
        this.pageCache.set(key, { version: doc.version, page });
        return page;
    }

    // ─── Web paths & JS ─────────────────────────────────────────────────────

    async resolveWebPath(raw: string, fromFile: string): Promise<string[]> {
        const model = await this.ensureModel().catch(() => undefined);
        return resolveWebPath(raw, fromFile, model?.webappRootsFor(fromFile) ?? []);
    }

    async jsDefinition(doc: vscode.TextDocument, offset: number): Promise<JsTarget[]> {
        const jsp = this.jspDocument(doc);
        const fsPath = doc.uri.fsPath;
        const main: JsInput = { path: fsPath, text: buildVirtualJs(jsp) };
        const others = await this.collectJsInputs(jsp, fsPath);
        const word = wordAt(doc.getText(), offset);

        let defs: JsTarget[] = [];
        try {
            defs = this.js.definition(main, others, offset);
        } catch (e) {
            this.log.appendLine(`TypeScript service failed: ${e}`);
        }
        // TS points at the identifier itself when it can't resolve; treat as miss.
        defs = defs.filter(d => !(samePath(d.path, fsPath) && offset >= d.start && offset <= d.end));
        if (defs.length || !word) { return defs; }
        return this.heuristicJsDefinition(word, fsPath);
    }

    /** Included pages (projected) and external scripts reachable from a page. */
    private async collectJsInputs(jsp: JspDocument, fromFile: string, depth = 0, seen = new Set<string>()): Promise<JsInput[]> {
        seen.add(normPath(fromFile));
        const inputs: JsInput[] = [];
        for (const s of jsp.scripts) {
            if (!s.src) { continue; }
            for (const file of await this.resolveWebPath(s.src.value, fromFile)) {
                if (seen.has(normPath(file)) || /\.min\.js$/i.test(file)) { continue; }
                seen.add(normPath(file));
                const text = await readSmall(file);
                if (text !== null) { inputs.push({ path: file, text }); }
            }
        }
        if (depth >= 4) { return inputs; }
        for (const inc of jsp.includes) {
            for (const file of await this.resolveWebPath(inc.path, fromFile)) {
                if (seen.has(normPath(file))) { continue; }
                const text = await this.readDocText(file);
                if (text === null) { continue; }
                const incJsp = parseJsp(text);
                inputs.push({ path: file, text: buildVirtualJs(incJsp) });
                inputs.push(...await this.collectJsInputs(incJsp, file, depth + 1, seen));
            }
        }
        return inputs;
    }

    /** Last resort: regex index of function definitions in the webapp dirs in scope. */
    private async heuristicJsDefinition(name: string, fromFile: string): Promise<JsTarget[]> {
        const model = await this.ensureModel().catch(() => undefined);
        const roots = model?.webappRootsFor(fromFile) ?? [];
        const results: JsTarget[] = [];
        for (const root of roots) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(root, '**/*.{js,jsp,jspf}'), '**/{node_modules,*.min.js}/**', 5000);
            for (const uri of files) {
                if (/\.min\.js$/i.test(uri.fsPath)) { continue; }
                const defs = await this.functionDefs(uri.fsPath);
                for (const at of defs?.get(name) ?? []) {
                    results.push({ path: uri.fsPath, start: at, end: at + name.length });
                }
            }
            if (results.length) { break; }
        }
        return results;
    }

    private async functionDefs(file: string): Promise<Map<string, number[]> | undefined> {
        const stat = await fs.promises.stat(file).catch(() => undefined);
        if (!stat || stat.size > MAX_JS_BYTES) { return undefined; }
        const hit = this.fnIndex.get(file);
        if (hit && hit.mtime === stat.mtimeMs) { return hit.defs; }
        let text = await fs.promises.readFile(file, 'utf8').catch(() => '');
        if (/\.jsp[fx]?$/i.test(file)) { text = buildVirtualJs(parseJsp(text)); }
        const defs = scanFunctionDefs(text);
        this.fnIndex.set(file, { mtime: stat.mtimeMs, defs });
        return defs;
    }

    async readDocText(file: string): Promise<string | null> {
        const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && samePath(d.uri.fsPath, file));
        if (open) { return open.getText(); }
        return fs.promises.readFile(file, 'utf8').catch(() => null);
    }

    private loadTypeScript(): typeof TS {
        // Shipped next to the bundle and loaded on first JS lookup only.
        return require(path.join(this.context.extensionPath, 'dist', 'typescript.js'));
    }

    // ─── Location helpers ───────────────────────────────────────────────────

    toLocation(t: Target): vscode.Location {
        const uri = vscode.Uri.parse(t.uri);
        return new vscode.Location(uri, new vscode.Range(positionAt(t.text, t.start), positionAt(t.text, t.end)));
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.jdt.dispose();
        this.log.dispose();
    }
}

function createLog(context: vscode.ExtensionContext): vscode.OutputChannel {
    const channel = vscode.window.createOutputChannel('JSP Support');
    if (context.extensionMode === vscode.ExtensionMode.Production) { return channel; }
    // Mirror to the console during development/tests.
    return new Proxy(channel, {
        get(target, prop, receiver) {
            if (prop === 'appendLine') {
                return (line: string) => { console.log(`[jsp-support] ${line}`); target.appendLine(line); };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
        },
    });
}

export function positionAt(text: string, offset: number): vscode.Position {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
    }
    return new vscode.Position(line, offset - lineStart);
}

function wordAt(text: string, offset: number): string {
    let s = offset;
    let e = offset;
    while (s > 0 && /[\w$]/.test(text[s - 1])) { s--; }
    while (e < text.length && /[\w$]/.test(text[e])) { e++; }
    return text.substring(s, e);
}

async function readSmall(file: string): Promise<string | null> {
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (!stat || stat.size > MAX_JS_BYTES) { return null; }
    return fs.promises.readFile(file, 'utf8').catch(() => null);
}

function normPath(p: string): string {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
}

function samePath(a: string, b: string): boolean {
    return normPath(a) === normPath(b);
}
