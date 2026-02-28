import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    TextDocumentSyncKind,
    InitializeResult,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    Definition,
    Location,
    Range,
    Position,
} from 'vscode-languageserver/node';

import { TextDocument as TextDocumentContent } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import AdmZip from 'adm-zip';
import {
    getLanguageService as getHTMLLanguageService,
    LanguageService as HTMLLanguageService,
    CompletionConfiguration
} from 'vscode-html-languageservice';

// ─── Connection & Documents ─────────────────────────────────────────────────
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocumentContent> = new TextDocuments(TextDocumentContent);
const htmlLanguageService: HTMLLanguageService = getHTMLLanguageService();

// ─── Types ──────────────────────────────────────────────────────────────────
interface JavaSourcePath {
    modulePath: string;
    sourcePath: string;
}

interface PomInfo {
    sourceDirectories: string[];
    modules: string[];
}

interface MavenDependency {
    groupId: string;
    artifactId: string;
    version: string;
}

interface VariableDeclaration {
    name: string;
    type: string;
}

interface DocumentCache {
    version: number;
    variables: VariableDeclaration[];
    imports: Map<string, string>; // simpleName -> fullyQualifiedName
}

// ─── State ──────────────────────────────────────────────────────────────────
let workspaceFolders: string[] = [];
let javaSourcePaths: JavaSourcePath[] = [];
let mavenDependencies: MavenDependency[] = [];
let mavenRepoPath: string = '';
let javaHomePath: string = '';

// Caches
const documentCaches = new Map<string, DocumentCache>();
// Cache: fullyQualifiedClassName -> { jarPath, entryName } for sources.jar lookups
const sourceJarClassCache = new Map<string, { jarPath: string; entryName: string } | null>();
// Cache: zip path -> AdmZip instance (avoid re-opening the same archive)
const zipCache = new Map<string, AdmZip>();
// Cache: extracted temp files for opening in editor
const extractedFileCache = new Map<string, string>();
// Temp dir for extracted sources
let tempDir: string = '';

// ─── Initialization ─────────────────────────────────────────────────────────
connection.onInitialize((params: InitializeParams) => {
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['@', '<', ' ', '"', ':', '/', '.', '>', '/']
            },
            definitionProvider: true
        }
    };

    // Setup temp directory
    tempDir = path.join(os.tmpdir(), 'jsp-support-sources');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // Parse workspace folders
    if (params.workspaceFolders) {
        workspaceFolders = params.workspaceFolders.map(folder => uriToFsPath(folder.uri));
        console.log('Workspace folders:', workspaceFolders);

        // Resolve JAVA_HOME
        javaHomePath = params.initializationOptions?.javaHome
            || process.env.JAVA_HOME || '';
        console.log('JAVA_HOME:', javaHomePath);

        // Resolve Maven repo
        mavenRepoPath = params.initializationOptions?.mavenRepository
            || path.join(os.homedir(), '.m2', 'repository');
        console.log('Maven repository:', mavenRepoPath);

        // Collect Java source paths and Maven dependencies
        const javaSourcePathsConfig: string[] = params.initializationOptions?.javaSourcePaths || [];
        javaSourcePaths = [];
        mavenDependencies = [];

        for (const folder of workspaceFolders) {
            collectJavaSourcePaths(folder, path.join(folder, 'pom.xml'), javaSourcePathsConfig);
        }

        // Fallback: scan for any pom.xml files not yet discovered
        // This handles cases like:
        //   - Parent POM in a subdirectory (e.g. parent-suite/pom.xml)
        //   - Deeply nested multi-module Maven projects
        //   - Modules not referenced in parent POM's <modules>
        const discoveredPaths = new Set(javaSourcePaths.map(p => p.sourcePath));
        for (const folder of workspaceFolders) {
            scanForPomFiles(folder, discoveredPaths, javaSourcePathsConfig);
        }

        console.log('All Java source paths:', javaSourcePaths);
        console.log('All Maven dependencies:', mavenDependencies.length);
    }

    return result;
});

// ─── Utility Functions ──────────────────────────────────────────────────────

