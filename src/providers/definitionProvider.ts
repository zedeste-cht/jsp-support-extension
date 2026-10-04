import * as vscode from 'vscode';
import { inAttr, isJavaRegion, regionAt } from '../jsp/jspParser';
import { JspSupport } from '../jspSupport';
import { Target } from '../java/classRepository';

export class JspDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly s: JspSupport) { }

    async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
        const started = Date.now();
        try {
            const result = await this.resolve(doc, doc.offsetAt(pos));
            if (token.isCancellationRequested) { return undefined; }
            this.s.log.appendLine(`definition @${pos.line + 1}:${pos.character + 1} → ${result?.length ?? 0} result(s) in ${Date.now() - started}ms`);
            return result?.length ? result : undefined;
        } catch (e) {
            this.s.log.appendLine(`definition failed: ${(e as Error)?.stack ?? e}`);
            return undefined;
        }
    }

    private async resolve(doc: vscode.TextDocument, offset: number): Promise<vscode.Location[] | undefined> {
        const jsp = this.s.jspDocument(doc);
        const fsPath = doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined;
        const toLocs = (ts: Target[]) => ts.map(t => this.s.toLocation(t));

        // 1. <%@ page import="a.b.C, d.e.F" %>
        const imp = jsp.imports.find(i => offset >= i.start && offset <= i.end);
        if (imp) {
            if (imp.fqn.endsWith('.*')) { return undefined; }
            await this.s.ensureModel().catch(() => undefined);
            return toLocs(await this.s.java.classDefinition(imp.fqn, fsPath));
        }

        // 2. include file / jsp:include page / script src → open the file
        if (fsPath) {
            const inc = jsp.includes.find(i => inAttr(i.attr, offset));
            const src = jsp.scripts.find(sc => inAttr(sc.src, offset));
            const raw = inc?.path ?? src?.src?.value;
            if (raw !== undefined) {
                const files = await this.s.resolveWebPath(raw, fsPath);
                return files.map(f => new vscode.Location(vscode.Uri.file(f), new vscode.Position(0, 0)));
            }
        }

        // 3. <jsp:useBean class="..." type="...">
        for (const b of jsp.useBeans) {
            const a = [b.classAttr, b.typeAttr].find(x => inAttr(x, offset));
            if (a) {
                const page = await this.s.javaPage(doc);
                return toLocs(await this.s.java.typeDefinition(page, a.value.trim()));
            }
        }

        // 4. Java code (scriptlet / expression / declaration, also inside attributes)
        const region = regionAt(jsp, offset);
        if (isJavaRegion(region)) {
            const page = await this.s.javaPage(doc);
            return toLocs(await this.s.java.definitionAt(page, offset));
        }

        // 5. JavaScript (<script> bodies and on* handlers)
        const inScript = jsp.scripts.some(sc => sc.isJavaScript && !sc.src && offset >= sc.contentStart && offset <= sc.contentEnd);
        const inHandler = jsp.eventHandlers.some(h => offset >= h.start && offset <= h.end);
        if ((inScript || inHandler) && fsPath && region?.kind !== 'el') {
            const defs = await this.s.jsDefinition(doc, offset);
            const out: vscode.Location[] = [];
            for (const d of defs) {
                const text = await this.s.readDocText(d.path);
                if (text !== null) { out.push(this.s.toLocation({ uri: vscode.Uri.file(d.path).toString(), text, start: d.start, end: d.end })); }
            }
            return out;
        }
        return undefined;
    }
}
