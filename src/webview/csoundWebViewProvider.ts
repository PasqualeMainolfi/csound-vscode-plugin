import * as vscode from 'vscode';
import * as path from 'path';

export class CsoundWebViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'csound.webview';
    
    private _view?: vscode.WebviewView;
    private _csoundReady = false;
    private _messageQueue: any[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'csoundReady':
                        this._csoundReady = true;
                        this._processMessageQueue();
                        break;
                    case 'csoundStatus':
                        vscode.window.showInformationMessage(`Csound: ${message.message}`);
                        break;
                    case 'csoundError':
                        vscode.window.showErrorMessage(`Csound Error: ${message.message}`);
                        break;
                    case 'csoundOutput':
                        // Could be used to show Csound output in a dedicated output channel
                        console.log('Csound Output:', message.message);
                        break;
                }
            },
            undefined,
            []
        );
    }

    public async playCsd(csdContent: string, filename?: string) {
        // Collect project files
        const projectFiles = await this.collectProjectFiles();
        
        const message = {
            command: 'playCsd',
            content: csdContent,
            filename: filename || 'untitled.csd',
            projectFiles: projectFiles
        };

        if (this._csoundReady && this._view) {
            this._view.webview.postMessage(message);
        } else {
            this._messageQueue.push(message);
        }
    }

    public evalOrc(orcContent: string) {
        const message = {
            command: 'evalOrc',
            content: orcContent
        };

        if (this._csoundReady && this._view) {
            this._view.webview.postMessage(message);
        } else {
            this._messageQueue.push(message);
        }
    }

    public evalSco(scoContent: string) {
        const message = {
            command: 'evalSco',
            content: scoContent
        };

        if (this._csoundReady && this._view) {
            this._view.webview.postMessage(message);
        } else {
            this._messageQueue.push(message);
        }
    }

    public stopCsound() {
        const message = {
            command: 'stop'
        };

        if (this._csoundReady && this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private _processMessageQueue() {
        while (this._messageQueue.length > 0 && this._view) {
            const message = this._messageQueue.shift();
            this._view.webview.postMessage(message);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'csound-webview.js'));

        // Do the same for the stylesheet.
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'vscode.css'));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.css'));

        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-inline' data: blob:; worker-src 'self' data: blob: 'unsafe-inline'; connect-src data: blob:; child-src data: blob:;">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleResetUri}" rel="stylesheet">
                <link href="${styleVSCodeUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
                <title>Csound WebAudio</title>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h2>Csound WebAudio Engine</h2>
                        <div class="status" id="status">Initializing...</div>
                    </div>
                    
                    <div class="controls">
                        <button id="initButton" class="button primary">Initialize Csound</button>
                        <button id="stopButton" class="button secondary" disabled>Stop</button>
                    </div>
                    
                    <div class="output-section">
                        <h3>Console Output</h3>
                        <div id="console" class="console"></div>
                    </div>
                    
                    <div class="info-section">
                        <div class="info-item">
                            <label>Sample Rate:</label>
                            <span id="sampleRate">-</span>
                        </div>
                        <div class="info-item">
                            <label>Channels:</label>
                            <span id="channels">-</span>
                        </div>
                        <div class="info-item">
                            <label>Status:</label>
                            <span id="engineStatus">Not initialized</span>
                        </div>
                    </div>
                </div>
                
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    private async collectProjectFiles(): Promise<{[path: string]: string}> {
        const projectFiles: {[path: string]: string} = {};
        
        console.log('collectProjectFiles: Starting file collection...');
        
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceFolder = vscode.workspace.workspaceFolders[0];
            console.log(`collectProjectFiles: Workspace folder: ${workspaceFolder.uri.fsPath}`);
            
            try {
                // Find all relevant files in the workspace
                const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.{csd,orc,sco,wav,aif,aiff,txt,inc}');
                console.log(`collectProjectFiles: Searching with pattern: ${pattern.pattern}`);
                const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
                console.log(`collectProjectFiles: Found ${files.length} files`);
                
                for (const file of files) {
                    try {
                        const content = await vscode.workspace.fs.readFile(file);
                        const relativePath = vscode.workspace.asRelativePath(file);
                        console.log(`collectProjectFiles: Processing ${relativePath}`);
                        
                        // Convert to string (assuming text files for now)
                        // For binary files like WAV, we'd need different handling
                        if (file.path.match(/\.(wav|aif|aiff)$/i)) {
                            console.log(`collectProjectFiles: Skipping binary file ${relativePath}`);
                            continue;
                        }
                        
                        // Convert Uint8Array to string (Buffer is not available in web context)
                        const decoder = new (globalThis as any).TextDecoder('utf-8');
                        projectFiles[relativePath] = decoder.decode(content);
                        console.log(`collectProjectFiles: Added ${relativePath} (${content.length} bytes)`);
                    } catch (error) {
                        console.warn(`Failed to read file ${file.path}:`, error);
                    }
                }
            } catch (error) {
                console.warn('Failed to collect project files:', error);
            }
        } else {
            console.log('collectProjectFiles: No workspace folders found');
        }
        
        console.log(`collectProjectFiles: Collected ${Object.keys(projectFiles).length} files total`);
        return projectFiles;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