function uriToFsPath(uri: string): string {
    if (uri.startsWith('file://')) {
        try {
            return fileURLToPath(uri);
        } catch {
            let decoded = decodeURIComponent(uri).replace(/^file:\/\//i, '');
            if (/^\/[a-zA-Z]:/.test(decoded)) {
                decoded = decoded.slice(1);
            }
            return decoded;
        }
    }
    return uri;
}

function getZip(zipPath: string): AdmZip | null {
    if (zipCache.has(zipPath)) {
        return zipCache.get(zipPath)!;
    }
    try {
        if (!fs.existsSync(zipPath)) { return null; }
        const zip = new AdmZip(zipPath);
        zipCache.set(zipPath, zip);
        return zip;
    } catch (e) {
        console.error('Error opening zip:', zipPath, e);
        return null;
    }
}

// ─── POM Parsing ────────────────────────────────────────────────────────────

function parsePomXml(pomPath: string): PomInfo & { dependencies: MavenDependency[] } {
    if (!fs.existsSync(pomPath)) {
        return { sourceDirectories: [], modules: [], dependencies: [] };
    }
    try {
        const content = fs.readFileSync(pomPath, 'utf-8');
        const sourceDirectories: string[] = [];
        const modules: string[] = [];
        const dependencies: MavenDependency[] = [];

        // Extract <sourceDirectory>
        const srcDirRe = /<sourceDirectory>(.*?)<\/sourceDirectory>/gs;
        let m;
        while ((m = srcDirRe.exec(content)) !== null) {
            const dir = m[1].trim();
            if (dir) { sourceDirectories.push(dir); }
        }

        // Extract <modules>
        const modulesBlockRe = /<modules>([\s\S]*?)<\/modules>/g;
        const modulesBlock = modulesBlockRe.exec(content);
        if (modulesBlock) {
            const moduleRe = /<module>(.*?)<\/module>/g;
            while ((m = moduleRe.exec(modulesBlock[1])) !== null) {
                const mod = m[1].trim();
                if (mod) { modules.push(mod); }
            }
        }

        // Extract <dependencies> (skip dependencyManagement)
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
    } catch (error) {
        console.error('Error parsing pom.xml:', error);
        return { sourceDirectories: ['src/main/java'], modules: [], dependencies: [] };
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
        if (fs.existsSync(absPath)) {
            addSourcePathIfNew(basePath, absPath);
        }
    }

    // Collect Maven dependencies (deduplicate)
    for (const dep of pomInfo.dependencies) {
        if (!mavenDependencies.some(d => d.groupId === dep.groupId && d.artifactId === dep.artifactId && d.version === dep.version)) {
            mavenDependencies.push(dep);
        }
    }

    // Recurse into sub-modules
    for (const mod of pomInfo.modules) {
        const moduleBase = path.join(basePath, mod);
        collectJavaSourcePaths(moduleBase, path.join(moduleBase, 'pom.xml'), []);
    }
}

function addSourcePathIfNew(modulePath: string, sourcePath: string): void {
    if (!javaSourcePaths.some(p => p.sourcePath === sourcePath)) {
        javaSourcePaths.push({ modulePath, sourcePath });
    }
}

/** Directories to skip when scanning for pom.xml files */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', '.idea', '.settings', 'bin', '.mvn']);

/**
 * Recursively scan a directory for pom.xml files that were not already
 * discovered through the normal module-recursion path.
 * This serves as a fallback for:
 *   - Parent POM located in a subdirectory
 *   - Deeply nested multi-module projects
 *   - Modules not declared in any parent POM
 */
function scanForPomFiles(dir: string, alreadyDiscovered: Set<string>, configPaths: string[], depth: number = 0): void {
    // Safety: limit recursion depth to avoid traversing enormous trees
    if (depth > 10) { return; }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        if (SCAN_SKIP_DIRS.has(entry.name)) { continue; }

        const subDir = path.join(dir, entry.name);
        const pomPath = path.join(subDir, 'pom.xml');

        if (fs.existsSync(pomPath)) {
            const pomInfo = parsePomXml(pomPath);

            // Add source directories from this pom if not already discovered
            for (const relPath of pomInfo.sourceDirectories) {
                const absPath = path.join(subDir, relPath);
                if (!alreadyDiscovered.has(absPath) && fs.existsSync(absPath)) {
                    addSourcePathIfNew(subDir, absPath);
                    alreadyDiscovered.add(absPath);
                }
            }

            // Collect Maven dependencies (deduplicate)
            for (const dep of pomInfo.dependencies) {
                if (!mavenDependencies.some(d => d.groupId === dep.groupId && d.artifactId === dep.artifactId && d.version === dep.version)) {
                    mavenDependencies.push(dep);
                }
            }
        }

        // Continue scanning deeper
        scanForPomFiles(subDir, alreadyDiscovered, configPaths, depth + 1);
    }
}

// ─── Document Caching ───────────────────────────────────────────────────────

