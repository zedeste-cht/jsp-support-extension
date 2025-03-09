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
    TextDocument
} from 'vscode-languageserver/node';

import { TextDocument as TextDocumentContent } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import * as fs from 'fs';
import {
    getLanguageService as getHTMLLanguageService,
    LanguageService as HTMLLanguageService,
    CompletionConfiguration
} from 'vscode-html-languageservice';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents: TextDocuments<TextDocumentContent> = new TextDocuments(TextDocumentContent);

// Create the HTML language service
const htmlLanguageService: HTMLLanguageService = getHTMLLanguageService();

// Store project base paths
let workspaceFolders: string[] = [];
let javaSourcePaths: string[] = [];

connection.onInitialize((params: InitializeParams) => {
    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Enable autocompletion and automatic tag closure
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['@', '<', ' ', '"', ':', '/', '.', '>', '/']
            },
            // Enable Go to Definition
            definitionProvider: true
        }
    };

    // Save workspace paths and find Java source paths
    if (params.workspaceFolders) {
        workspaceFolders = params.workspaceFolders.map(folder => folder.uri.replace('file://', ''));
        console.log('Workspace folders:', workspaceFolders);
        
        // Search for Java source directories
        workspaceFolders.forEach(folder => {
            // Common Java source directory patterns
            const possiblePaths = [
                path.join(folder, 'src', 'main', 'java'),
                path.join(folder, 'java'),
                path.join(folder, 'src'),
                folder
            ];

            possiblePaths.forEach(javaSrcPath => {
                if (fs.existsSync(javaSrcPath)) {
                    console.log('Found Java source path:', javaSrcPath);
                    javaSourcePaths.push(javaSrcPath);
                }
            });
        });
    }

    return result;
});

// Recursive function to find files
function findFileRecursive(dir: string, fileName: string): string | null {
    if (!fs.existsSync(dir)) {
        console.log('Directory does not exist:', dir);
        return null;
    }

    const files = fs.readdirSync(dir);
    
    // First try direct match in current directory
    const directMatch = files.find(file => file === fileName);
    if (directMatch) {
        const fullPath = path.join(dir, directMatch);
        console.log('Found direct match:', fullPath);
        return fullPath;
    }

    // Then search in subdirectories
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            const found = findFileRecursive(filePath, fileName);
            if (found) {
                return found;
            }
        }
    }
    
    return null;
}

// Function to find Java class definition
async function findJavaDefinition(className: string): Promise<Location | null> {
    console.log('Searching for class:', className);
    
    // Convert class name to file path
    const classFile = className.split('.').pop() + '.java';
    const packagePath = className.split('.').slice(0, -1).join('/');
    
    console.log('Looking for file:', classFile);
    console.log('In package path:', packagePath);
    
    for (const srcPath of javaSourcePaths) {
        // Try multiple possible locations
        const possiblePaths = [
            // Exact package path
            packagePath ? path.join(srcPath, packagePath) : srcPath,
            // Direct in source path
            srcPath,
            // In a 'java' subdirectory
            path.join(srcPath, 'java'),
            // In parent directory
            path.dirname(srcPath)
        ];

        for (const searchPath of possiblePaths) {
            if (fs.existsSync(searchPath)) {
                const filePath = findFileRecursive(searchPath, classFile);
                if (filePath) {
                    console.log('Found file at:', filePath);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    
                    // Look for package declaration
                    let declaredPackage = '';
                    let foundClass = false;
                    
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        
                        // Find package declaration
                        if (line.startsWith('package ')) {
                            declaredPackage = line.substring(8, line.length - 1).trim();
                            console.log('Found package declaration:', declaredPackage);
                        }
                        
                        // Find class definition
                        const classMatch = line.match(new RegExp(`\\bclass\\s+${className.split('.').pop()}\\b`));
                        if (classMatch) {
                            console.log('Found class definition at line:', i + 1);
                            foundClass = true;
                            
                            // Verify package if we have one
                            if (packagePath) {
                                const expectedPackage = packagePath.replace(/\//g, '.');
                                if (declaredPackage === expectedPackage) {
                                    return Location.create(
                                        'file://' + filePath,
                                        Range.create(
                                            Position.create(i, line.indexOf('class')),
                                            Position.create(i, line.length)
                                        )
                                    );
                                } else {
                                    console.log('Package mismatch. Expected:', expectedPackage, 'Found:', declaredPackage);
                                }
                            } else {
                                // If no package was specified, accept any package
                                return Location.create(
                                    'file://' + filePath,
                                    Range.create(
                                        Position.create(i, line.indexOf('class')),
                                        Position.create(i, line.length)
                                    )
                                );
                            }
                        }
                    }
                    
                    if (!foundClass) {
                        console.log('File found but class definition not found in file');
                    }
                }
            }
        }
    }
    
    console.log('Class not found in any source path');
    return null;
}

