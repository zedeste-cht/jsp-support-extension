import * as assert from 'assert';
import { parseJsp } from '../../jsp/jspParser';
import { ClassRepository, Target } from '../../java/classRepository';
import { JavaResolver, JspJavaPage } from '../../java/javaResolver';
import { MemoryLocator, initParser, offsetOf } from './helpers';

const JDK = new MemoryLocator()
    .add('java.lang.Object', 'package java.lang; public class Object { public String toString() { return null; } public final Class<?> getClass() { return null; } }')
    .add('java.lang.String', 'package java.lang; public final class String { public String trim() { return this; } public int length() { return 0; } public static String format(String f, Object... args) { return f; } }')
    .add('java.lang.Integer', 'package java.lang; public final class Integer { public int intValue() { return 0; } }')
    .add('java.lang.Iterable', 'package java.lang; import java.util.Iterator; public interface Iterable<T> { Iterator<T> iterator(); }')
    .add('java.util.Iterator', 'package java.util; public interface Iterator<E> { E next(); boolean hasNext(); }')
    .add('java.util.Collection', 'package java.util; public interface Collection<E> extends Iterable<E> { int size(); }')
    .add('java.util.List', 'package java.util; public interface List<E> extends Collection<E> { E get(int index); boolean add(E e); void add(int index, E e); }')
    .add('java.util.ArrayList', 'package java.util; public class ArrayList<E> extends AbstractList<E> implements List<E> { public ArrayList() {} }')
    .add('java.util.AbstractList', 'package java.util; public abstract class AbstractList<E> implements List<E> { }')
    .add('java.util.Set', 'package java.util; public interface Set<E> extends Collection<E> { }')
    .add('java.util.Map', `package java.util;
public interface Map<K, V> {
    V get(Object key);
    Set<Map.Entry<K, V>> entrySet();
    interface Entry<K, V> { K getKey(); V getValue(); }
}`)
    .add('javax.servlet.ServletRequest', 'package javax.servlet; public interface ServletRequest { Object getAttribute(String name); String getParameter(String name); }')
    .add('javax.servlet.http.HttpServletRequest', 'package javax.servlet.http; import javax.servlet.ServletRequest; public interface HttpServletRequest extends ServletRequest { HttpSession getSession(); }')
    .add('javax.servlet.http.HttpSession', 'package javax.servlet.http; public interface HttpSession { Object getAttribute(String name); }')
    .add('javax.servlet.http.HttpServlet', 'package javax.servlet.http; public abstract class HttpServlet { public void log(String msg) {} }')
    .add('com.example.User', `package com.example;
import java.util.List;
public class User {
    public static final String KIND = "user";
    private String name;
    public User() {}
    public String getName() { return name; }
    public Address getAddress() { return null; }
    public List<Address> getAddresses() { return null; }
    public void set(String a) {}
    public void set(String a, String b) {}
    public static User create() { return new User(); }
    public static class Builder { public User build() { return null; } }
}`)
    .add('com.example.Address', 'package com.example; public class Address { public String getCity() { return null; } }')
    .add('com.example.Base', 'package com.example; public abstract class Base<T> { protected T value; public T get() { return value; } }')
    .add('com.example.Sub', 'package com.example; public class Sub extends Base<User> { }')
    .add('com.example.Status', 'package com.example; public enum Status { ACTIVE, INACTIVE; public String label() { return name(); } }');

const PAGE = `<%@ page import="java.util.*, com.example.User, com.example.Sub, com.example.Status" %>
<%@ page import="com.example.Address" %>
<jsp:useBean id="bean" class="com.example.User"/>
<%!
    private String greet(String n) { return "hi " + n; }
    private int counter = 0;
%>
<%
    User user = User.create();
    String city = user.getAddress().getCity();
    List<User> users = new ArrayList<>();
    String first = users.get(0).getName();
    Map<String, User> byId = new HashMap<>();
    for (Map.Entry<String, User> e : byId.entrySet()) {
        e.getValue().getName();
        e.getKey().trim();
    }
    for (User u : users) { %>
        <li><%= u.getName() %></li>
<%  }
    Sub sub = new Sub();
    sub.get().getName();
    request.getSession().getAttribute("x");
    request.getParameter("q").trim();
    var u2 = new User();
    u2.getName();
    user.set("a", "b");
    user.getAddresses().get(0).getCity();
    String k = User.KIND;
    Status.ACTIVE.label();
    User.Builder b = new User.Builder();
    b.build().getName();
    String s = (String) session.getAttribute("x");
    s.trim();
    counter++;
%>
<%= greet(bean.getName()) %>
<%= String.format("%d", counter) %>`;

