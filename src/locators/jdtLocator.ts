/**
 * Locator backed by the Red Hat Java extension (jdt.ls). jdt.ls already
 * resolves Maven/Gradle multi-module classpaths, downloads sources and
 * decompiles classes without sources, so we only ask it where a type lives.
 */
import * as vscode from 'vscode';
import { ClassLocator, ClassSource } from '../java/classRepository';
import { ProjectModel } from '../project/projectModel';

const TYPE_KINDS = new Set([
    vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum,
    vscode.SymbolKind.Struct,
]);

interface JavaExtensionApi {
    serverMode?: string;
    serverReady?: () => Promise<boolean>;
    onDidServerModeChange?: vscode.Event<string>;
}

export class JdtLocator implements ClassLocator, vscode.Disposable {
    readonly name = 'jdt.ls';
    private ready = false;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly model: () => ProjectModel | undefined, private readonly log: vscode.OutputChannel) {
        void this.connect();
    }

    get isReady(): boolean {
        return this.ready;
    }

    private async connect(): Promise<void> {
        const ext = vscode.extensions.getExtension<JavaExtensionApi>('redhat.java');
        if (!ext) {
            this.log.appendLine('redhat.java not installed – using built-in index only.');
            return;
        }
        try {
            const api = ext.isActive ? ext.exports : await ext.activate();
            if (api.onDidServerModeChange) {
                this.disposables.push(api.onDidServerModeChange(mode => {
                    this.log.appendLine(`jdt.ls server mode: ${mode}`);
                    if (mode === 'Standard') { void this.waitReady(api); }
                }));
            }
            await this.waitReady(api);
        } catch (e) {
            this.log.appendLine(`Could not connect to redhat.java: ${e}`);
        }
    }

    private async waitReady(api: JavaExtensionApi): Promise<void> {
        if (api.serverMode && api.serverMode !== 'Standard') {
            this.log.appendLine(`jdt.ls running in ${api.serverMode} mode – waiting for Standard mode.`);
            return;
        }
        await api.serverReady?.();
        this.ready = true;
        this.log.appendLine('jdt.ls ready – delegating Java type lookup.');
    }

    async locate(fqn: string, fromFile?: string): Promise<ClassSource | null> {
        if (!this.ready) { return null; }
        const lastDot = fqn.lastIndexOf('.');
        const simple = fqn.substring(lastDot + 1);
        const pkg = lastDot > 0 ? fqn.substring(0, lastDot) : '';

        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider', fqn) ?? [];
        // redhat.java's middleware rewrites names of qualified queries to
        // `${containerName}.${name}`, so depending on the server state the name is
        // simple ("List") or qualified (possibly more than once). Compare the last
        // segment only.
        const matches = symbols.filter(s =>
            s.name.substring(s.name.lastIndexOf('.') + 1) === simple && (s.containerName ?? '') === pkg && TYPE_KINDS.has(s.kind)
            && (s.location.uri.scheme === 'jdt' || s.location.uri.scheme === 'file'));
        if (!matches.length) {
            // Same package but an unexpected name shape: worth knowing about.
            const odd = symbols.filter(s => (s.containerName ?? '') === pkg && s.name.endsWith(simple) && TYPE_KINDS.has(s.kind));
            if (odd.length) {
                this.log.appendLine(`jdt.ls: no match for ${fqn} among ${odd.slice(0, 3).map(s => `${s.name} [${s.location.uri.scheme}]`).join(', ')}`);
            }
            return null;
        }

        const model = this.model();
        const ranked = model
            ? model.rank(matches, s => s.location.uri.scheme === 'file' ? s.location.uri.fsPath : undefined, fromFile)
            : matches;
        const uri = ranked[0].location.uri;
        const doc = await vscode.workspace.openTextDocument(uri);
        return { uri: uri.toString(), text: doc.getText() };
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