// Function to find Java method definition
async function findJavaMethodDefinition(className: string, methodName: string, parameterCount: number): Promise<Location | null> {
    console.log('Searching for method:', methodName, 'in class:', className, 'with parameter count:', parameterCount);
    
    // First find the class file
    const classFile = className.split('.').pop() + '.java';
    const packagePath = className.split('.').slice(0, -1).join('/');
    
    console.log('Looking for file:', classFile);
    console.log('In package path:', packagePath);
    
    for (const srcPath of javaSourcePaths) {
        // Try multiple possible locations
        const possiblePaths = [
            packagePath ? path.join(srcPath, packagePath) : srcPath,
            srcPath,
            path.join(srcPath, 'java'),
            path.dirname(srcPath)
        ];

        for (const searchPath of possiblePaths) {
            if (fs.existsSync(searchPath)) {
                const filePath = findFileRecursive(searchPath, classFile);
                if (filePath) {
                    console.log('Found file at:', filePath);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    
                    // Look for method definition
                    let inClass = false;
                    let bracketCount = 0;
                    let methodStartLine = -1;
                    let bestMatch: {line: number, paramCount: number} | null = null;
                    
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        
                        // Check if we're inside the correct class
                        if (line.match(new RegExp(`\\bclass\\s+${className.split('.').pop()}\\b`))) {
                            inClass = true;
                            continue;
                        }
                        
                        if (!inClass) continue;
                        
                        // Count brackets to know when we exit the class
                        bracketCount += (line.match(/{/g) || []).length;
                        bracketCount -= (line.match(/}/g) || []).length;
                        if (bracketCount < 0) break; // We've exited the class
                        
                        // Look for method definition
                        const methodMatch = line.match(new RegExp(`\\b${methodName}\\s*\\(`));
                        if (methodMatch) {
                            // Found a potential method, check its parameters
                            let methodLine = line;
                            let currentLine = i;
                            
                            // If the parameters continue on next lines, read until we find the closing parenthesis
                            while (!methodLine.includes(')') && currentLine < lines.length - 1) {
                                currentLine++;
                                methodLine += ' ' + lines[currentLine].trim();
                            }
                            
                            // Extract parameters
                            const paramString = methodLine.substring(methodLine.indexOf('(') + 1, methodLine.indexOf(')'));
                            const params = paramString.trim() ? paramString.split(',') : [];
                            
                            console.log('Found method with parameters:', params.length);
                            
                            // Keep track of the best match (closest to our parameter count)
                            if (!bestMatch || Math.abs(params.length - parameterCount) < Math.abs(bestMatch.paramCount - parameterCount)) {
                                bestMatch = {
                                    line: i,
                                    paramCount: params.length
                                };
                            }
                            
                            // If we find an exact match, return it immediately
                            if (params.length === parameterCount) {
                                console.log('Found exact matching method definition at line:', i + 1);
                                return Location.create(
                                    'file://' + filePath,
                                    Range.create(
                                        Position.create(i, line.indexOf(methodName)),
                                        Position.create(i, line.indexOf(methodName) + methodName.length)
                                    )
                                );
                            }
                        }
                    }
                    
                    // If we found a close match, return it
                    if (bestMatch) {
                        console.log('Found best matching method definition at line:', bestMatch.line + 1);
                        const line = lines[bestMatch.line].trim();
                        return Location.create(
                            'file://' + filePath,
                            Range.create(
                                Position.create(bestMatch.line, line.indexOf(methodName)),
                                Position.create(bestMatch.line, line.indexOf(methodName) + methodName.length)
                            )
                        );
                    }
                }
            }
        }
    }
    
    console.log('Method not found');
    return null;
}

