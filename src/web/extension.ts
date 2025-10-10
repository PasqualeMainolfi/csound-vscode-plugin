// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { addTokensToDocumentSet, clearTokensForDocumentSet, completionItemProvider } from "../completionProvider";
import { CsoundWebViewProvider } from "../webview/csoundWebViewProvider";

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Create and register the WebView provider
  const csoundWebViewProvider = new CsoundWebViewProvider(context.extensionUri);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CsoundWebViewProvider.viewType,
      csoundWebViewProvider
    )
  );

  // Helper function to get file content
  const getActiveDocumentContent = (textEditor: vscode.TextEditor): string | null => {
    const document = textEditor.document;
    
    if (document.languageId === "csound-csd") {
      return document.getText();
    } else if (document.languageId === "csound-orc" || document.languageId === "csound-sco") {
      // For .orc/.sco files, we need to read both files
      const baseName = document.fileName.substring(0, document.fileName.length - 4);
      // For now, just return the current file content with a note
      // In a full implementation, you'd want to read both .orc and .sco files
      return `; Note: This is ${document.languageId} content. Full .orc/.sco support needs implementation.\n${document.getText()}`;
    }
    
    return null;
  };

  // Helper function to get selected text or relevant text for evaluation
  const getEvalText = (textEditor: vscode.TextEditor): string => {
    const document = textEditor.document;
    const selection = textEditor.selection;
    
    if (!selection.isEmpty) {
      return document.getText(selection);
    }
    
    // If no selection, get the current line
    const line = document.lineAt(selection.active.line);
    return line.text;
  };

  // Add autocomplete for opcodes
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      ["csound-csd", "csound-orc"],
      completionItemProvider,
      ""
    )
  );

  // Listen for changes in text documents
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const document = event.document;

      event.contentChanges.forEach(change => {
        const lineNumber = change.range.start.line;
        const lineText = document.lineAt(lineNumber).text;
        const changeText = change.text;

        if (/\W/.test(changeText)) {
          // Add tokens from the current line
          addTokensToDocumentSet(document, lineText);
        }
      });
    })
  );

  // Listen for when an editor becomes active (e.g., switching between files)
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        const document = editor.document;
        addTokensToDocumentSet(document, document.getText()); // Parse the active document and add tokens
      }
    })
  );

  // Handle already open files when the extension is activated
  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document;
    addTokensToDocumentSet(document, document.getText()); // Parse the currently active file
  }

  // Clean up token sets when a document is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      const uri = document.uri.toString();
      clearTokensForDocumentSet(uri); // Remove the token set for this document
    })
  );

  const showOpcodeReferenceCommand = vscode.commands.registerCommand(
    "extension.showOpcodeReference",
    () => {
      vscode.window.showInformationMessage(
        "Opcode reference not yet implemented for web. Please refer to the Csound documentation online."
      );
    }
  );
  context.subscriptions.push(showOpcodeReferenceCommand);

  // play command - now uses WebView
  const playCommand = vscode.commands.registerTextEditorCommand(
    "extension.csoundPlayActiveDocument",
    async (textEditor: vscode.TextEditor) => {
      const content = getActiveDocumentContent(textEditor);
      if (content) {
        // Use relative path from workspace instead of just filename
        const relativePath = vscode.workspace.asRelativePath(textEditor.document.uri);
        await csoundWebViewProvider.playCsd(content, relativePath);
        
        // Show the WebView panel
        vscode.commands.executeCommand('csound.webview.focus');
      } else {
        vscode.window.showErrorMessage(
          "Please open a .csd, .orc, or .sco file to play with Csound."
        );
      }
    }
  );
  context.subscriptions.push(playCommand);

  const killCommand = vscode.commands.registerTextEditorCommand(
    "extension.csoundKillCsoundProcess",
    () => {
      csoundWebViewProvider.stopCsound();
    }
  );
  context.subscriptions.push(killCommand);

  const evalOrcCommand = vscode.commands.registerTextEditorCommand(
    "extension.csoundEvalOrc",
    (textEditor: vscode.TextEditor) => {
      const content = getEvalText(textEditor);
      if (content.trim()) {
        csoundWebViewProvider.evalOrc(content);
      } else {
        vscode.window.showWarningMessage("No orchestra code selected or found.");
      }
    }
  );
  context.subscriptions.push(evalOrcCommand);

  const evalScoCommand = vscode.commands.registerTextEditorCommand(
    "extension.csoundEvalSco",
    (textEditor: vscode.TextEditor) => {
      const content = getEvalText(textEditor);
      if (content.trim()) {
        csoundWebViewProvider.evalSco(content);
      } else {
        vscode.window.showWarningMessage("No score code selected or found.");
      }
    }
  );
  context.subscriptions.push(evalScoCommand);
}

// this method is called when your extension is deactivated
export function deactivate() {}