function getDocCache(doc: TextDocumentContent): DocumentCache {
    const uri = doc.uri;
    const existing = documentCaches.get(uri);
    if (existing && existing.version === doc.version) {
        return existing;
    }

    const text = doc.getText();
    const variables = parseVariableDeclarations(text);
    const imports = parseImports(text);
    const cache: DocumentCache = { version: doc.version, variables, imports };
    documentCaches.set(uri, cache);
    return cache;
}

function parseImports(text: string): Map<string, string> {
    const imports = new Map<string, string>();

    // JSP import directives: <%@page import="com.A,com.B" %>
    // Handle multi-line directives by scanning the whole text
    const jspImportRe = /<%@\s*page[\s\S]*?import="([^"]*?)"\s*[\s\S]*?%>/g;
    let m;
    while ((m = jspImportRe.exec(text)) !== null) {
        const importList = m[1];
        for (const entry of importList.split(',')) {
            const fqn = entry.trim().replace(/\s+/g, '');
            if (fqn) {
                const simpleName = fqn.split('.').pop()!;
                if (simpleName !== '*') {
                    imports.set(simpleName, fqn);
                }
            }
        }
    }

    // Java-style imports inside scriptlets: import com.example.MyClass;
    const javaImportRe = /\bimport\s+([\w.]+)\s*;/g;
    while ((m = javaImportRe.exec(text)) !== null) {
        const fqn = m[1];
        const simpleName = fqn.split('.').pop()!;
        if (simpleName !== '*') {
            imports.set(simpleName, fqn);
        }
    }

    return imports;
}

function parseVariableDeclarations(text: string): VariableDeclaration[] {
    const declarations: VariableDeclaration[] = [];
    const scriptletRe = /<%[\s\S]*?%>/g;
    let block;

    while ((block = scriptletRe.exec(text)) !== null) {
        const content = block[0];

        // Type var = ...
        const declRe = /([A-Z][\w]*(?:\.[A-Z][\w]*)*)\s+([a-z][\w]*)\s*=/g;
        let m;
        while ((m = declRe.exec(content)) !== null) {
            declarations.push({ name: m[2], type: m[1] });
        }

        // for (Type var : collection)
        const forRe = /for\s*\(\s*([A-Z][\w]*(?:\.[A-Z][\w]*)*)\s+([a-z][\w]*)\s*:/g;
        while ((m = forRe.exec(content)) !== null) {
            declarations.push({ name: m[2], type: m[1] });
        }
    }

    return declarations;
}

// ─── Class Resolution ───────────────────────────────────────────────────────

/**
 * Directly resolve a .java file by package path (no recursive search).
 * e.g. "com.example.MyClass" -> srcPath/com/example/MyClass.java
 */
function resolveJavaFileDirect(srcPath: string, fqn: string): string | null {
    const relativePath = fqn.replace(/\./g, path.sep) + '.java';
    const fullPath = path.join(srcPath, relativePath);
    if (fs.existsSync(fullPath)) {
        return fullPath;
    }
    return null;
}

/**
 * Find the line number (0-based) where a class/interface/enum is defined.
 */
function findClassLine(content: string, simpleClassName: string): number {
    const lines = content.split('\n');
    const re = new RegExp(`\\b(?:class|interface|enum)\\s+${simpleClassName}\\b`);
    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
            return i;
        }
    }
    return -1;
}

/**
 * Find a method definition in Java source content.
 */
function findMethodLine(content: string, simpleClassName: string, methodName: string, paramCount: number): { line: number; col: number } | null {
    const lines = content.split('\n');
    const classRe = new RegExp(`\\b(?:class|interface|enum)\\s+${simpleClassName}\\b`);
    let inClass = false;
    let bracketCount = 0;
    let bestMatch: { line: number; col: number; paramDiff: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (!inClass) {
            if (classRe.test(line)) {
                inClass = true;
                bracketCount = 0;
            }
            continue;
        }

        for (const ch of line) {
            if (ch === '{') { bracketCount++; }
            else if (ch === '}') { bracketCount--; }
        }
        if (bracketCount < 0) { break; }

        const methodRe = new RegExp(`\\b${methodName}\\s*\\(`);
        const match = methodRe.exec(line);
        if (match) {
            let fullSig = line.substring(match.index);
            let j = i;
            while (!fullSig.includes(')') && j < lines.length - 1) {
                j++;
                fullSig += ' ' + lines[j];
            }
            const paramStr = fullSig.substring(fullSig.indexOf('(') + 1, fullSig.indexOf(')'));
            const params = paramStr.trim() ? paramStr.split(',').length : 0;
            const diff = Math.abs(params - paramCount);

            if (diff === 0) {
                return { line: i, col: match.index };
            }
            if (!bestMatch || diff < bestMatch.paramDiff) {
                bestMatch = { line: i, col: match.index, paramDiff: diff };
            }
        }
    }

    return bestMatch ? { line: bestMatch.line, col: bestMatch.col } : null;
}