// Interface for variable tracking
interface VariableDeclaration {
    name: string;
    type: string;
    position: Position;
}

// Function to find variable declarations in the document
function findVariableDeclarations(text: string): VariableDeclaration[] {
    const declarations: VariableDeclaration[] = [];
    const lines = text.split('\n');
    
    let inJspScriptlet = false;
    let multiLineScriptlet = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Track if we're inside a JSP scriptlet
        if (line.includes('<%')) {
            inJspScriptlet = true;
            multiLineScriptlet = line;
        } else if (inJspScriptlet) {
            multiLineScriptlet += ' ' + line;
        }
        
        if (line.includes('%>')) {
            inJspScriptlet = false;
            
            // Process the complete scriptlet
            // Pattern for standard variable declarations: Type var = new Type();
            const declarationPattern = /([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\s+([a-z][a-zA-Z0-9_]*)\s*=\s*new\s+([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)/g;
            
            // Pattern for for-each loop variables: for (Type var : collection)
            const forEachPattern = /for\s*\(\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\s+([a-z][a-zA-Z0-9_]*)\s*:/g;
            
            // Pattern for method parameters: methodName(Type var, ...)
            const paramPattern = /\(\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\s+([a-z][a-zA-Z0-9_]*)\s*[,)]/g;
            
            let match;
            
            // Check for standard declarations
            while ((match = declarationPattern.exec(multiLineScriptlet)) !== null) {
                declarations.push({
                    name: match[2],
                    type: match[1],
                    position: Position.create(i, match.index)
                });
            }
            
            // Check for for-each loop variables
            while ((match = forEachPattern.exec(multiLineScriptlet)) !== null) {
                declarations.push({
                    name: match[2],
                    type: match[1],
                    position: Position.create(i, match.index)
                });
            }
            
            // Check for method parameters
            while ((match = paramPattern.exec(multiLineScriptlet)) !== null) {
                declarations.push({
                    name: match[2],
                    type: match[1],
                    position: Position.create(i, match.index)
                });
            }
            
            multiLineScriptlet = '';
        }
    }
    
    return declarations;
}

// Function to find the complete word at position
function findWordAtPosition(text: string, offset: number): string {
    let start = offset;
    let end = offset;
    
    // Expand backwards
    while (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1])) {
        start--;
    }
    
    // Expand forwards
    while (end < text.length && /[A-Za-z0-9_.]/.test(text[end])) {
        end++;
    }
    
    const fullWord = text.substring(start, end);
    console.log('Full word found:', fullWord);
    
    // Check if we're in an import statement
    const importMatch = text.slice(Math.max(0, start - 50), start).match(/import\s+([^;]*?)$/);
    if (importMatch) {
        // We're in an import statement, return the full import path if available
        const importPath = importMatch[1] + fullWord;
        console.log('Found in import statement:', importPath);
        return importPath;
    }
    
    // Check if we're in a JSP import directive
    const jspImportMatch = text.slice(Math.max(0, start - 50), start).match(/<%@\s*page\s+import="([^"]*?)$/);
    if (jspImportMatch) {
        // We're in a JSP import directive, return the full import path
        const importPath = jspImportMatch[1] + fullWord;
        console.log('Found in JSP import:', importPath);
        return importPath;
    }
    
    // If the word contains a dot, analyze its parts
    if (fullWord.includes('.')) {
        const parts = fullWord.split('.');
        // If first part starts with uppercase, it's likely a class name
        if (/^[A-Z]/.test(parts[0])) {
            // If cursor is before the dot, return class name
            if (offset - start <= parts[0].length) {
                console.log('Returning class name:', parts[0]);
                return parts[0];
            }
            // If cursor is after the dot, we're in a method
            else {
                console.log('In method call of class:', parts[0]);
                return fullWord;
            }
        } else {
            // It might be a variable.method call, try to find the variable's type
            const declarations = findVariableDeclarations(text);
            const varName = parts[0];
            const declaration = declarations.find(d => d.name === varName);
            if (declaration) {
                console.log('Found variable declaration:', declaration);
                // Return just the type name for class lookup, or type + method for method lookup
                return offset - start <= parts[0].length ? declaration.type : declaration.type + '.' + parts.slice(1).join('.');
            }
        }
    }
    
    // Check if we're in a for loop or variable declaration
    const lineStart = text.lastIndexOf('\n', start) + 1;
    const lineEnd = text.indexOf('\n', end);
    const currentLine = text.substring(lineStart, lineEnd !== -1 ? lineEnd : text.length);
    
    // Check for class name in for loop or variable declaration
    const forLoopMatch = currentLine.match(/for\s*\(\s*([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\s+\w+\s*:/);
    const varDeclMatch = currentLine.match(/([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)\s+\w+\s*=/);
    
    if (forLoopMatch && fullWord === forLoopMatch[1]) {
        console.log('Found class in for loop:', forLoopMatch[1]);
        return forLoopMatch[1];
    }
    
    if (varDeclMatch && fullWord === varDeclMatch[1]) {
        console.log('Found class in variable declaration:', varDeclMatch[1]);
        return varDeclMatch[1];
    }
    
    return fullWord;
}

// Function to extract parameters from a method call considering complex expressions
function extractMethodParameters(text: string, startPos: number): string[] {
    let bracketCount = 0;
    let currentParam = '';
    let params: string[] = [];
    let inString = false;
    let stringChar = '';
    let inExpression = false;
    
    // Skip initial whitespace
    while (startPos < text.length && /\s/.test(text[startPos])) {
        startPos++;
    }
    
    // Ensure we start with an opening parenthesis
    if (text[startPos] !== '(') {
        return [];
    }
    startPos++;
    
    for (let i = startPos; i < text.length; i++) {
        const char = text[i];
        const prevChar = i > 0 ? text[i - 1] : '';
        
        // Handle string literals
        if ((char === '"' || char === "'") && prevChar !== '\\') {
            if (!inString) {
                inString = true;
                stringChar = char;
            } else if (char === stringChar) {
                inString = false;
            }
            currentParam += char;
            continue;
        }
        
        // If we're in a string, just add the character
        if (inString) {
            currentParam += char;
            continue;
        }
        
        // Handle brackets and parentheses
        if (char === '(' || char === '[' || char === '{') {
            bracketCount++;
            currentParam += char;
            continue;
        }
        if (char === ')' || char === ']' || char === '}') {
            bracketCount--;
            if (bracketCount < 0) {
                // We've found the closing parenthesis of the method call
                if (currentParam.trim()) {
                    params.push(currentParam.trim());
                }
                break;
            }
            currentParam += char;
            continue;
        }
        
        // Handle operators and special characters in expressions
        if (/[+\-*/%=<>&|!~^]/.test(char)) {
            inExpression = true;
            currentParam += char;
            continue;
        }
        
        // Handle parameter separation
        if (char === ',' && bracketCount === 0) {
            params.push(currentParam.trim());
            currentParam = '';
            inExpression = false;
            continue;
        }
        
        // Add character to current parameter
        currentParam += char;
    }
    
    return params;
}

// Handle Go to Definition requests
connection.onDefinition(
    async (params: TextDocumentPositionParams): Promise<Definition | null> => {
        const document = documents.get(params.textDocument.uri);
        if (!document) {
            console.log('Document not found');
            return null;
        }

        const text = document.getText();
        const position = params.position;
        const offset = document.offsetAt(position);

        console.log('Processing definition request at position:', position);

        // First check if we're in an import statement
        const lineStart = text.lastIndexOf('\n', offset) + 1;
        const lineEnd = text.indexOf('\n', offset);
        const currentLine = text.substring(lineStart, lineEnd !== -1 ? lineEnd : text.length);
        
        if (currentLine.includes('import ') || (currentLine.includes('<%@page') && currentLine.includes('import='))) {
            // We're in an import line, try to get the full class name
            const javaImportMatch = currentLine.match(/import\s+([^;]*\.[A-Z][A-Za-z0-9_]*);/);
            const jspImportMatch = currentLine.match(/<%@\s*page[^>]*import="([^"]*\.[A-Z][A-Za-z0-9_]*)"/);
            
            const importMatch = javaImportMatch || jspImportMatch;
            if (importMatch) {
                const fullClassName = importMatch[1];
                console.log('Found in import statement:', fullClassName);
                return await findJavaDefinition(fullClassName);
            }
        }

        // Get the complete word at cursor position
        const completeWord = findWordAtPosition(text, offset);
        console.log('Complete word at cursor:', completeWord);

        // If it contains a dot, it might be a method call
        if (completeWord.includes('.')) {
            const [className, methodName] = completeWord.split('.');
            console.log('Found potential method call:', className, methodName);

            // If we have both class and method
            if (className && methodName) {
                // First try to find the method call in the entire context
                console.log('Searching for method call in context');
                const methodInContextPattern = new RegExp(`${className.replace(/\./g, '\\.')}\\.${methodName}\\s*\\([^;{]*[);]`, 'g');
                const allMatches = [...text.matchAll(methodInContextPattern)];
                
                // Find the closest match to our position
                let bestMatch = null;
                let bestDistance = Infinity;
                const positionOffset = document.offsetAt(position);
                
                for (const match of allMatches) {
                    const distance = Math.abs(match.index! - positionOffset);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        bestMatch = match;
                    }
                }
                
                if (bestMatch) {
                    console.log('Found method call in context');
                    const params = extractMethodParameters(bestMatch[0], bestMatch[0].indexOf('('));
                    console.log('Found parameters:', params);
                    return await findJavaMethodDefinition(className, methodName, params.length);
                }
                
                // If no method call found, try class definition
                console.log('No method call found, trying class definition');
                return await findJavaDefinition(className);
            }
        }

        // Check if it's a class name
        if (/^[A-Z][A-Za-z0-9_.]*$/.test(completeWord)) {
            console.log('Word looks like a Java class name');
            
            // First check in imports
            const lines = text.split('\n');
            const importLines = lines.filter(line => 
                line.includes('import ') || 
                (line.includes('<%@page') && line.includes('import='))
            );
            
            for (const line of importLines) {
                // Check Java imports
                const javaImportMatch = line.match(/import\s+([^;]*\.[A-Z][A-Za-z0-9_]*);/);
                if (javaImportMatch && javaImportMatch[1].endsWith(completeWord)) {
                    console.log('Found in Java import:', javaImportMatch[1]);
                    return await findJavaDefinition(javaImportMatch[1]);
                }
                
                // Check JSP imports
                const jspImportMatch = line.match(/<%@\s*page[^>]*import="([^"]*\.[A-Z][A-Za-z0-9_]*)"/);
                if (jspImportMatch && jspImportMatch[1].endsWith(completeWord)) {
                    console.log('Found in JSP import:', jspImportMatch[1]);
                    return await findJavaDefinition(jspImportMatch[1]);
                }
            }
            
            // If not found in imports, try direct class search
            return await findJavaDefinition(completeWord);
        }

        return null;
    }
);

