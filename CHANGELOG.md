# Change Log

## [0.1.0]

Rewrite of the navigation engine.

- Go to Definition now runs in the extension host (no separate language server) and delegates Java type
  lookup to the Red Hat Java extension when it is installed: exact Maven/Gradle classpaths, transitive
  dependencies, sources jars, decompiled classes and JDK sources.
- Real JSP tokenizer; Java fragments are parsed with tree-sitter as one virtual servlet, so generics,
  method chains, inherited members, `Map.Entry`, `var`, implicit objects, `<jsp:useBean>` and blocks that
  span scriptlets resolve correctly.
- Module model for Maven (parent inheritance, properties, BOMs, `warSourceDirectory`) and Gradle;
  lookups are scoped to the JSP's module and its dependencies.
- JavaScript definitions via the TypeScript language service across the page, `<script src>` files and
  included pages; works from inline event handlers.
- Built-in fallback index reads only jar central directories (no full jar loads), resolves transitive
  Maven dependencies, `system` scope, `WEB-INF/lib` and `lib/` jars, and the JDK `src.zip` (Java 8 and 9+).
  Jar sources open read-only instead of being extracted to a temp folder.
- No more full rescans on every keystroke; parse results are cached per document version.
- Navigation to `<%@ include %>`, `<jsp:include>` and `<script src>` targets.
- Unit tests and VS Code integration tests (built-in index and jdt.ls).

## [0.0.5]

- Maven multi-module project support.
