/**
 * End-to-end tests inside VS Code against ../jsptest/servlet_maven_demo
 * (opened as the workspace by .vscode-test.mjs). The test instance has no
 * redhat.java, so this exercises the built-in index path.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const ws = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function definitionAt(rel: string, needle: string, delta = 0, nth = 0): Promise<vscode.Location[]> {
    const doc = await vscode.workspace.openTextDocument(path.join(ws(), rel));
    await vscode.window.showTextDocument(doc);
    let idx = -1;
    for (let i = 0; i <= nth; i++) { idx = doc.getText().indexOf(needle, idx + 1); }
    assert.ok(idx >= 0, `${needle} not in ${rel}`);
    const pos = doc.positionAt(idx + delta);
    const res = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    return (res ?? []).map(r => 'targetUri' in r ? new vscode.Location(r.targetUri, r.targetSelectionRange ?? r.targetRange) : r);
}

async function textAt(loc: vscode.Location): Promise<string> {
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    return doc.getText(loc.range);
}

suite('JSP go to definition (sample project)', function () {
    this.timeout(60000);

    suiteSetup(async () => {
        await vscode.extensions.getExtension('zedeste.support-jsp')!.activate();
    });

    test('module1: static method resolves to module1 class (not root/module2 duplicate)', async () => {
        const [loc] = await definitionAt('module1/webapp/index.jsp', 'getExampleMessage', 1);
        assert.ok(loc, 'definition found');
        assert.ok(loc.uri.fsPath.includes(path.join('module1', 'abc', 'bcd', 'Example.java')), loc.uri.fsPath);
        assert.strictEqual(await textAt(loc), 'getExampleMessage');
    });

    test('module2: same simple name resolves to module2 class', async () => {
        const [loc] = await definitionAt('module2/webapp/index.jsp', 'getExampleMessage', 1);
        assert.ok(loc.uri.fsPath.includes(path.join('module2', 'def', 'abc', 'Example.java')), loc.uri.fsPath);
    });

    test('page import directive resolves to class', async () => {
        const [loc] = await definitionAt('module1/webapp/index.jsp', 'bcd.Example', 5);
        assert.ok(loc.uri.fsPath.endsWith('Example.java'));
        assert.strictEqual(await textAt(loc), 'Example');
    });

    test('inline onclick handler resolves to function in the same page', async () => {
        const [loc] = await definitionAt('module2/webapp/views/test_advanced.jsp', 'onclick="addTodo()"', 10);
        assert.ok(loc.uri.fsPath.endsWith('test_advanced.jsp'));
        assert.strictEqual(await textAt(loc), 'addTodo');
        const line = (await vscode.workspace.openTextDocument(loc.uri)).lineAt(loc.range.start.line).text;
        assert.ok(/function addTodo\(/.test(line), line);
    });

    test('<%! %> method call resolves to its declaration', async () => {
        const [loc] = await definitionAt('module2/webapp/views/test_comprehensive.jsp', 'greet(userName)', 1);
        assert.ok(loc.uri.fsPath.endsWith('test_comprehensive.jsp'));
        const line = (await vscode.workspace.openTextDocument(loc.uri)).lineAt(loc.range.start.line).text;
        assert.ok(/private String greet\(/.test(line), line);
    });
});