describe('JavaResolver', function () {
    this.timeout(10000);
    let resolver: JavaResolver;
    let page: JspJavaPage;

    before(async () => {
        await initParser();
        resolver = new JavaResolver(new ClassRepository([JDK]));
        page = await JspJavaPage.create(parseJsp(PAGE), 'file:///page.jsp', undefined);
    });

    async function defAt(needle: string, nth = 0, delta = 0): Promise<Target> {
        const results = await resolver.definitionAt(page, offsetOf(PAGE, needle, nth, delta));
        assert.strictEqual(results.length, 1, `expected one result for "${needle}" #${nth}`);
        return results[0];
    }

    /** Assert target is `member` declared in class file `fqn`. */
    function expect(t: Target, fqn: string, member: string) {
        assert.strictEqual(t.uri, `mem:/${fqn.replace(/\./g, '/')}.java`, `uri for ${member}`);
        assert.strictEqual(t.text.substring(t.start, t.end), member);
    }

    it('resolves simple method call on a local', async () => {
        expect(await defAt('getAddress()', 0, 1), 'com.example.User', 'getAddress');
    });

    it('follows method chains', async () => {
        expect(await defAt('getCity()', 0, 1), 'com.example.Address', 'getCity');
    });

    it('binds generics through List<E>.get', async () => {
        expect(await defAt('getName();', 0, 1), 'com.example.User', 'getName');
    });

    it('resolves Map.Entry from entrySet() in enhanced for', async () => {
        expect(await defAt('getValue()', 0, 1), 'java.util.Map', 'getValue');
        expect(await defAt('e.getValue().getName', 0, 15), 'com.example.User', 'getName');
        expect(await defAt('getKey().trim', 0, 9), 'java.lang.String', 'trim');
    });

    it('resolves loop variable used across scriptlet boundaries', async () => {
        expect(await defAt('u.getName()', 0, 3), 'com.example.User', 'getName');
    });

    it('substitutes type params through superclasses', async () => {
        expect(await defAt('sub.get()', 0, 5), 'com.example.Base', 'get');
        expect(await defAt('sub.get().getName', 0, 11), 'com.example.User', 'getName');
    });

    it('types implicit objects and inherited interface methods', async () => {
        expect(await defAt('getSession()', 0, 1), 'javax.servlet.http.HttpServletRequest', 'getSession');
        expect(await defAt('getParameter', 0, 1), 'javax.servlet.ServletRequest', 'getParameter');
        expect(await defAt('getParameter("q").trim', 0, 19), 'java.lang.String', 'trim');
    });

    it('infers var from initializer', async () => {
        expect(await defAt('u2.getName', 0, 4), 'com.example.User', 'getName');
    });

    it('picks overload by argument count', async () => {
        const t = await defAt('user.set(', 0, 6);
        expect(t, 'com.example.User', 'set');
        assert.ok(t.text.substring(t.start, t.start + 40).includes('String a, String b'));
    });

    it('resolves List<Address> return type', async () => {
        expect(await defAt('get(0).getCity', 0, 9), 'com.example.Address', 'getCity');
    });

    it('resolves static field, enum constant and nested class', async () => {
        expect(await defAt('KIND'), 'com.example.User', 'KIND');
        expect(await defAt('ACTIVE.label', 0, 7), 'com.example.Status', 'label');
        expect(await defAt('ACTIVE.label'), 'com.example.Status', 'ACTIVE');
        expect(await defAt('Builder b', 0, 1), 'com.example.User', 'Builder');
        expect(await defAt('build().getName', 0, 1), 'com.example.User', 'build');
    });

    it('resolves class names to their declaration', async () => {
        expect(await defAt('User user'), 'com.example.User', 'User');
        expect(await defAt('new Sub', 0, 4), 'com.example.Sub', 'Sub');
        expect(await defAt('User.create', 0, 1), 'com.example.User', 'User');
        expect(await defAt('User.create', 0, 6), 'com.example.User', 'create');
    });

    it('jumps from a local use to its declaration in the JSP', async () => {
        const t = await defAt('user.getAddress', 0, 1);
        assert.strictEqual(t.uri, 'file:///page.jsp');
        assert.strictEqual(t.start, offsetOf(PAGE, 'user = User'));
    });

    it('resolves <%! %> declarations and useBean variables', async () => {
        const greet = await defAt('greet(bean', 0, 1);
        assert.strictEqual(greet.uri, 'file:///page.jsp');
        assert.strictEqual(greet.start, offsetOf(PAGE, 'greet(String'));

        const counter = await defAt('counter++', 0, 1);
        assert.strictEqual(counter.start, offsetOf(PAGE, 'counter = 0'));

        expect(await defAt('bean.getName', 0, 6), 'com.example.User', 'getName');
        const bean = await defAt('bean.getName', 0, 1);
        assert.strictEqual(bean.uri, 'file:///page.jsp');
        assert.strictEqual(bean.start, offsetOf(PAGE, 'bean"'));
    });

    it('resolves casts and java.lang statics', async () => {
        expect(await defAt('s.trim', 0, 3), 'java.lang.String', 'trim');
        expect(await defAt('String.format', 0, 8), 'java.lang.String', 'format');
    });

    it('resolves import directive class and useBean class attribute', async () => {
        expect((await resolver.classDefinition('com.example.Address'))[0], 'com.example.Address', 'Address');
        expect((await resolver.typeDefinition(page, 'com.example.User'))[0], 'com.example.User', 'User');
    });

    it('caches locator lookups', async () => {
        const before = JDK.calls.length;
        await defAt('getCity()', 0, 1);
        assert.strictEqual(JDK.calls.length, before, 'no new locator calls on a repeated lookup');
    });
});
