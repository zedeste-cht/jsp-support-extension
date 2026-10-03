import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { MavenResolver } from '../../project/maven';
import { ProjectModel } from '../../project/projectModel';
import { IndexLocator } from '../../locators/indexLocator';
import { ZipFile } from '../../util/zip';
import { resolveWebPath } from '../../jsp/webPaths';
import { ROOT } from './helpers';

function write(file: string, text: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function pom(body: string) {
    return `<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>${body}</project>`;
}

function jar(file: string, entries: Record<string, string>) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const z = new AdmZip();
    for (const [name, text] of Object.entries(entries)) { z.addFile(name, Buffer.from(text)); }
    z.writeZip(file);
}

describe('Maven multi-module project', () => {
    let tmp: string;
    let ws: string;
    let repo: string;
    let model: ProjectModel;

    before(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsp-support-test-'));
        ws = path.join(tmp, 'ws');
        repo = path.join(tmp, 'repo');

        // Remote artifacts: lib-a (direct, version from parent property via dependencyManagement)
        // depends on lib-b (transitive). lib-c is excluded. A BOM manages lib-d.
        write(path.join(repo, 'org/lib/lib-a/1.2/lib-a-1.2.pom'), pom(`<groupId>org.lib</groupId><artifactId>lib-a</artifactId><version>1.2</version>
            <dependencies>
              <dependency><groupId>org.lib</groupId><artifactId>lib-b</artifactId><version>2.0</version></dependency>
              <dependency><groupId>org.lib</groupId><artifactId>lib-c</artifactId><version>1.0</version></dependency>
              <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4</version><scope>test</scope></dependency>
            </dependencies>`));
        write(path.join(repo, 'org/lib/lib-b/2.0/lib-b-2.0.pom'), pom('<groupId>org.lib</groupId><artifactId>lib-b</artifactId><version>2.0</version>'));
        write(path.join(repo, 'org/bom/bom/1/bom-1.pom'), pom(`<groupId>org.bom</groupId><artifactId>bom</artifactId><version>1</version><packaging>pom</packaging>
            <dependencyManagement><dependencies>
              <dependency><groupId>org.lib</groupId><artifactId>lib-d</artifactId><version>4.0</version></dependency>
            </dependencies></dependencyManagement>`));
        jar(path.join(repo, 'org/lib/lib-a/1.2/lib-a-1.2-sources.jar'), { 'org/lib/a/A.java': 'package org.lib.a; public class A {}' });
        jar(path.join(repo, 'org/lib/lib-b/2.0/lib-b-2.0.jar'), { 'org/lib/b/B.class': 'x', 'org/lib/b/B.java': 'package org.lib.b; public class B {}' });
        jar(path.join(repo, 'org/lib/lib-d/4.0/lib-d-4.0-sources.jar'), { 'org/lib/d/D.java': 'package org.lib.d; public class D {}' });

        // Workspace: parent with properties + dependencyManagement, two modules,
        // web depends on core; web has custom warSourceDirectory and a self-packaged jar.
        write(path.join(ws, 'pom.xml'), pom(`<groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging>
            <modules><module>core</module><module>web</module></modules>
            <properties><liba.version>1.2</liba.version></properties>
            <dependencyManagement><dependencies>
              <dependency><groupId>org.lib</groupId><artifactId>lib-a</artifactId><version>\${liba.version}</version></dependency>
              <dependency><groupId>org.bom</groupId><artifactId>bom</artifactId><version>1</version><type>pom</type><scope>import</scope></dependency>
            </dependencies></dependencyManagement>`));
        write(path.join(ws, 'core/pom.xml'), pom(`<parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
            <artifactId>core</artifactId>
            <dependencies>
              <dependency><groupId>org.lib</groupId><artifactId>lib-a</artifactId>
                <exclusions><exclusion><groupId>org.lib</groupId><artifactId>lib-c</artifactId></exclusion></exclusions>
              </dependency>
            </dependencies>`));
        write(path.join(ws, 'core/src/main/java/com/acme/core/Service.java'), 'package com.acme.core; public class Service {}');
        write(path.join(ws, 'web/pom.xml'), pom(`<parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
            <artifactId>web</artifactId><packaging>war</packaging>
            <dependencies>
              <dependency><groupId>com.acme</groupId><artifactId>core</artifactId><version>\${project.version}</version></dependency>
              <dependency><groupId>org.lib</groupId><artifactId>lib-d</artifactId></dependency>
              <dependency><groupId>my</groupId><artifactId>own</artifactId><version>1</version><scope>system</scope><systemPath>\${project.basedir}/libs/own.jar</systemPath></dependency>
            </dependencies>
            <build><plugins><plugin><artifactId>maven-war-plugin</artifactId>
              <configuration><warSourceDirectory>web-content</warSourceDirectory></configuration>
            </plugin></plugins></build>`));
        write(path.join(ws, 'web/src/main/java/com/acme/core/Service.java'), 'package com.acme.core; public class Service { /* shadow in web */ }');
        write(path.join(ws, 'web/web-content/WEB-INF/web.xml'), '<web-app/>');
        write(path.join(ws, 'web/web-content/views/page.jsp'), '<%@ include file="/WEB-INF/inc.jspf" %>');
        write(path.join(ws, 'web/web-content/WEB-INF/inc.jspf'), '');
        write(path.join(ws, 'web/web-content/js/app.js'), 'function app() {}');
        jar(path.join(ws, 'web/libs/own.jar'), { 'my/own/Own.java': 'package my.own; public class Own {}' });
        jar(path.join(ws, 'web/web-content/WEB-INF/lib/legacy.jar'), { 'legacy/Old.class': 'x' });
        jar(path.join(ws, 'web/web-content/WEB-INF/lib/legacy-sources.jar'), { 'legacy/Old.java': 'package legacy; public class Old {}' });

        model = await ProjectModel.build({
            workspaceFolders: [ws],
            buildFiles: ['pom.xml', 'core/pom.xml', 'web/pom.xml'].map(p => path.join(ws, p)),
            resolver: new MavenResolver(repo),
        });
    });

    after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('builds modules with source and webapp dirs', () => {
        const web = model.modules.find(m => m.name === 'web')!;
        assert.deepStrictEqual(web.sourceDirs, [path.join(ws, 'web/src/main/java')]);
        assert.deepStrictEqual(web.webappDirs, [path.join(ws, 'web/web-content')]);
        assert.deepStrictEqual(web.dependsOn.map(d => d.name), ['core']);
    });

    it('maps a JSP to its module and webapp root', () => {
        const jsp = path.join(ws, 'web/web-content/views/page.jsp');
        assert.strictEqual(model.moduleOf(jsp)?.name, 'web');
        assert.strictEqual(model.webappRootsFor(jsp)[0], path.join(ws, 'web/web-content'));
        assert.deepStrictEqual(model.modulesInScope(jsp).map(m => m.name), ['web', 'core', 'parent']);
    });

    it('resolves transitive deps with properties, BOM import, exclusions, scopes', () => {
        const deps = model.resolver.resolveTransitive(path.join(ws, 'web/pom.xml'));
        const ids = deps.map(d => `${d.artifactId}:${d.version}`).sort();
        assert.deepStrictEqual(ids, ['core:1.0', 'lib-a:1.2', 'lib-b:2.0', 'lib-d:4.0', 'own:1']);
        assert.ok(deps.find(d => d.artifactId === 'core')?.workspacePom, 'core resolved from the reactor');
        assert.strictEqual(deps.find(d => d.artifactId === 'own')?.systemPath, path.join(ws, 'web', 'libs/own.jar'));
    });

    it('locates classes in module sources first, then jars (sources, systemPath, WEB-INF/lib, binary-with-sources)', async () => {
        const loc = new IndexLocator(() => model, () => undefined);
        const jsp = path.join(ws, 'web/web-content/views/page.jsp');

        const service = await loc.locate('com.acme.core.Service', jsp);
        assert.ok(service?.text.includes('shadow in web'), 'web module wins over core for a JSP in web');
        const fromCore = await loc.locate('com.acme.core.Service', path.join(ws, 'core/x.jsp'));
        assert.ok(!fromCore?.text.includes('shadow'), 'core module sees its own class');

        for (const [fqn, entry] of [
            ['org.lib.a.A', 'lib-a-1.2-sources.jar'],
            ['org.lib.b.B', 'lib-b-2.0.jar'],
            ['org.lib.d.D', 'lib-d-4.0-sources.jar'],
            ['my.own.Own', 'own.jar'],
            ['legacy.Old', 'legacy-sources.jar'],
        ]) {
            const src = await loc.locate(fqn, jsp);
            assert.ok(src, `${fqn} found`);
            assert.ok(src.uri.startsWith('jsp-src:/'), src.uri);
            assert.ok(decodeURIComponent(src.uri).includes(entry), `${fqn} from ${entry}: ${src.uri}`);
            assert.ok(src.text.includes(`class ${fqn.split('.').pop()}`));
        }
        assert.strictEqual(await loc.locate('org.lib.c.C', jsp), null);
    });

    it('resolves web paths (absolute, relative, EL/context prefixes, c:url)', () => {
        const jsp = path.join(ws, 'web/web-content/views/page.jsp');
        const roots = model.webappRootsFor(jsp);
        const app = path.join(ws, 'web/web-content/js/app.js');
        assert.deepStrictEqual(resolveWebPath('/js/app.js', jsp, roots), [app]);
        assert.deepStrictEqual(resolveWebPath('../js/app.js', jsp, roots), [app]);
        assert.deepStrictEqual(resolveWebPath('${pageContext.request.contextPath}/js/app.js?v=1', jsp, roots), [app]);
        assert.deepStrictEqual(resolveWebPath('<%=request.getContextPath()%>/js/app.js', jsp, roots), [app]);
        assert.deepStrictEqual(resolveWebPath(`<c:url value='/js/app.js'/>`, jsp, roots), [app]);
        assert.deepStrictEqual(resolveWebPath('/myapp/js/app.js', jsp, roots), [app]);
        assert.deepStrictEqual(resolveWebPath('/WEB-INF/inc.jspf', jsp, roots), [path.join(ws, 'web/web-content/WEB-INF/inc.jspf')]);
        assert.deepStrictEqual(resolveWebPath('https://cdn/x.js', jsp, roots), []);
    });
});

