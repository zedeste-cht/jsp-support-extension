# JSP Language Support

This extension provides complete support for JavaServer Pages (JSP) files in Visual Studio Code.

## Features

### Syntax Highlighting
- JSP Directives (`<%@ ... %>`)
- Scriptlets (`<% ... %>`)
- Expressions (`<%= ... %>`)
- Declarations (`<%! ... %>`)
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

This extension does not require additional configuration.

## Known Issues

Please report any issues on the GitHub repository.

## Release Notes

### 0.0.1

Initial release with basic JSP support:
- Syntax highlighting
- Autocompletion
- Snippets
- Support for JSP standard actions
- Go to Definition for Java classes

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

**Enjoy!**