// Handle autocompletion
connection.onCompletion(
    (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        const document = documents.get(textDocumentPosition.textDocument.uri);
        if (!document) {
            return [];
        }

        const text = document.getText();
        const offset = document.offsetAt(textDocumentPosition.position);

        // Configuration for HTML autocompletion
        const htmlCompletionConfiguration: CompletionConfiguration = {
            attributeDefaultValue: 'doublequotes',
            hideAutoCompleteProposals: false
        };

        // Get HTML suggestions
        const htmlResults = htmlLanguageService.doComplete(
            document,
            textDocumentPosition.position,
            htmlLanguageService.parseHTMLDocument(document),
            htmlCompletionConfiguration
        );

        let items: CompletionItem[] = htmlResults.items;

        // If we are inside a JSP directive, add JSP suggestions
        const linePrefix = document.getText({
            start: { line: textDocumentPosition.position.line, character: 0 },
            end: textDocumentPosition.position
        });

        if (linePrefix.includes('<%@')) {
            items = items.concat([
                {
                    label: 'page',
                    kind: CompletionItemKind.Keyword,
                    data: 1
                },
                {
                    label: 'include',
                    kind: CompletionItemKind.Keyword,
                    data: 2
                },
                {
                    label: 'taglib',
                    kind: CompletionItemKind.Keyword,
                    data: 3
                }
            ]);
        }

        // If we are inside a page directive, add common attributes
        if (linePrefix.includes('<%@ page')) {
            items = items.concat([
                {
                    label: 'language="java"',
                    kind: CompletionItemKind.Property,
                    data: 4
                },
                {
                    label: 'contentType="text/html; charset=UTF-8"',
                    kind: CompletionItemKind.Property,
                    data: 5
                },
                {
                    label: 'pageEncoding="UTF-8"',
                    kind: CompletionItemKind.Property,
                    data: 6
                }
            ]);
        }

        // Add JSP standard actions
        if (text[offset - 1] === '<' || linePrefix.trim().endsWith('<')) {
            items = items.concat([
                {
                    label: 'jsp:include',
                    kind: CompletionItemKind.Snippet,
                    data: 7,
                    insertText: '<jsp:include page="${1:page.jsp}">\n\t${0}\n</jsp:include>'
                },
                {
                    label: 'jsp:param',
                    kind: CompletionItemKind.Snippet,
                    data: 8,
                    insertText: '<jsp:param name="${1:paramName}" value="${2:paramValue}"/>'
                },
                {
                    label: 'jsp:useBean',
                    kind: CompletionItemKind.Snippet,
                    data: 9,
                    insertText: '<jsp:useBean id="${1:beanName}" class="${2:package.ClassName}" scope="${3|page,request,session,application|}"/>'
                },
                {
                    label: 'jsp:setProperty',
                    kind: CompletionItemKind.Snippet,
                    data: 10,
                    insertText: '<jsp:setProperty name="${1:beanName}" property="${2:propertyName}" value="${3:value}"/>'
                },
                {
                    label: 'jsp:getProperty',
                    kind: CompletionItemKind.Snippet,
                    data: 11,
                    insertText: '<jsp:getProperty name="${1:beanName}" property="${2:propertyName}"/>'
                }
            ]);
        }

        return items;
    }
);

