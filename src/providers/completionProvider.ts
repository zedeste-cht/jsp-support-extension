import * as vscode from 'vscode';
import { getLanguageService, TextDocument as HtmlTextDocument, LanguageService } from 'vscode-html-languageservice';
import { isJavaRegion, regionAt } from '../jsp/jspParser';
import { JspSupport } from '../jspSupport';

const DIRECTIVES: [string, string][] = [
    ['page', 'Defines page-dependent attributes'],
    ['include', 'Includes a file at translation time'],
    ['taglib', 'Declares a tag library'],
];

const PAGE_ATTRS = [
    'language="java"', 'contentType="text/html; charset=UTF-8"', 'pageEncoding="UTF-8"',
    'import=""', 'session="true"', 'isELIgnored="false"', 'errorPage=""', 'isErrorPage="false"',
];

const ACTIONS: [string, string][] = [
    ['jsp:include', 'Includes content of another page at request time'],
    ['jsp:param', 'Passes a parameter to an included/forwarded page'],
    ['jsp:useBean', 'Declares and instantiates a JavaBean'],
    ['jsp:setProperty', 'Sets a JavaBean property'],
    ['jsp:getProperty', 'Gets a JavaBean property'],
    ['jsp:forward', 'Forwards the request to another page'],
];

export class JspCompletionProvider implements vscode.CompletionItemProvider {
    private html?: LanguageService;

    constructor(private readonly s: JspSupport) { }

    provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
        const offset = doc.offsetAt(pos);
        const jsp = this.s.jspDocument(doc);
        const region = regionAt(jsp, offset);
        const linePrefix = doc.lineAt(pos.line).text.substring(0, pos.character);

        if (region?.kind === 'directive') {
            if (/<%@\s*\w*$/.test(linePrefix)) {
                return DIRECTIVES.map(([label, doc]) => item(label, vscode.CompletionItemKind.Keyword, doc));
            }
            if (/<%@\s*page\b/.test(doc.getText().substring(region.start, offset))) {
                return PAGE_ATTRS.map(a => item(a, vscode.CompletionItemKind.Property));
            }
            return undefined;
        }
        // Java/EL/script bodies are handled by other tooling.
        if (region && (isJavaRegion(region) || region.kind === 'el' || region.kind === 'comment')) { return undefined; }

        const items: vscode.CompletionItem[] = [];
        if (/<[\w:]*$/.test(linePrefix)) {
            items.push(...ACTIONS.map(([label, d]) => item(label, vscode.CompletionItemKind.Snippet, d)));
        }
        if (!region || (region.kind !== 'script' && region.kind !== 'style')) {
            items.push(...this.htmlCompletions(doc, pos));
        }
        return items;
    }

    private htmlCompletions(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
        this.html ??= getLanguageService();
        const hdoc = HtmlTextDocument.create(doc.uri.toString(), 'html', doc.version, doc.getText());
        const list = this.html.doComplete(hdoc, pos, this.html.parseHTMLDocument(hdoc), { attributeDefaultValue: 'doublequotes' });
        return list.items.map(i => {
            const ci = new vscode.CompletionItem(i.label, (i.kind ?? 1) - 1 as vscode.CompletionItemKind);
            const te = i.textEdit;
            if (te && 'range' in te) {
                const r = te.range;
                ci.range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
                ci.insertText = i.insertTextFormat === 2 ? new vscode.SnippetString(te.newText) : te.newText;
            }
            if (typeof i.documentation === 'string') { ci.documentation = i.documentation; }
            else if (i.documentation) { ci.documentation = new vscode.MarkdownString(i.documentation.value); }
            ci.filterText = i.filterText;
            ci.sortText = i.sortText;
            return ci;
        });
    }
}

function item(label: string, kind: vscode.CompletionItemKind, documentation?: string): vscode.CompletionItem {
    const ci = new vscode.CompletionItem(label, kind);
    if (documentation) { ci.documentation = documentation; }
    return ci;
}
