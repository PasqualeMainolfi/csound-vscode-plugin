# Csound vscode

This PR introduces a new Csound extension for Visual Studio Code built on top of a custom [Csound Language Server (LSP)](https://github.com/PasqualeMainolfi/csound-lsp) and a [Csound Tree-sitter grammar](https://github.com/PasqualeMainolfi/tree-sitter-csound) specifically designed for Csound.  

The extension aims to provide a modern, semantically aware editing experience for Csound users, fully compatible with Csound7.  

## Key Features

**LSP**  

- Advanced diagnostics
- Detection of unused variables
- Detection of undefined variables
- Opcode error reporting
- Advanced scoping logic, aware of instruments, UDOs, score blocks, and global contexts
- Precise error localization based on the Tree-sitter syntax tree

**Editor**  

- Format on type
- CodeLens for:
  - Running a script
  - Saving output to an audio file
  - Opening the Csound manual
- Code Actions for quick fixes and navigation

**Completion & Hover**  

- Opcode completion
- Option/flag completion
- Hover support for:
  - Built-in opcodes
  - User-defined opcodes (UDOs)
  - User-defined types

**Commands exposed by the Language Server**  

The server exposes the following commands:  

- `csound-lsp.run_file` — run the current Csound script
- `csound-lsp.to_audio_file` — render and save output to an audio file
- `csound-lsp.open_manual` — open the Csound reference manual

**Offline Manual (Web Preview)**  

- The Csound HTML reference manual is bundled with the language server
- A lightweight local HTTP server is started by the server
- The manual is displayed inside a VS Code Webview
- Fully functional offline browsing, including links, searching and assets

**Language Injections**  

- Python and HTML language injections are supported inside Csound files
- Enables proper highlighting and tooling for embedded code

## Technical Notes  

- Syntax parsing is handled via Tree-sitter
- Semantic analysis is built directly on the syntax tree
- The LSP architecture is modular and designed for future extensions

## Future Work

Planned next steps include:

- Support for Csound plugins (not yet tested)
- Deeper support for Cabbage blocks
- Additional semantic checks, completions, and editor actions  

This PR lays the groundwork for a complete and modern Csound development environment in VS Code, aligned with current language-server–based tooling.
Feedback and testing are highly appreciated.
