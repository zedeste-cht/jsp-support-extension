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

    // Save workspace paths
    if (params.workspaceFolders) {
        workspaceFolders = params.workspaceFolders.map(folder => folder.uri.replace('file://', ''));
        
        // Search for common src/main/java directories in Java projects
        workspaceFolders.forEach(folder => {
            const javaSrcPath = path.join(folder, 'src', 'main', 'java');
            if (fs.existsSync(javaSrcPath)) {
                javaSourcePaths.push(javaSrcPath);
            }
        });
    }

    return result;
});

// Recursive function to find files
function findFileRecursive(dir: string, fileName: string): string | null {
    if (!fs.existsSync(dir)) {
        return null;
    }

    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            const found = findFileRecursive(filePath, fileName);
            if (found) {
                return found;
            }
        } else if (file === fileName) {
            return filePath;
        }
    }
    
    return null;
}

// Function to find Java class definition
async function findJavaDefinition(className: string): Promise<Location | null> {
    // Convert class name to file path
    const classFile = className.split('.').pop() + '.java';
    const packagePath = className.split('.').slice(0, -1).join('/');
    
    for (const srcPath of javaSourcePaths) {
        const searchPath = packagePath ? path.join(srcPath, packagePath) : srcPath;
        const filePath = findFileRecursive(searchPath, classFile);
        
        if (filePath) {
            // Read the file and find the class definition
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            
            // Search for the line that defines the class
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const classMatch = line.match(new RegExp(`\\bclass\\s+${className.split('.').pop()}\\b`));
                if (classMatch) {
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
    }
    return null;
}

// Handle Go to Definition requests
connection.onDefinition(
    async (params: TextDocumentPositionParams): Promise<Definition | null> => {
        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        const text = document.getText();
        const position = params.position;
        const offset = document.offsetAt(position);

        // Search for the word at the current position
        const wordRange = {
            start: Math.max(0, offset - 50),
            end: Math.min(text.length, offset + 50)
        };
        const textAround = text.substring(wordRange.start, wordRange.end);
        
        // Try to find a Java class name
        const beforeCursor = textAround.substring(0, offset - wordRange.start);
        const afterCursor = textAround.substring(offset - wordRange.start);
        
        const wordBefore = beforeCursor.match(/[A-Za-z0-9_.]+$/)?.[0] || '';
        const wordAfter = afterCursor.match(/^[A-Za-z0-9_.]+/)?.[0] || '';
        const word = wordBefore + wordAfter;

        // Verify if it looks like a Java class name
        if (/^[A-Z][A-Za-z0-9_.]*[A-Za-z0-9]$/.test(word)) {
            // Search for imports
            const importMatch = text.match(new RegExp(`import\\s+([^;]*\\.${word.split('.').pop()});`));
            if (importMatch) {
                return await findJavaDefinition(importMatch[1]);
            }
            
            // If there's no explicit import, search in the same package
            const packageMatch = text.match(/package\s+([^;]+);/);
            if (packageMatch) {
                const fullClassName = `${packageMatch[1]}.${word}`;
                return await findJavaDefinition(fullClassName);
            }

            // Try to search for the class directly
            return await findJavaDefinition(word);
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