import * as assert from 'assert';
import { parseJsp, regionAt } from '../../jsp/jspParser';
import { buildVirtualJava } from '../../jsp/virtualJava';
import { buildVirtualJs } from '../../jsp/virtualJs';
import { offsetOf } from './helpers';

const PAGE = `<%@ page contentType="text/html;charset=UTF-8" %>
<%@ page import="java.util.List, com.example.User,
                 java.util.*" %>
<%@ include file="/WEB-INF/header.jspf" %>
<%-- comment with <% fake %> --%>
<%! private int count = 0; %>
<jsp:useBean id="bean" class="com.example.User" scope="request"/>
<jsp:include page="footer.jsp"/>
<html><body>
<input value="<%= user.getName() %>" onclick="doIt('<%= id %>'); other()">
<a href="javascript:go()">x</a>
<p>\${user.name} 中文</p>
<% for (User u : users) { %>
  <li><%= u.getName() %></li>
<% } %>
<script src="\${ctx}/js/app.js"></script>
<script>
  function local() { var x = '<%= y %>'; }
</script>
<script type="text/template"><div>{{x}}</div></script>
</body></html>`;

describe('jspParser', () => {
    const doc = parseJsp(PAGE);

    it('collects imports with exact offsets, across lines', () => {
        assert.deepStrictEqual(doc.imports.map(i => i.fqn), ['java.util.List', 'com.example.User', 'java.util.*']);
        for (const i of doc.imports) {
            assert.strictEqual(PAGE.substring(i.start, i.end), i.fqn);
        }
    });

    it('collects includes (directive and action)', () => {
        assert.deepStrictEqual(doc.includes.map(i => [i.kind, i.path]), [
            ['directive', '/WEB-INF/header.jspf'],
            ['action', 'footer.jsp'],
        ]);
    });

    it('collects useBean', () => {
        assert.strictEqual(doc.useBeans.length, 1);
        assert.strictEqual(doc.useBeans[0].id, 'bean');
        assert.strictEqual(doc.useBeans[0].typeName, 'com.example.User');
    });

    it('does not treat JSP inside a JSP comment as code', () => {
        const fake = offsetOf(PAGE, 'fake');
        assert.strictEqual(regionAt(doc, fake)?.kind, 'comment');
    });

    it('finds Java regions inside attribute values', () => {
        assert.strictEqual(regionAt(doc, offsetOf(PAGE, 'getName'))?.kind, 'expression');
        assert.strictEqual(regionAt(doc, offsetOf(PAGE, 'id %>'))?.kind, 'expression');
    });

    it('classifies EL, scriptlets, declarations', () => {
        assert.strictEqual(regionAt(doc, offsetOf(PAGE, 'user.name'))?.kind, 'el');
        assert.strictEqual(regionAt(doc, offsetOf(PAGE, 'User u'))?.kind, 'scriptlet');
        assert.strictEqual(regionAt(doc, offsetOf(PAGE, 'count'))?.kind, 'declaration');
    });

    it('collects scripts and event handlers', () => {
        assert.strictEqual(doc.scripts.length, 3);
        assert.strictEqual(doc.scripts[0].src?.value, '${ctx}/js/app.js');
        assert.strictEqual(doc.scripts[1].isJavaScript, true);
        assert.strictEqual(doc.scripts[2].isJavaScript, false);
        const handlers = doc.eventHandlers.map(h => PAGE.substring(h.start, h.end));
        assert.deepStrictEqual(handlers, [`doIt('<%= id %>'); other()`, 'javascript:go()']);
    });

    it('virtual Java maps offsets both ways', () => {
        const v = buildVirtualJava(doc);
        const jspOff = offsetOf(PAGE, 'getName');
        const virtOff = v.toVirtual(jspOff)!;
        assert.strictEqual(v.text.substr(virtOff, 7), 'getName');
        assert.strictEqual(v.toJsp(virtOff), jspOff);
        assert.ok(v.text.includes('out.print( user.getName() );'));
        // Declarations are hoisted into the class body before _jspService.
        assert.ok(v.text.indexOf('private int count') < v.text.indexOf('_jspService'));
        // useBean becomes a typed local.
        assert.ok(/com\.example\.User bean = null;/.test(v.text));
    });

    it('virtual JS keeps offsets and blanks non-JS', () => {
        const js = buildVirtualJs(doc);
        assert.strictEqual(js.length, PAGE.length);
        const at = offsetOf(PAGE, 'function local');
        assert.strictEqual(js.substr(at, 14), 'function local');
        assert.strictEqual(js.substr(offsetOf(PAGE, 'other()'), 7), 'other()');
        // JSP inside JS is neutralised, template script and HTML are blank.
        assert.ok(!js.includes('<%'));
        assert.ok(!js.includes('{{x}}'));
        assert.ok(!js.includes('<html>'));
        assert.strictEqual(js.split('\n').length, PAGE.split('\n').length);
    });
});
