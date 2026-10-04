# JSP Language Support

JavaServer Pages (JSP) support for Visual Studio Code: syntax highlighting, snippets, completion, and
**Go to Definition from JSP into Java and JavaScript** — across Maven/Gradle multi-module projects,
Maven dependencies, self-packaged jars and the JDK.

Based on the original work [jeromyu2023/vscode-jsp-support](https://github.com/jeromyu2023/vscode-jsp-support).

## Go to Definition

Press <kbd>F12</kbd> / <kbd>Ctrl</kbd>+click in a `.jsp` / `.jspf` / `.jspx` file.

### Java (scriptlets, expressions, declarations, attributes)

```jsp
<%@ page import="com.acme.UserService, java.util.*" %>
<jsp:useBean id="bean" class="com.acme.User"/>
<%!
    private String greet(String n) { return "hi " + n; }   // ← greet(...) jumps here
%>
<%
    UserService svc = new UserService();                    // class → UserService.java
    List<User> users = svc.findAll();
    users.get(0).getAddress().getCity();                    // generics + method chains
    for (Map.Entry<String, User> e : map.entrySet()) {
        e.getValue().getName();                             // Map.Entry<K,V> type arguments
    }
    request.getSession().getAttribute("x");                 // implicit objects → servlet-api
    StringUtils.isBlank(name);                              // Maven dependency jar (sources or decompiled)
%>
<%= greet(bean.getName()) %>
```

Understands local variables (including `var`, for-each, catch, lambdas), `<%! %>` fields and methods,
`<jsp:useBean>`, implicit objects (`request`, `session`, `out`, `application`, `pageContext`, …; javax and
jakarta), imports (single, wildcard, `java.lang`), nested types, static members, enum constants,
overloads by argument count, inherited members and generic type arguments through the type hierarchy.
Blocks that span several scriptlets (`<% for (...) { %> … <% } %>`) are handled as one program.

### JavaScript

- Functions and methods defined in the same page, in `<script src="…">` files, and in pages pulled in with
  `<%@ include %>` / `<jsp:include>` — resolved with the TypeScript language service (object literal
  methods, prototypes, classes, arrow functions).
- Works from `<script>` blocks and from inline handlers (`onclick="save()"`, `href="javascript:…"`).
- Falls back to a workspace-wide search of function definitions in the module's webapp folders.

### Files

`<%@ include file>`, `<jsp:include page>` and `<script src>` open the referenced file. Paths are resolved
against the JSP's webapp root (the folder containing `WEB-INF`, `warSourceDirectory`, `src/main/webapp`, …)
and understand `${pageContext.request.contextPath}`, `<%=request.getContextPath()%>` and `<c:url value>`.

## Multi-module projects and jars

- **Maven**: every `pom.xml` in the workspace is a module (custom `<sourceDirectory>`, `warSourceDirectory`,
  parent inheritance, properties, `dependencyManagement` and imported BOMs).
- **Gradle**: every `build.gradle(.kts)` is a module (conventional `src/main/java`, `src/main/webapp`,
  `project(':x')` dependencies).
- A JSP looks up classes in **its own module first, then the modules it depends on**, so identical class
  names in different modules resolve correctly.

### With the Red Hat Java extension (recommended)

If [Language Support for Java by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.java)
is installed, type lookup is delegated to it (jdt.ls). That gives you the exact Maven/Gradle classpath
(transitive dependencies, `system` scope, installed self-built jars), sources jars, **decompiled classes
when no sources are available**, and JDK sources.

### Without it

A built-in index is used: module sources, `-sources.jar` (or jars that contain `.java` files) of the Maven
dependencies resolved from your poms (including transitive ones), `system`-scope jars, `WEB-INF/lib/*.jar`
and `lib/*.jar` (with a sibling `-sources.jar`), and the JDK `src.zip`. Jar sources open read-only.
Classes without sources cannot be shown in this mode.

## Settings

| Setting | Description |
|---|---|
| `jsp-support.javaSourcePaths` | Extra Java source folders (relative to each module) to search. |
| `jsp-support.javaHome` | JDK used for `src.zip` when jdt.ls is not available. Falls back to `java.jdt.ls.java.home`, the default `java.configuration.runtimes` entry and `JAVA_HOME`. |
| `jsp-support.mavenRepository` | Local Maven repository. Defaults to `<localRepository>` in `~/.m2/settings.xml`, then `~/.m2/repository`. |

Run **JSP: Show Log** to see the detected modules and per-lookup timings.

## Other features

- Syntax highlighting for directives, scriptlets, expressions, declarations, actions, embedded HTML/Java/JS/CSS
- Completion for directives, `page` attributes, JSP actions and HTML
- Snippets: `page`, `include`, `taglib`, `jsp:include`, `jsp:include-params`, `jsp:param`, `jsp:useBean`,
  `jsp:setProperty`, `jsp:getProperty`, `scriptlet`, `expr`, `decl`, `comment`

## Development

```bash
npm install
npm test                        # unit tests (parser, resolver, Maven model, jar index, JS)
npx vscode-test --label index   # VS Code integration tests against ../jsptest (built-in index)
# jdt.ls integration tests against test-fixtures/maven-multi:
JAVA_HOME=<jdk> JSP_TEST_EXTENSIONS_DIR=<folder containing redhat.java> npx vscode-test --label jdt
```

Architecture (all in `src/`):

| Path | Role |
|---|---|
| `jsp/jspParser.ts` | JSP tokenizer: regions, directives, imports, includes, useBeans, scripts, handlers |
| `jsp/virtualJava.ts` | Builds a servlet-like Java source from the page, with offset mapping |
| `jsp/virtualJs.ts` | Same-length JS projection of the page |
| `java/javaModel.ts` | tree-sitter based Java declaration model |
| `java/javaResolver.ts` | Expression typing and definition resolution |
| `java/classRepository.ts` | FQN → source via locators, with caching |
| `locators/` | jdt.ls locator and the built-in source/jar index |
| `project/` | Maven POM model and the workspace module model |
| `js/jsService.ts` | TypeScript language service for JS definitions |

## License

MIT – see [LICENSE](LICENSE).