/**
 * Sort source paths to prioritize the module containing the current file.
 */
function sortSourcePaths(currentFileUri: string | undefined): JavaSourcePath[] {
    if (!currentFileUri || !currentFileUri.startsWith('file://')) {
        return javaSourcePaths;
    }
    try {
        const currentFilePath = fileURLToPath(currentFileUri);
        return [...javaSourcePaths].sort((a, b) => {
            const aIn = currentFilePath.startsWith(a.modulePath);
            const bIn = currentFilePath.startsWith(b.modulePath);
            if (aIn && !bIn) { return -1; }
            if (!aIn && bIn) { return 1; }
            return b.modulePath.length - a.modulePath.length;
        });
    } catch {
        return javaSourcePaths;
    }
}

// ─── Go to Definition: Workspace Sources ────────────────────────────────────

async function findJavaDefinition(className: string, currentFileUri?: string): Promise<Location | null> {
    console.log('findJavaDefinition:', className);
    const simpleClass = className.split('.').pop()!;
    const sorted = sortSourcePaths(currentFileUri);

    for (const srcInfo of sorted) {
        const filePath = resolveJavaFileDirect(srcInfo.sourcePath, className);
        if (!filePath) { continue; }

        const content = fs.readFileSync(filePath, 'utf-8');

        // Verify package matches if FQN was given
        if (className.includes('.')) {
            const expectedPkg = className.substring(0, className.lastIndexOf('.'));
            const pkgMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
            const actualPkg = pkgMatch ? pkgMatch[1] : '';
            if (actualPkg !== expectedPkg) { continue; }
        }

        const line = findClassLine(content, simpleClass);
        if (line >= 0) {
            const lineText = content.split('\n')[line];
            const col = lineText.indexOf(simpleClass);
            return Location.create(
                pathToFileURL(filePath).toString(),
                Range.create(Position.create(line, col >= 0 ? col : 0), Position.create(line, (col >= 0 ? col : 0) + simpleClass.length))
            );
        }
    }

    return null;
}

async function findJavaMethodDefinition(className: string, methodName: string, paramCount: number, currentFileUri?: string): Promise<Location | null> {
    console.log('findJavaMethodDefinition:', className, methodName, paramCount);
    const simpleClass = className.split('.').pop()!;
    const sorted = sortSourcePaths(currentFileUri);

    for (const srcInfo of sorted) {
        const filePath = resolveJavaFileDirect(srcInfo.sourcePath, className);
        if (!filePath) { continue; }

        const content = fs.readFileSync(filePath, 'utf-8');
        const result = findMethodLine(content, simpleClass, methodName, paramCount);
        if (result) {
            return Location.create(
                pathToFileURL(filePath).toString(),
                Range.create(Position.create(result.line, result.col), Position.create(result.line, result.col + methodName.length))
            );
        }
    }

    return null;
}

// ─── Go to Definition: Maven Sources JAR ────────────────────────────────────

function getSourcesJarPath(dep: MavenDependency): string {
    const groupPath = dep.groupId.replace(/\./g, path.sep);
    return path.join(mavenRepoPath, groupPath, dep.artifactId, dep.version,
        `${dep.artifactId}-${dep.version}-sources.jar`);
}

/**
 * Find which sources.jar contains a given fully qualified class name.
 */
function findClassInSourcesJars(fqn: string): { jarPath: string; entryName: string } | null {
    if (sourceJarClassCache.has(fqn)) {
        return sourceJarClassCache.get(fqn)!;
    }

    const entryName = fqn.replace(/\./g, '/') + '.java';

    for (const dep of mavenDependencies) {
        const jarPath = getSourcesJarPath(dep);
        const zip = getZip(jarPath);
        if (!zip) { continue; }

        const entry = zip.getEntry(entryName);
        if (entry) {
            const result = { jarPath, entryName };
            sourceJarClassCache.set(fqn, result);
            return result;
        }
    }

    sourceJarClassCache.set(fqn, null);
    return null;
}