// Handle autocompletion resolution
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        const document = documents.get(item.data?.documentUri);
        if (document && item.data?.tagName) {
            const htmlDocument = htmlLanguageService.parseHTMLDocument(document);
            const tag = htmlLanguageService.doTagComplete(document, item.data.position, htmlDocument);
            if (tag) {
                item.insertText = tag;
            }
        }

        // Handle other autocompletion resolution cases
        switch (item.data) {
            case 1:
                item.detail = 'JSP Page Directive';
                item.documentation = 'Defines page-dependent attributes and communicates these to the JSP container';
                break;
            case 7:
                item.detail = 'JSP Include Action';
                item.documentation = 'Includes the content of another JSP page at runtime';
                break;
            case 8:
                item.detail = 'JSP Parameter';
                item.documentation = 'Passes parameters to an included page';
                break;
            case 9:
                item.detail = 'JSP UseBean Action';
                item.documentation = 'Declares and instantiates a JavaBean component';
                break;
            case 10:
                item.detail = 'JSP SetProperty Action';
                item.documentation = 'Sets the value of a property in a JavaBean component';
                break;
            case 11:
                item.detail = 'JSP GetProperty Action';
                item.documentation = 'Gets the value of a property in a JavaBean component';
                break;
        }
        return item;
    }
);

// Make the document manager listen on the connection
documents.listen(connection);

// Start the language server
connection.listen(); 