/**
 * Integration test: Validate that scanForPomFiles discovers Java source paths
 * in complex multi-module Maven project structures, including:
 *   - Deeply nested modules (CORE/MainWebapp, CONNECTORS/ERP/GenConnector)
 *   - Parent POM in a subdirectory (parent-suite/pom.xml)
 *   - Modules NOT declared in any parent POM
 *
 * This test creates a temporary Maven project on disk, runs the same parsing
 * + scanning logic that server.ts uses, and asserts the expected source paths.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Replicate the minimal types / helpers from server.ts ────────────────────

interface JavaSourcePath { modulePath: string; sourcePath: string; }
interface PomInfo { sourceDirectories: string[]; modules: string[]; }
interface MavenDependency { groupId: string; artifactId: string; version: string; }

let javaSourcePaths: JavaSourcePath[] = [];
let mavenDependencies: MavenDependency[] = [];

function parsePomXml(pomPath: string): PomInfo & { dependencies: MavenDependency[] } {
    if (!fs.existsSync(pomPath)) {
        return { sourceDirectories: [], modules: [], dependencies: [] };
    }
    const content = fs.readFileSync(pomPath, 'utf-8');
    const sourceDirectories: string[] = [];
    const modules: string[] = [];
    const dependencies: MavenDependency[] = [];

    const srcDirRe = /<sourceDirectory>(.*?)<\/sourceDirectory>/gs;
    let m;
    while ((m = srcDirRe.exec(content)) !== null) {
        const dir = m[1].trim();
        if (dir) { sourceDirectories.push(dir); }
    }

    const modulesBlockRe = /<modules>([\s\S]*?)<\/modules>/g;
    const modulesBlock = modulesBlockRe.exec(content);
    if (modulesBlock) {
        const moduleRe = /<module>(.*?)<\/module>/g;
        while ((m = moduleRe.exec(modulesBlock[1])) !== null) {
            const mod = m[1].trim();
            if (mod) { modules.push(mod); }
        }
    }

    const depMgmtRe = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
    const contentNoDM = content.replace(depMgmtRe, '');
    const depsRe = /<dependencies>([\s\S]*?)<\/dependencies>/g;
    while ((m = depsRe.exec(contentNoDM)) !== null) {
        const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
        let dm;
        while ((dm = depRe.exec(m[1])) !== null) {
            const depBlock = dm[1];
            const gid = depBlock.match(/<groupId>(.*?)<\/groupId>/)?.[1]?.trim();
            const aid = depBlock.match(/<artifactId>(.*?)<\/artifactId>/)?.[1]?.trim();
            const ver = depBlock.match(/<version>(.*?)<\/version>/)?.[1]?.trim();
            if (gid && aid && ver) {
                dependencies.push({ groupId: gid, artifactId: aid, version: ver });
            }
        }
    }

    if (sourceDirectories.length === 0) {
        sourceDirectories.push('src/main/java');
    }
    return { sourceDirectories, modules, dependencies };
}

function addSourcePathIfNew(modulePath: string, sourcePath: string): void {
    if (!javaSourcePaths.some(p => p.sourcePath === sourcePath)) {
        javaSourcePaths.push({ modulePath, sourcePath });
    }
}

function collectJavaSourcePaths(basePath: string, pomPath: string, configPaths: string[]): void {
    if (!fs.existsSync(pomPath)) {
        const paths = configPaths.length > 0 ? configPaths : ['src/main/java', 'java', 'src', ''];
        for (const relPath of paths) {
            const absPath = path.join(basePath, relPath);
            if (fs.existsSync(absPath)) {
                addSourcePathIfNew(basePath, absPath);
            }
        }
        return;
    }
    const pomInfo = parsePomXml(pomPath);
    for (const relPath of pomInfo.sourceDirectories) {
        const absPath = path.join(basePath, relPath);
        if (fs.existsSync(absPath)) { addSourcePathIfNew(basePath, absPath); }
    }
    for (const dep of pomInfo.dependencies) {
        if (!mavenDependencies.some(d => d.groupId === dep.groupId && d.artifactId === dep.artifactId && d.version === dep.version)) {
            mavenDependencies.push(dep);
        }
    }
    for (const mod of pomInfo.modules) {
        const moduleBase = path.join(basePath, mod);
        collectJavaSourcePaths(moduleBase, path.join(moduleBase, 'pom.xml'), []);
    }
}

const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', '.idea', '.settings', 'bin', '.mvn']);

function scanForPomFiles(dir: string, alreadyDiscovered: Set<string>, configPaths: string[], depth: number = 0): void {
    if (depth > 10) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        if (SCAN_SKIP_DIRS.has(entry.name)) { continue; }

        const subDir = path.join(dir, entry.name);
        const pomPath = path.join(subDir, 'pom.xml');

        if (fs.existsSync(pomPath)) {
            const pomInfo = parsePomXml(pomPath);
            for (const relPath of pomInfo.sourceDirectories) {
                const absPath = path.join(subDir, relPath);
                if (!alreadyDiscovered.has(absPath) && fs.existsSync(absPath)) {
                    addSourcePathIfNew(subDir, absPath);
                    alreadyDiscovered.add(absPath);
                }
            }
            for (const dep of pomInfo.dependencies) {
                if (!mavenDependencies.some(d => d.groupId === dep.groupId && d.artifactId === dep.artifactId && d.version === dep.version)) {
                    mavenDependencies.push(dep);
                }
            }
        }
        scanForPomFiles(subDir, alreadyDiscovered, configPaths, depth + 1);
    }
}

// ── Helpers to build mock project structures ────────────────────────────────

function mkdirp(p: string): void {
    fs.mkdirSync(p, { recursive: true });
}

function writePom(dir: string, opts: { modules?: string[]; deps?: { g: string; a: string; v: string }[] } = {}): void {
    const moduleXml = (opts.modules || []).map(m => `    <module>${m}</module>`).join('\n');
    const depXml = (opts.deps || []).map(d =>
        `    <dependency>\n      <groupId>${d.g}</groupId>\n      <artifactId>${d.a}</artifactId>\n      <version>${d.v}</version>\n    </dependency>`
    ).join('\n');
    const xml = `<project>
${opts.modules?.length ? `  <modules>\n${moduleXml}\n  </modules>` : ''}
${opts.deps?.length ? `  <dependencies>\n${depXml}\n  </dependencies>` : ''}
</project>`;
    fs.writeFileSync(path.join(dir, 'pom.xml'), xml, 'utf-8');
}

function resetState(): void {
    javaSourcePaths = [];
    mavenDependencies = [];
}

function rmrf(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── Test Suite ──────────────────────────────────────────────────────────────

suite('Maven Multi-Module Scanning Tests', () => {
    let tmpRoot: string;

    setup(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsp-maven-test-'));
        resetState();
    });

    teardown(() => {
        rmrf(tmpRoot);
    });

    // ────────────────────────────────────────────────────────────────────
    // Case 1 — Deep nested multi-module (like ppowo's first project)
    //   root/pom.xml -> modules: [CORE]
    //   root/CORE/pom.xml -> modules: [MainWebapp, EJBRemote]
    //   root/CORE/MainWebapp/src/main/java (exists)
    //   root/CORE/EJBRemote/src/main/java  (exists)
    //   root/CONNECTORS/ERPConnector/GenConnector/src/main/java (orphan — not in any module list)
    // ────────────────────────────────────────────────────────────────────

    test('Case 1 — deeply nested modules + orphan module', () => {
        // Build structure
        mkdirp(path.join(tmpRoot, 'CORE', 'MainWebapp', 'src', 'main', 'java'));
        mkdirp(path.join(tmpRoot, 'CORE', 'EJBRemote', 'src', 'main', 'java'));
        mkdirp(path.join(tmpRoot, 'CONNECTORS', 'ERPConnector', 'GenConnector', 'src', 'main', 'java'));

        writePom(tmpRoot, { modules: ['CORE'] });
        writePom(path.join(tmpRoot, 'CORE'), { modules: ['MainWebapp', 'EJBRemote'] });
        writePom(path.join(tmpRoot, 'CORE', 'MainWebapp'));
        writePom(path.join(tmpRoot, 'CORE', 'EJBRemote'));
        // GenConnector has its own pom.xml but is NOT referenced by any parent
        writePom(path.join(tmpRoot, 'CONNECTORS', 'ERPConnector', 'GenConnector'));

        // Phase 1: normal collectJavaSourcePaths (follows <modules>)
        collectJavaSourcePaths(tmpRoot, path.join(tmpRoot, 'pom.xml'), []);

        const afterCollect = javaSourcePaths.map(p => p.sourcePath);
        // Should find MainWebapp and EJBRemote through module recursion
        assert.ok(afterCollect.some(p => p.includes('MainWebapp')), 'MainWebapp found via modules');
        assert.ok(afterCollect.some(p => p.includes('EJBRemote')), 'EJBRemote found via modules');
        // GenConnector is NOT in <modules>, so it should NOT be found yet
        assert.ok(!afterCollect.some(p => p.includes('GenConnector')), 'GenConnector NOT found before scan');

        // Phase 2: scanForPomFiles fallback
        const discovered = new Set(javaSourcePaths.map(p => p.sourcePath));
        scanForPomFiles(tmpRoot, discovered, []);

        const afterScan = javaSourcePaths.map(p => p.sourcePath);
        assert.ok(afterScan.some(p => p.includes('GenConnector')), 'GenConnector found after fallback scan');
    });

    // ────────────────────────────────────────────────────────────────────
    // Case 2 — Parent POM in a subdirectory
    //   root/parent-suite/pom.xml (modules: [../MainWebapp, ../EJBCore])
    //   root/MainWebapp/src/main/java
    //   root/EJBCore/src/main/java
    //
    //   Root has NO pom.xml → collectJavaSourcePaths uses fallback dirs
    //   scanForPomFiles should still find both modules
    // ────────────────────────────────────────────────────────────────────

    test('Case 2 — parent POM in subdirectory', () => {
        mkdirp(path.join(tmpRoot, 'parent-suite'));
        mkdirp(path.join(tmpRoot, 'MainWebapp', 'src', 'main', 'java'));
        mkdirp(path.join(tmpRoot, 'EJBCore', 'src', 'main', 'java'));

        // parent-suite/pom.xml references siblings via relative paths
        // (Note: collectJavaSourcePaths won't follow this because root has no pom.xml)
        writePom(path.join(tmpRoot, 'parent-suite'), { modules: ['../MainWebapp', '../EJBCore'] });
        writePom(path.join(tmpRoot, 'MainWebapp'));
        writePom(path.join(tmpRoot, 'EJBCore'));

        // Phase 1: root has no pom.xml — should fall back to default paths
        collectJavaSourcePaths(tmpRoot, path.join(tmpRoot, 'pom.xml'), []);
        // Root 'src/main/java' doesn't exist, so nothing should be added for root
        // But the subdirs have their own pom.xml which won't be found here

        // Phase 2: scan fallback
        const discovered = new Set(javaSourcePaths.map(p => p.sourcePath));
        scanForPomFiles(tmpRoot, discovered, []);

        const allPaths = javaSourcePaths.map(p => p.sourcePath);
        assert.ok(allPaths.some(p => p.includes('MainWebapp')), 'MainWebapp found via scan');
        assert.ok(allPaths.some(p => p.includes('EJBCore')), 'EJBCore found via scan');
    });

    // ────────────────────────────────────────────────────────────────────
    // Case 3 — Scan should NOT duplicate paths already collected
    // ────────────────────────────────────────────────────────────────────

    test('Case 3 — no duplicates after scan', () => {
        mkdirp(path.join(tmpRoot, 'ModuleA', 'src', 'main', 'java'));

        writePom(tmpRoot, { modules: ['ModuleA'] });
        writePom(path.join(tmpRoot, 'ModuleA'));

        collectJavaSourcePaths(tmpRoot, path.join(tmpRoot, 'pom.xml'), []);

        const countBefore = javaSourcePaths.length;

        const discovered = new Set(javaSourcePaths.map(p => p.sourcePath));
        scanForPomFiles(tmpRoot, discovered, []);

        assert.strictEqual(javaSourcePaths.length, countBefore, 'No duplicates added');
    });

    // ────────────────────────────────────────────────────────────────────
    // Case 4 — Maven dependencies collected from nested modules
    // ────────────────────────────────────────────────────────────────────

    test('Case 4 — dependencies collected from orphan modules', () => {
        mkdirp(path.join(tmpRoot, 'OrphanModule', 'src', 'main', 'java'));

        // Root pom has no modules
        writePom(tmpRoot);
        // OrphanModule has a dependency
        writePom(path.join(tmpRoot, 'OrphanModule'), {
            deps: [{ g: 'com.example', a: 'core-lib', v: '1.0.0' }]
        });

        collectJavaSourcePaths(tmpRoot, path.join(tmpRoot, 'pom.xml'), []);

        // OrphanModule not in <modules>, so dependency NOT collected yet
        assert.ok(!mavenDependencies.some(d => d.artifactId === 'core-lib'),
            'core-lib NOT found before scan');

        const discovered = new Set(javaSourcePaths.map(p => p.sourcePath));
        scanForPomFiles(tmpRoot, discovered, []);

        assert.ok(mavenDependencies.some(d => d.artifactId === 'core-lib'),
            'core-lib found after scan');
    });

    // ────────────────────────────────────────────────────────────────────
    // Case 5 — 'target' directories are skipped
    // ────────────────────────────────────────────────────────────────────

    test('Case 5 — target directories are skipped', () => {
        mkdirp(path.join(tmpRoot, 'target', 'generated-sources', 'src', 'main', 'java'));
        writePom(path.join(tmpRoot, 'target', 'generated-sources'));
        writePom(tmpRoot);

        collectJavaSourcePaths(tmpRoot, path.join(tmpRoot, 'pom.xml'), []);
        const discovered = new Set(javaSourcePaths.map(p => p.sourcePath));
        scanForPomFiles(tmpRoot, discovered, []);

        const allPaths = javaSourcePaths.map(p => p.sourcePath);
        assert.ok(!allPaths.some(p => p.includes('target')),
            'No paths from target directory');
    });
});