/**
 * Extract a Java source from a zip/jar to a temp file and return its path.
 */
function extractSourceToTemp(zipPath: string, entryName: string): string | null {
    const cacheKey = `${zipPath}::${entryName}`;
    if (extractedFileCache.has(cacheKey)) {
        const cached = extractedFileCache.get(cacheKey)!;
        if (fs.existsSync(cached)) { return cached; }
    }

    const zip = getZip(zipPath);
    if (!zip) { return null; }

    const entry = zip.getEntry(entryName);
    if (!entry) { return null; }

    try {
        const content = zip.readAsText(entry);
        const outPath = path.join(tempDir, path.basename(zipPath, '.jar'), entryName.replace(/\//g, path.sep));
        const outDir = path.dirname(outPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }
        fs.writeFileSync(outPath, content, 'utf-8');
        extractedFileCache.set(cacheKey, outPath);
        return outPath;
    } catch (e) {
        console.error('Error extracting source:', e);
        return null;
    }
}

async function findDefinitionInSourcesJar(fqn: string, methodName?: string, paramCount?: number): Promise<Location | null> {
    const found = findClassInSourcesJars(fqn);
    if (!found) { return null; }

    const extracted = extractSourceToTemp(found.jarPath, found.entryName);
    if (!extracted) { return null; }

    const content = fs.readFileSync(extracted, 'utf-8');
    const simpleClass = fqn.split('.').pop()!;
    const uri = pathToFileURL(extracted).toString();

    if (methodName) {
        const result = findMethodLine(content, simpleClass, methodName, paramCount ?? 0);
        if (result) {
            return Location.create(uri,
                Range.create(Position.create(result.line, result.col), Position.create(result.line, result.col + methodName.length)));
        }
    }

    const line = findClassLine(content, simpleClass);
    if (line >= 0) {
        const lineText = content.split('\n')[line];
        const col = lineText.indexOf(simpleClass);
        return Location.create(uri,
            Range.create(Position.create(line, col >= 0 ? col : 0), Position.create(line, (col >= 0 ? col : 0) + simpleClass.length)));
    }

    return null;
}

// ─── Go to Definition: JDK src.zip ──────────────────────────────────────────

function getJdkSrcZipPath(): string | null {
    if (!javaHomePath) { return null; }
    const srcZip = path.join(javaHomePath, 'lib', 'src.zip');
    return fs.existsSync(srcZip) ? srcZip : null;
}

function isJdkClass(fqn: string): boolean {
    return /^(java\.|javax\.|sun\.|com\.sun\.|jdk\.|org\.w3c\.|org\.xml\.)/.test(fqn);
}

async function findDefinitionInJdkSrc(fqn: string, methodName?: string, paramCount?: number): Promise<Location | null> {
    const srcZip = getJdkSrcZipPath();
    if (!srcZip) { return null; }

    const relativePath = fqn.replace(/\./g, '/') + '.java';
    const zip = getZip(srcZip);
    if (!zip) { return null; }

    // JDK src.zip has module prefixes like java.base/java/lang/String.java
    let matchedEntry: string | null = null;
    for (const entry of zip.getEntries()) {
        if (entry.entryName.endsWith(relativePath)) {
            matchedEntry = entry.entryName;
            break;
        }
    }
    if (!matchedEntry) { return null; }

    const extracted = extractSourceToTemp(srcZip, matchedEntry);
    if (!extracted) { return null; }

    const content = fs.readFileSync(extracted, 'utf-8');
    const simpleClass = fqn.split('.').pop()!;
    const uri = pathToFileURL(extracted).toString();

    if (methodName) {
        const result = findMethodLine(content, simpleClass, methodName, paramCount ?? 0);
        if (result) {
            return Location.create(uri,
                Range.create(Position.create(result.line, result.col), Position.create(result.line, result.col + methodName.length)));
        }
    }

    const line = findClassLine(content, simpleClass);
    if (line >= 0) {
        const lineText = content.split('\n')[line];
        const col = lineText.indexOf(simpleClass);
        return Location.create(uri,
            Range.create(Position.create(line, col >= 0 ? col : 0), Position.create(line, (col >= 0 ? col : 0) + simpleClass.length)));
    }

    return null;
}

// ─── Unified Definition Search ──────────────────────────────────────────────

/**
 * Search across all sources in priority order:
 * 1. Workspace source files
 * 2. Maven sources.jar
 * 3. JDK src.zip
 */
async function findDefinitionAnywhere(fqn: string, currentFileUri?: string, methodName?: string, paramCount?: number): Promise<Location | null> {
    // 1. Workspace sources
    if (methodName) {
        const wsMethod = await findJavaMethodDefinition(fqn, methodName, paramCount ?? 0, currentFileUri);
        if (wsMethod) { return wsMethod; }
    }
    const wsClass = await findJavaDefinition(fqn, currentFileUri);
    if (wsClass) { return wsClass; }

    // 2. Maven sources.jar
    const mavenResult = await findDefinitionInSourcesJar(fqn, methodName, paramCount);
    if (mavenResult) { return mavenResult; }

    // 3. JDK src.zip
    const jdkResult = await findDefinitionInJdkSrc(fqn, methodName, paramCount);
    if (jdkResult) { return jdkResult; }

    return null;
}

// ─── Word / Context Analysis ────────────────────────────────────────────────

/**
 * Unified word extraction at cursor position.
 * @param includeBrackets whether to include () characters (for method call detection)
 */
function getWordAtOffset(text: string, offset: number, includeBrackets: boolean = false): string {
    let start = offset;
    let end = offset;

    const charRe = includeBrackets ? /[A-Za-z0-9_.()]/ : /[A-Za-z0-9_.]/;

    while (start > 0 && charRe.test(text[start - 1])) { start--; }
    while (end < text.length && /[A-Za-z0-9_.]/.test(text[end])) { end++; }

    const fullWord = text.substring(start, end);

    // Check if inside an import statement
    const prefix = text.slice(Math.max(0, start - 50), start);
    const importMatch = prefix.match(/import\s+([^;]*?)$/);
    if (importMatch) { return importMatch[1] + fullWord; }

    const jspImportMatch = prefix.match(/<%@\s*page\s+import="([^"]*?)$/);
    if (jspImportMatch) { return jspImportMatch[1] + fullWord; }

    return fullWord;
}

