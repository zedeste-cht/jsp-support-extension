// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	Location,
	Position
} from 'vscode-languageclient/node';
import * as path from 'path';

let client: LanguageClient;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('JSP Language Support extension is now active!');

	// Configuración del servidor de lenguaje
	const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
	
	const serverOptions: ServerOptions = {
		run: {
			module: serverModule,
			transport: TransportKind.ipc
		},
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] }
		}
	};

	// Opciones del cliente
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'jsp' }],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{jsp,jspx,jspf}')
		}
	};

	// Crear el cliente
	client = new LanguageClient(
		'jspLanguageServer',
		'JSP Language Server',
		serverOptions,
		clientOptions
	);

	// Iniciar el cliente y esperar a que esté listo
	await client.start();

	// Registrar el comando Go to Definition
	let disposable = vscode.commands.registerCommand('jsp-support.goToJavaDefinition', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}

		if (!client || !client.isRunning()) {
			vscode.window.showErrorMessage('El servidor de lenguaje JSP no está activo.');
			return;
		}

		const position = editor.selection.active;
		const document = editor.document;

		try {
			// Solicitar la definición al servidor de lenguaje
			const locations = await client.sendRequest('textDocument/definition', {
				textDocument: { uri: document.uri.toString() },
				position: { line: position.line, character: position.character }
			});

			if (locations && Array.isArray(locations) && locations.length > 0) {
				const location = locations[0] as Location;
				const uri = vscode.Uri.parse(location.uri);
				const range = new vscode.Range(
					new vscode.Position(location.range.start.line, location.range.start.character),
					new vscode.Position(location.range.end.line, location.range.end.character)
				);

				// Abrir el archivo y mostrar la definición
				await vscode.window.showTextDocument(uri, { selection: range });
			} else if (locations && !Array.isArray(locations)) {
				const location = locations as Location;
				const uri = vscode.Uri.parse(location.uri);
				const range = new vscode.Range(
					new vscode.Position(location.range.start.line, location.range.start.character),
					new vscode.Position(location.range.end.line, location.range.end.character)
				);

				// Abrir el archivo y mostrar la definición
				await vscode.window.showTextDocument(uri, { selection: range });
			} else {
				vscode.window.showInformationMessage('No se encontró la definición de la clase Java.');
			}
		} catch (error) {
			console.error('Error en Go to Definition:', error);
			vscode.window.showErrorMessage(`Error al buscar la definición: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// Registrar proveedores de funcionalidades
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider('jsp', {
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				const linePrefix = document.lineAt(position).text.substr(0, position.character);
				
				// Autocompletado básico para directivas JSP
				if (linePrefix.endsWith('<%@')) {
					return [
						new vscode.CompletionItem('page', vscode.CompletionItemKind.Keyword),
						new vscode.CompletionItem('include', vscode.CompletionItemKind.Keyword),
						new vscode.CompletionItem('taglib', vscode.CompletionItemKind.Keyword)
					];
				}

				// Autocompletado para atributos de directiva page
				if (linePrefix.includes('<%@ page')) {
					return [
						new vscode.CompletionItem('language="java"', vscode.CompletionItemKind.Property),
						new vscode.CompletionItem('contentType="text/html; charset=UTF-8"', vscode.CompletionItemKind.Property),
						new vscode.CompletionItem('pageEncoding="UTF-8"', vscode.CompletionItemKind.Property),
						new vscode.CompletionItem('import=""', vscode.CompletionItemKind.Property),
						new vscode.CompletionItem('session="true"', vscode.CompletionItemKind.Property)
					];
				}

				return undefined;
			}
		}, '@', '<')
	);

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export async function deactivate(): Promise<void> {
	if (client) {
		return client.stop();
	}
}