describe('ZipFile', () => {
    it('lists entries from the central directory and inflates on demand', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsp-zip-'));
        const file = path.join(tmp, 'a.jar');
        jar(file, { 'a/B.java': 'class B { /* 中文 */ }', 'big.txt': 'x'.repeat(100000) });
        const z = await ZipFile.open(file);
        assert.deepStrictEqual([...z.entries.keys()].sort(), ['a/B.java', 'big.txt']);
        assert.strictEqual(await z.readText('a/B.java'), 'class B { /* 中文 */ }');
        assert.strictEqual((await z.readText('big.txt'))!.length, 100000);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});

describe('jsptest sample project', () => {
    const sample = path.resolve(ROOT, '..', 'jsptest', 'servlet_maven_demo');

    it('detects module1/module2 with custom sourceDirectory and webapp dirs', async function () {
        if (!fs.existsSync(sample)) { this.skip(); }
        const buildFiles = ['pom.xml', 'module1/pom.xml', 'module2/pom.xml'].map(p => path.join(sample, p));
        const model = await ProjectModel.build({ workspaceFolders: [sample], buildFiles, resolver: new MavenResolver(path.join(os.tmpdir(), 'no-repo')) });
        const jsp = path.join(sample, 'module2/webapp/views/test_comprehensive.jsp');
        const own = model.moduleOf(jsp)!;
        assert.strictEqual(own.dir, path.join(sample, 'module2'));
        assert.deepStrictEqual(own.sourceDirs, [path.join(sample, 'module2/def')]);
        assert.deepStrictEqual(own.webappDirs, [path.join(sample, 'module2/webapp')]);

        // bcd.Example exists in root/abc and module1/abc: a JSP in module1 must get module1's.
        const loc = new IndexLocator(() => model, () => undefined, ['sources']);
        const m1 = await loc.locate('bcd.Example', path.join(sample, 'module1/webapp/index.jsp'));
        assert.ok(m1?.uri.includes('module1'), m1?.uri);
        const root = await loc.locate('bcd.Example', path.join(sample, 'src/main/webapp/index.jsp'));
        assert.ok(root && !root.uri.includes('module1'), root?.uri);
        const m2 = await loc.locate('abc.Example', path.join(sample, 'module2/webapp/index.jsp'));
        assert.ok(m2?.uri.includes('module2'), m2?.uri);
    });
});
