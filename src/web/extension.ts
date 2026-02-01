// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { CsoundWebViewProvider } from "../webview/csoundWebViewProvider";
import { LanguageClient, LanguageClientOptions } from 'vscode-languageclient/browser';

async function getWasmBase64(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    let binary = '';
    for (let i = 0; i < data.byteLength; i++) {
        binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(data);
    } catch {
        return "";
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    const serverMain = vscode.Uri.joinPath(context.extensionUri, 'dist/web/server.js');
    const coreWasmUri = vscode.Uri.joinPath(context.extensionUri, 'dist/web/web-tree-sitter.wasm');
    const csoundWasmUri = vscode.Uri.joinPath(context.extensionUri, 'dist/web/tree-sitter-csound.wasm');
    const queriesBaseUri = vscode.Uri.joinPath(context.extensionUri, 'dist/web/queries');

    const worker =  new Worker(serverMain.toString());

    const [coreData, csoundData, highlights, indents, injections] = await Promise.all([
        getWasmBase64(coreWasmUri),
        getWasmBase64(csoundWasmUri),
        readTextFile(vscode.Uri.joinPath(queriesBaseUri, 'highlights.scm')),
        readTextFile(vscode.Uri.joinPath(queriesBaseUri, 'indents.scm')),
        readTextFile(vscode.Uri.joinPath(queriesBaseUri, 'injections.scm'))
    ]);

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { language: 'csound' },
        ],
        initializationOptions: {
            mainWasmUri: coreData,
            csoundWasmUri: csoundData,
            highlights: highlights,
            indents: indents,
            injections: injections,
        }
    };

    const client = new LanguageClient(
        'csoundWebLsp',
        'Csound Web LSP',
        clientOptions,
        worker
    );

    client.start();

    context.subscriptions.push({
        dispose: () => client.stop()
    });

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
