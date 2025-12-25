# JSP Language Support

This extension provides complete support for JavaServer Pages (JSP) files in Visual Studio Code.

## Notes

This project is based on the original work: [jeromyu2023/vscode-jsp-support](https://github.com/jeromyu2023/vscode-jsp-support).

Because of a path issue, this repository was cloned and modified for further adjustments.

## Features

### Syntax Highlighting
- JSP Directives (`<%@ ... %>`)
- Scriptlets (`<% ... %>`)
- Expressions (`<%= ... %>`)
- Declarations (`<%! ... %>`4
- JSP Standard Actions (`<jsp:include>`, `<jsp:param>`, etc.)
- Embedded HTML and Java

### Go to Definition
- Navigate to Java class definitions from JSP files
- Supports both JSP and Java import styles:
  ```jsp
  <%@page import="com.example.MyClass"%>  // JSP import
  <%
    import com.example.OtherClass;        // Java import
    MyClass instance = new MyClass();     // Go to definition works here
  %>
  ```
- Works with:
  - Class references in code
  - Import statements
  - Fully qualified and simple class names
  - Classes in different package structures

### Autocompletion
- JSP Directives (page, include, taglib)
- Common Directive Attributes
- JSP Standard Actions
- Basic JSTL Tags

### Snippets
- Basic JSP Template
- Common Directives
- JSP Standard Actions
- JSP Code Blocks
- JSTL Imports

## Usage

The extension is automatically activated for files with `.jsp`, `.jspx`, and `.jspf` extensions.

### Available Snippets

- `page` - Page directive with common attributes
- `include` - Include directive
- `taglib` - Taglib directive for JSTL
- `jsp:include` - JSP include action
- `jsp:include-params` - Include action with parameters
- `jsp:param` - JSP parameter
- `jsp:useBean` - UseBean action
- `jsp:setProperty` - SetProperty action
- `jsp:getProperty` - GetProperty action
- `scriptlet` - Scriptlet block
- `expr` - JSP expression
- `decl` - JSP declaration
- `comment` - JSP comment

## Requirements

There are no special requirements to use this extension.

## Extension Settings

This extension contributes the following settings:

* `jsp-support.javaSourcePaths`: Array of relative paths to search for Java source files within workspace folders. Defaults to `["src/main/java"]`. The extension also automatically detects source directories from `pom.xml` files.

## Known Issues

Please report any issues on the GitHub repository.

## Release Notes

### 0.0.5

Enhanced Maven multi-module project support:
- Automatic detection and parsing of `<modules>` in parent `pom.xml` files
- Recursive collection of Java source paths from all sub-modules in multi-module Maven projects
- Module-aware Go to Definition: prioritizes searching in the module containing the current JSP file
- Improved accuracy for class and method navigation in complex project structures

### 0.0.4

Enhanced Java class navigation:
- Added configurable Java source paths via VS Code settings (`jsp-support.javaSourcePaths`)
- Automatic detection of source directories from `pom.xml` `<sourceDirectory>` configuration
- Support for complex multi-module Maven projects with custom directory structures
- Improved compatibility with non-standard Maven project layouts

### 0.0.1

Initial release with basic JSP support:
- Syntax highlighting
- Autocompletion
- Snippets
- Support for JSP standard actions
- Go to Definition for Java classes

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

**Enjoy!**