/**
 * Split "ClassName.methodName" or "pkg.Class.method(args)" into class + method parts.
 */
function splitClassMethod(fullPath: string): { className: string; methodName: string } {
    if (!fullPath || !fullPath.includes('.')) {
        return { className: fullPath.split('(')[0], methodName: '' };
    }

    const lastDot = fullPath.lastIndexOf('.');
    const methodPart = fullPath.substring(lastDot + 1).split('(')[0];
    let classPart = fullPath.substring(0, lastDot);

    const parenIdx = classPart.indexOf('(');
    if (parenIdx !== -1) {
        classPart = classPart.substring(0, parenIdx);
    }

    return { className: classPart, methodName: methodPart };
}

/**
 * Count parameters in a method call from the opening parenthesis position.
 */
function countMethodParams(text: string, openParenPos: number): number {
    let depth = 0;
    let hasContent = false;
    let paramCount = 0;
    let inString = false;
    let strChar = '';

    for (let i = openParenPos + 1; i < text.length; i++) {
        const ch = text[i];
        const prev = i > 0 ? text[i - 1] : '';

        if ((ch === '"' || ch === "'") && prev !== '\\') {
            if (!inString) { inString = true; strChar = ch; }
            else if (ch === strChar) { inString = false; }
            hasContent = true;
            continue;
        }
        if (inString) { hasContent = true; continue; }

        if (ch === '(' || ch === '[' || ch === '{') { depth++; hasContent = true; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) { return hasContent ? paramCount + 1 : 0; }
            depth--;
            hasContent = true;
            continue;
        }
        if (ch === ',' && depth === 0) { paramCount++; hasContent = true; continue; }
        if (!/\s/.test(ch)) { hasContent = true; }
    }
    return 0;
}

// ─── JavaScript Function Search (same page) ────────────────────────────────

