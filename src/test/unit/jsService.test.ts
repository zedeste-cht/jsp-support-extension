import * as assert from 'assert';
import * as path from 'path';
import { parseJsp } from '../../jsp/jspParser';
import { buildVirtualJs } from '../../jsp/virtualJs';
import { JsDefinitionService, scanFunctionDefs } from '../../js/jsService';
import { ROOT, offsetOf } from './helpers';

const APP_JS = `
var App = {
    init: function () { helper(); },
    render() { }
};
function Widget() {}
Widget.prototype.show = function () {};
class Dialog { open() {} }
const arrow = (a) => a;
`;

const PAGE = `<%@ page contentType="text/html" %>
<script src="js/app.js"></script>
<script>
  function helper() { return '<%= x %>'; }
  var w = new Widget();
  function boot() { App.init(); w.show(); new Dialog().open(); arrow(1); App.render(); }
</script>
<button onclick="boot(); helper()">go</button>
<button onclick="fromInclude()">go</button>`;

const INCLUDE = `<script>function fromInclude() {}</script>`;

describe('JsDefinitionService', function () {
    this.timeout(20000);
    const svc = new JsDefinitionService(() => require(path.join(ROOT, 'dist', 'typescript.js')));
    const main = { path: '/w/page.jsp', text: buildVirtualJs(parseJsp(PAGE)) };
    const others = [
        { path: '/w/js/app.js', text: APP_JS },
        { path: '/w/inc.jspf', text: buildVirtualJs(parseJsp(INCLUDE)) },
    ];
    const norm = (p: string) => p.replace(/\\/g, '/');

    function def(needle: string, nth = 0, delta = 0) {
        const res = svc.definition(main, others, offsetOf(PAGE, needle, nth, delta));
        assert.ok(res.length >= 1, `no definition for ${needle}`);
        return res[0];
    }

    it('resolves functions in the same page, from inline handlers', () => {
        const d = def('helper()', 1);
        assert.strictEqual(norm(d.path), '/w/page.jsp');
        assert.strictEqual(d.start, offsetOf(PAGE, 'helper() {'));
    });

    it('resolves object literal methods, prototypes, classes and arrows in external files', () => {
        for (const [needle, target] of [
            ['init()', 'init:'], ['show()', 'show ='], ['open()', 'open()'], ['arrow(1)', 'arrow ='], ['render()', 'render()'],
        ]) {
            const d = def(needle);
            assert.strictEqual(norm(d.path), '/w/js/app.js', needle);
            assert.strictEqual(d.start, APP_JS.indexOf(target), needle);
        }
    });

    it('resolves functions defined in included pages', () => {
        const d = def('fromInclude()');
        assert.strictEqual(norm(d.path), '/w/inc.jspf');
        assert.strictEqual(d.start, INCLUDE.indexOf('fromInclude'));
    });

    it('heuristic scanner finds common definition forms', () => {
        const defs = scanFunctionDefs(APP_JS + '\nfunction fun() {}\nobj.handler = function() {}');
        assert.deepStrictEqual(defs.get('init'), [APP_JS.indexOf('init')]);
        assert.ok(defs.has('Widget') && defs.has('show') && defs.has('arrow') && defs.has('handler'));
        assert.strictEqual(defs.get('fun')?.length, 1);
    });
});
