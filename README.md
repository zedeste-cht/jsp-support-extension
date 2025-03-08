# JSP Language Support

Esta extensión proporciona soporte completo para archivos JavaServer Pages (JSP) en Visual Studio Code.

## Características

### Resaltado de Sintaxis
- Directivas JSP (`<%@ ... %>`)
- Scriptlets (`<% ... %>`)
- Expresiones (`<%= ... %>`)
- Declaraciones (`<%! ... %>`)
- Acciones estándar JSP (`<jsp:include>`, `<jsp:param>`, etc.)
- HTML y Java embebido

### Autocompletado
- Directivas JSP (page, include, taglib)
- Atributos comunes de directivas
- Acciones estándar JSP
- Etiquetas JSTL básicas

### Snippets
- Plantilla básica de JSP
- Directivas comunes
- Acciones estándar JSP
- Bloques de código JSP
- Importaciones JSTL

## Uso

La extensión se activa automáticamente para archivos con extensiones `.jsp`, `.jspx` y `.jspf`.

### Snippets Disponibles

- `page` - Directiva page con atributos comunes
- `include` - Directiva include
- `taglib` - Directiva taglib para JSTL
- `jsp:include` - Acción include de JSP
- `jsp:include-params` - Acción include con parámetros
- `jsp:param` - Parámetro JSP
- `jsp:useBean` - Acción useBean
- `jsp:setProperty` - Acción setProperty
- `jsp:getProperty` - Acción getProperty
- `scriptlet` - Bloque scriptlet
- `expr` - Expresión JSP
- `decl` - Declaración JSP
- `comment` - Comentario JSP

## Requisitos

No hay requisitos especiales para usar esta extensión.

## Configuración de la Extensión

Esta extensión no requiere configuración adicional.

## Problemas Conocidos

Por favor, reporta cualquier problema en el repositorio de GitHub.

## Notas de la Versión

### 0.0.1

Versión inicial con soporte básico para JSP:
- Resaltado de sintaxis
- Autocompletado
- Snippets
- Soporte para acciones estándar JSP

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

## Licencia

Este proyecto está licenciado bajo la Licencia MIT - vea el archivo [LICENSE](LICENSE) para más detalles.

**¡Disfruta!**