function findJavaScriptFunction(text: string, functionName: string): Range | null {
    const lines = text.split('\n');
    const patterns = [
        new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`),
        new RegExp(`\\b(?:var|let|const)\\s+${functionName}\\s*=\\s*function\\s*\\(`),
        new RegExp(`\\b${functionName}\\s*:\\s*function\\s*\\(`),
        new RegExp(`\\b(?:const|let|var)\\s+${functionName}\\s*=\\s*\\([^)]*\\)\\s*=>`),
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of patterns) {
            if (pattern.test(line)) {
                const col = line.indexOf(functionName);
                if (col >= 0) {
                    return Range.create(Position.create(i, col), Position.create(i, col + functionName.length));
                }
            }
        }
    }
    return null;
}

// ─── onDefinition Handler ───────────────────────────────────────────────────

connection.onDefinition(
    async (params: TextDocumentPositionParams): Promise<Definition | null> => {
        const document = documents.get(params.textDocument.uri);
        if (!document) { return null; }

        const text = document.getText();
        const offset = document.offsetAt(params.position);
        const cache = getDocCache(document);

        // ── Step 1: Check if cursor is inside a JSP import directive ──
        const jspImportResult = await tryResolveJspImport(text, offset, params.textDocument.uri);
        if (jspImportResult !== undefined) { return jspImportResult; }

        // ── Step 2: Get the word at cursor ──
        const word = getWordAtOffset(text, offset);
        if (!word) { return null; }

        console.log('Word at cursor:', word);

        // ── Step 3: Handle dotted expressions (method calls / FQN) ──
        if (word.includes('.')) {
            return await handleDottedExpression(word, text, offset, params, cache);
        }

        // ── Step 4: Simple class name — resolve via imports ──
        if (/^[A-Z][\w]*$/.test(word)) {
            const fqn = cache.imports.get(word);
            if (fqn) {
                const result = await findDefinitionAnywhere(fqn, params.textDocument.uri);
                if (result) { return result; }
            }
            // Try direct search in workspace sources
            const wsResult = await findJavaDefinition(word, params.textDocument.uri);
            if (wsResult) { return wsResult; }
        }

        // ── Step 5: JavaScript function in same page ──
        if (!word.includes('.')) {
            const jsRange = findJavaScriptFunction(text, word);
            if (jsRange) {
                return Location.create(params.textDocument.uri, jsRange);
            }
        }

        return null;
    }
);

/**
 * Handle cursor inside a JSP <%@page import="..." %> directive.
 * Returns Location or null if found/not-found, or undefined if cursor is not in an import.
 */
async function tryResolveJspImport(text: string, offset: number, uri: string): Promise<Location | null | undefined> {
    const maxRange = 300;
    let start = -1;
    for (let i = offset; i >= Math.max(0, offset - maxRange); i--) {
        if (text.substring(i, i + 2) === '<%') { start = i; break; }
    }
    let end = -1;
    for (let i = offset; i < Math.min(text.length, offset + maxRange); i++) {
        if (text.substring(i, i + 2) === '%>') { end = i + 2; break; }
    }

    if (start === -1 || end === -1 || start >= end) { return undefined; }

    const block = text.substring(start, end);
    const importRe = /<%@\s*page[\s\S]*?import="([^"]*?)"/;
    const match = block.match(importRe);
    if (!match) { return undefined; }

    const importContent = match[1];
    const relOffset = (offset - start) - block.indexOf(importContent);

    let pkgStart = importContent.lastIndexOf(',', relOffset - 1);
    pkgStart = pkgStart === -1 ? 0 : pkgStart + 1;

    let pkgEnd = importContent.indexOf(',', relOffset);
    if (pkgEnd === -1) { pkgEnd = importContent.length; }

    const selectedPkg = importContent.substring(pkgStart, pkgEnd).trim().replace(/\s+/g, '');
    if (!selectedPkg) { return undefined; }

    console.log('JSP import selected:', selectedPkg);
    return await findDefinitionAnywhere(selectedPkg, uri);
}

/**
 * Handle a dotted expression like "ClassName.method" or "variable.method" or "com.pkg.Class".
 */
async function handleDottedExpression(
    word: string,
    text: string,
    offset: number,
    params: TextDocumentPositionParams,
    cache: DocumentCache
): Promise<Location | null> {
    const uri = params.textDocument.uri;
    const parts = word.split('.');
    const firstPart = parts[0];

    // Case A: First part starts with uppercase — could be Class.method or FQN
    if (/^[A-Z]/.test(firstPart)) {
        // Try as FQN class first
        const fqnResult = await findDefinitionAnywhere(word, uri);
        if (fqnResult) { return fqnResult; }

        // Try as Class.method
        if (parts.length >= 2) {
            const { className, methodName } = splitClassMethod(word);
            const fqn = cache.imports.get(className) || className;
            return await resolveMethodCall(fqn, methodName, text, offset, uri);
        }
    }

    // Case B: First part is lowercase — likely variable.method
    if (/^[a-z]/.test(firstPart)) {
        const varDecl = cache.variables.find(v => v.name === firstPart);
        if (varDecl) {
            const methodName = parts.length >= 2 ? parts[parts.length - 1] : '';
            const fqn = cache.imports.get(varDecl.type) || varDecl.type;
            if (methodName) {
                return await resolveMethodCall(fqn, methodName, text, offset, uri);
            } else {
                return await findDefinitionAnywhere(fqn, uri);
            }
        }
    }

    // Case C: Starts with a dot — likely chained method call
    if (word.startsWith('.')) {
        const wordWithBracket = getWordAtOffset(text, offset, true);
        const { className, methodName } = splitClassMethod(wordWithBracket);
        if (className && methodName) {
            const fqn = cache.imports.get(className) || className;
            return await resolveMethodCall(fqn, methodName, text, offset, uri);
        }
    }

    return null;
}

/**
 * Resolve a method call by finding parameter count near cursor, then searching all sources.
 */
async function resolveMethodCall(className: string, methodName: string, text: string, offset: number, uri: string): Promise<Location | null> {
    const escapedClass = className.replace(/\./g, '\\.');
    const callRe = new RegExp(`${escapedClass}[.]${methodName}\\s*\\(`, 'g');
    let bestMatch: RegExpExecArray | null = null;
    let bestDist = Infinity;
    let m;

    while ((m = callRe.exec(text)) !== null) {
        const dist = Math.abs(m.index - offset);
        if (dist < bestDist) {
            bestDist = dist;
            bestMatch = m;
        }
    }

    let paramCount = 0;
    if (bestMatch) {
        const parenPos = bestMatch.index + bestMatch[0].length - 1;
        paramCount = countMethodParams(text, parenPos);
    }

    return await findDefinitionAnywhere(className, uri, methodName, paramCount);
}

// ─── Autocompletion ─────────────────────────────────────────────────────────

connection.onCompletion(
    (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        const document = documents.get(textDocumentPosition.textDocument.uri);
        if (!document) { return []; }

        const text = document.getText();
        const offset = document.offsetAt(textDocumentPosition.position);

        const htmlCompletionConfig: CompletionConfiguration = {
            attributeDefaultValue: 'doublequotes',
            hideAutoCompleteProposals: false
        };

        const htmlResults = htmlLanguageService.doComplete(
            document,
            textDocumentPosition.position,
            htmlLanguageService.parseHTMLDocument(document),
            htmlCompletionConfig
        );

        let items: CompletionItem[] = htmlResults.items;

        const linePrefix = document.getText({
            start: { line: textDocumentPosition.position.line, character: 0 },
            end: textDocumentPosition.position
        });

        if (linePrefix.includes('<%@')) {
            items = items.concat([
                { label: 'page', kind: CompletionItemKind.Keyword, data: 1 },
                { label: 'include', kind: CompletionItemKind.Keyword, data: 2 },
                { label: 'taglib', kind: CompletionItemKind.Keyword, data: 3 },
            ]);
        }

        if (linePrefix.includes('<%@ page')) {
            items = items.concat([
                { label: 'language="java"', kind: CompletionItemKind.Property, data: 4 },
                { label: 'contentType="text/html; charset=UTF-8"', kind: CompletionItemKind.Property, data: 5 },
                { label: 'pageEncoding="UTF-8"', kind: CompletionItemKind.Property, data: 6 },
            ]);
        }

        if (text[offset - 1] === '<' || linePrefix.trim().endsWith('<')) {
            items = items.concat([
                { label: 'jsp:include', kind: CompletionItemKind.Snippet, data: 7 },
                { label: 'jsp:param', kind: CompletionItemKind.Snippet, data: 8 },
                { label: 'jsp:useBean', kind: CompletionItemKind.Snippet, data: 9 },
                { label: 'jsp:setProperty', kind: CompletionItemKind.Snippet, data: 10 },
                { label: 'jsp:getProperty', kind: CompletionItemKind.Snippet, data: 11 },
            ]);
        }

        return items;
    }
);

connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        switch (item.data) {
            case 1: item.detail = 'JSP Page Directive'; item.documentation = 'Defines page-dependent attributes'; break;
            case 7: item.detail = 'JSP Include Action'; item.documentation = 'Includes content of another JSP page at runtime'; break;
            case 8: item.detail = 'JSP Parameter'; item.documentation = 'Passes parameters to an included page'; break;
            case 9: item.detail = 'JSP UseBean Action'; item.documentation = 'Declares and instantiates a JavaBean'; break;
            case 10: item.detail = 'JSP SetProperty Action'; item.documentation = 'Sets the value of a JavaBean property'; break;
            case 11: item.detail = 'JSP GetProperty Action'; item.documentation = 'Gets the value of a JavaBean property'; break;
        }
        return item;
    }
);

// ─── Start ──────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();

