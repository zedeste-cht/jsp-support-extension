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

    console.log('Searching in directory:', dir);
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
            console.log('Checking subdirectory:', file);
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
    console.log('Java source paths:', javaSourcePaths);
    
    for (const srcPath of javaSourcePaths) {
        console.log('Searching in source path:', srcPath);
        
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
            console.log('Trying path:', searchPath);
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

        // Search for the word at the current position
        const wordRange = {
            start: Math.max(0, offset - 50),
            end: Math.min(text.length, offset + 50)
        };
        const textAround = text.substring(wordRange.start, wordRange.end);
        console.log('Text around cursor:', textAround);
        
        // Try to find a Java class name
        const beforeCursor = textAround.substring(0, offset - wordRange.start);
        const afterCursor = textAround.substring(offset - wordRange.start);
        
        // Extract just the class name (stop at first dot or opening parenthesis)
        const wordBefore = beforeCursor.match(/[A-Za-z0-9_]+$/)?.[0] || '';
        const wordAfter = afterCursor.match(/^[A-Za-z0-9_]+(?=[.(]|$)/)?.[0] || '';
        const word = wordBefore + wordAfter;
        console.log('Found word:', word);

        // Verify if it looks like a Java class name
        if (/^[A-Z][A-Za-z0-9_]*[A-Za-z0-9]$/.test(word)) {
            console.log('Word looks like a Java class name');
            
            // Search for imports (both Java and JSP formats)
            const javaImportRegex = new RegExp(`import\\s+([^;]*\\.${word});`);
            const jspImportRegex = new RegExp(`<%@page\\s+import="([^"]*\\.${word})"\\s*%>`);
            
            // Try Java-style import first
            const javaImportMatch = text.match(javaImportRegex);
            if (javaImportMatch) {
                console.log('Found Java import statement:', javaImportMatch[1]);
                return await findJavaDefinition(javaImportMatch[1]);
            }
            
            // Try JSP-style import
            const jspImportMatch = text.match(jspImportRegex);
            if (jspImportMatch) {
                console.log('Found JSP import statement:', jspImportMatch[1]);
                return await findJavaDefinition(jspImportMatch[1]);
            }
            
            // If there's no explicit import, search in the same package
            const packageMatch = text.match(/package\s+([^;]+);/);
            if (packageMatch) {
                console.log('Found package declaration:', packageMatch[1]);
                const fullClassName = `${packageMatch[1]}.${word}`;
                console.log('Trying with full class name:', fullClassName);
                return await findJavaDefinition(fullClassName);
            }

            // Try to search for the class directly
            console.log('Trying direct class search:', word);
            return await findJavaDefinition(word);
        }

        console.log('Word does not look like a Java class name');
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