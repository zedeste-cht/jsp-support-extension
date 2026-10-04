/**
 * End-to-end tests with redhat.java (jdt.ls) in the test instance, against
 * test-fixtures/maven-multi (parent + core jar + web war).
 * Verifies navigation into Maven jars (binary only → decompiled), transitive
 * dependencies, sibling modules and the JDK.
 *
 * Run with: JAVA_HOME=<jdk> JSP_TEST_EXTENSIONS_DIR=<dir with redhat.java> npx vscode-test --label jdt
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

let page: vscode.TextDocument;

async function definitionAt(needle: string, delta = 0): Promise<vscode.Location> {
    const idx = page.getText().indexOf(needle);
    assert.ok(idx >= 0, needle);
    const res = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider', page.uri, page.positionAt(idx + delta));
    assert.ok(res?.length, `no definition for ${needle}`);
    const r = res[0];
    return 'targetUri' in r ? new vscode.Location(r.targetUri, r.targetSelectionRange ?? r.targetRange) : r;
}

async function textAt(loc: vscode.Location): Promise<string> {
    return (await vscode.workspace.openTextDocument(loc.uri)).getText(loc.range);
}

suite('JSP go to definition via jdt.ls', function () {
    this.timeout(600000);

    suiteSetup(async () => {
        const java = vscode.extensions.getExtension<{ serverReady(): Promise<boolean>; serverMode: string }>('redhat.java');
        assert.ok(java, 'redhat.java must be installed in the test instance');
        const api = await java.activate();
        await vscode.extensions.getExtension('zedeste.support-jsp')!.activate();

        const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
        page = await vscode.workspace.openTextDocument(path.join(ws, 'web', 'src', 'main', 'webapp', 'views', 'page.jsp'));
        await vscode.window.showTextDocument(page);

        await api.serverReady();
        // Wait until the Maven projects are imported.
        for (let i = 0; i < 120; i++) {
            const projects = await vscode.commands.executeCommand<string[]>('java.execute.workspaceCommand', 'java.project.getAll').then(x => x ?? [], () => []);
            if (projects.length >= 2) { console.log(`imported: ${projects.join(', ')}`); break; }
            await new Promise(r => setTimeout(r, 2000));
        }
    });

    test('class in a sibling module resolves to its source file', async () => {
        const loc = await definitionAt('svc.findName', 4);
        assert.strictEqual(loc.uri.scheme, 'file');
        assert.ok(loc.uri.fsPath.endsWith(path.join('core', 'src', 'main', 'java', 'com', 'acme', 'core', 'UserService.java')), loc.uri.fsPath);
        assert.strictEqual(await textAt(loc), 'findName');
    });

    test('transitive dependency (web → core → commons-lang3) resolves into the jar', async () => {
        const loc = await definitionAt('isBlank', 1);
        assert.strictEqual(loc.uri.scheme, 'jdt', loc.uri.toString());
        assert.ok(decodeURIComponent(loc.uri.toString()).includes('commons-lang3'), loc.uri.toString());
        assert.strictEqual(await textAt(loc), 'isBlank');
    });

    test('implicit object method resolves into servlet-api jar (no sources → decompiled)', async () => {
        const loc = await definitionAt('getSession', 1);
        assert.strictEqual(loc.uri.scheme, 'jdt', loc.uri.toString());
        assert.ok(decodeURIComponent(loc.uri.toString()).includes('javax.servlet-api'), loc.uri.toString());
        assert.strictEqual(await textAt(loc), 'getSession');
    });

    test('method chain continues through jar types', async () => {
        const loc = await definitionAt('getId', 1);
        assert.strictEqual(loc.uri.scheme, 'jdt');
        assert.strictEqual(await textAt(loc), 'getId');
    });

    test('direct dependency static method', async () => {
        const loc = await definitionAt('getTempDirectory', 1);
        assert.strictEqual(loc.uri.scheme, 'jdt');
        assert.ok(decodeURIComponent(loc.uri.toString()).includes('commons-io'), loc.uri.toString());
        assert.strictEqual(await textAt(loc), 'getTempDirectory');
    });

    test('JDK generic types resolve (List<String>.get → String.trim)', async () => {
        const list = await definitionAt('ArrayList<>', 1);
        assert.strictEqual(list.uri.scheme, 'jdt', list.uri.toString());
        assert.strictEqual(await textAt(list), 'ArrayList');
        const trim = await definitionAt('trim', 1);
        assert.strictEqual(trim.uri.scheme, 'jdt');
        assert.strictEqual(await textAt(trim), 'trim');
    });
});
