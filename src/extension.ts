import * as vscode from 'vscode';
import { JspSupport } from './jspSupport';
import { JspDefinitionProvider } from './providers/definitionProvider';
import { JspCompletionProvider } from './providers/completionProvider';
import { JAR_SCHEME } from './locators/indexLocator';
import { ZipFile } from './util/zip';

const SELECTOR: vscode.DocumentSelector = [{ language: 'jsp', scheme: 'file' }, { language: 'jsp', scheme: 'untitled' }];

export function activate(context: vscode.ExtensionContext): void {
    const support = new JspSupport(context);

    context.subscriptions.push(
        support,
        vscode.languages.registerDefinitionProvider(SELECTOR, new JspDefinitionProvider(support)),
        vscode.languages.registerCompletionItemProvider(SELECTOR, new JspCompletionProvider(support), '@', '<', ':'),
        // Read-only view of sources inside jars / src.zip (fallback when jdt.ls is absent).
        vscode.workspace.registerTextDocumentContentProvider(JAR_SCHEME, {
            async provideTextDocumentContent(uri) {
                const zip = await ZipFile.open(uri.query);
                return (await zip.readText(uri.path.replace(/^\//, ''))) ?? '';
            },
        }),
        vscode.commands.registerCommand('jsp-support.goToJavaDefinition', () =>
            vscode.commands.executeCommand('editor.action.revealDefinition')),
        vscode.commands.registerCommand('jsp-support.showLog', () => support.log.show()),
    );
}

export function deactivate(): void { /* disposables handle cleanup */ }
