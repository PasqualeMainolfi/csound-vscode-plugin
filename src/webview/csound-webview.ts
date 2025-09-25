// This script runs in the WebView context and has access to the browser APIs
// including WebAudio, which is what we need for @csound/browser

import { Csound, CsoundObj } from '@csound/browser';

// Define CsoundObj interface locally since it's not exported

// DOM type declarations for webview context
declare const acquireVsCodeApi: any;
declare const document: any;
declare const window: any;

class CsoundWebView {
    private vscode: any;
    private csound?: CsoundObj;
    private isInitialized = false;
    private isPlaying = false;

    constructor() {
        this.vscode = acquireVsCodeApi();
        this.setupUI();
        this.setupMessageListener();
        this.loadCsound();
    }

    private async loadCsound() {
        try {
            this.updateStatus('Csound module loaded, ready to initialize');
            this.enableInitButton();
        } catch (error) {
            this.updateStatus('Failed to load Csound module');
            this.logError(`Failed to load @csound/browser: ${error}`);
        }
    }

    private setupUI() {
        const initButton = document.getElementById('initButton') as any;
        const stopButton = document.getElementById('stopButton') as any;

        initButton?.addEventListener('click', () => this.initializeCsound());
        stopButton?.addEventListener('click', () => this.stopCsound());
    }

    private setupMessageListener() {
        window.addEventListener('message', (event: any) => {
            const message = event.data;
            
            switch (message.command) {
                case 'playCsd':
                    this.playCsd(message.content, message.filename, message.projectFiles);
                    break;
                case 'evalOrc':
                    this.evalOrc(message.content);
                    break;
                case 'evalSco':
                    this.evalSco(message.content);
                    break;
                case 'stop':
                    this.stopCsound();
                    break;
            }
        });
    }

    private async initializeCsound() {
        if (this.isInitialized) {
            return;
        }

        try {
            this.updateStatus('Initializing Csound...');
            this.disableInitButton();

            // Create AudioContext
            this.logOutput('Creating AudioContext...');
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            
            if (audioContext.state === 'suspended') {
                this.logOutput('Resuming suspended AudioContext...');
                await audioContext.resume();
            }
            this.logOutput(`AudioContext state: ${audioContext.state}`);

            // Intercept addModule calls to debug what URL @csound/browser is trying to load
            const originalAddModule = audioContext.audioWorklet.addModule.bind(audioContext.audioWorklet);
            audioContext.audioWorklet.addModule = async (url: string | URL, options?: any) => {
                this.logOutput(`🔍 @csound/browser trying to load worklet from: ${url}`);
                this.logOutput(`🔍 URL type: ${typeof url}`);
                
                if (typeof url === 'string') {
                    this.logOutput(`🔍 URL starts with blob:: ${url.startsWith('blob:')}`);
                    this.logOutput(`🔍 URL starts with data:: ${url.startsWith('data:')}`);
                    this.logOutput(`🔍 URL starts with http:: ${url.startsWith('http')}`);
                    this.logOutput(`🔍 First 100 chars: ${url.substring(0, 100)}`);
                }
                
                try {
                    const result = await originalAddModule(url, options);
                    this.logOutput(`✅ AudioWorklet module loaded successfully`);
                    return result;
                } catch (error) {
                    this.logOutput(`❌ AudioWorklet module loading failed: ${error}`);
                    if (error instanceof Error) {
                        this.logOutput(`❌ Error name: ${error.name}`);
                        this.logOutput(`❌ Error message: ${error.message}`);
                        if (error.name === 'AbortError') {
                            this.logOutput('💡 This is likely a CSP restriction in VSCode WebView');
                        }
                    }
                    throw error;
                }
            };

            // Use AudioWorklet only (no ScriptProcessorNode fallback)
            this.logOutput('Initializing Csound with AudioWorklet...');
            
            // Create Csound instance with AudioWorklet
            this.csound = await Csound({
                audioContext: audioContext,
                inputChannelCount: 2,
                outputChannelCount: 2,
                autoConnect: true,
                withPlugins: [],
                useWorker: false,      // Single-threaded
                useSAB: false,         // No SharedArrayBuffer
                useSPN: false          // Force AudioWorklet (no ScriptProcessorNode)
            });
            
            this.logOutput('✅ AudioWorklet initialization successful!');
            
            if (!this.csound) {
                throw new Error('Failed to create Csound instance');
            }

            // Set up event listeners
            this.csound.on('message', (message: string) => {
                this.logOutput(message);
            });

            this.isInitialized = true;
            this.updateStatus('Csound initialized and ready');
            this.updateEngineStatus('Ready');
            
            // Get and display Csound info
            const sr = await this.csound.getSr();
            const nchnls = await this.csound.getNchnls();
            this.updateSampleRate(sr.toString());
            this.updateChannels(nchnls.toString());

            // Enable stop button
            const stopButton = document.getElementById('stopButton') as any;
            if (stopButton) {
                stopButton.disabled = false;
            }

            // Notify extension that Csound is ready
            this.vscode.postMessage({
                type: 'csoundReady'
            });

        } catch (error) {
            this.updateStatus('Failed to initialize Csound');
            this.logError(`Initialization error: ${error}`);
            this.enableInitButton();
        }
    }

    private async playCsd(csdContent: string, filename: string, projectFiles?: {[path: string]: string}) {
        if (!this.csound || !this.isInitialized) {
            this.logError('Csound not initialized');
            return;
        }

        try {
            this.logOutput(`Playing CSD file: ${filename}`);
            
            // Debug: Check what project files we received
            if (projectFiles) {
                this.logOutput(`Received ${Object.keys(projectFiles).length} project files: ${Object.keys(projectFiles).join(', ')}`);
            } else {
                this.logOutput('No project files received - projectFiles is undefined/null');
            }
            
            // Stop any current performance
            await this.csound.stop();
            await this.csound.reset();
            
            // Step 1: Sync ALL project files to Csound's filesystem first
            if (projectFiles && Object.keys(projectFiles).length > 0) {
                this.logOutput('Syncing ALL project files to Csound filesystem...');
                await this.syncProjectFiles(projectFiles);
            } else {
                this.logOutput('Skipping project file sync - no files to sync');
            }
            
            // Step 2: Write the main CSD file to filesystem
            const encoder = new (window as any).TextEncoder();
            const csdData = encoder.encode(csdContent);
            await this.csound.fs.writeFile(filename, csdData);
            this.logOutput(`Written ${filename} to Csound filesystem`);
            
            // Step 3: Call csound.compileCsd with absolute path
            const absolutePath = filename.startsWith('/') ? filename : `/${filename}`;
            this.logOutput(`Calling csound.compileCsd("${absolutePath}", 0)...`);
            const result = await this.csound.compileCSD(absolutePath, 0);
            if (result !== 0) {
                this.logError(`Failed to compile CSD: ${result}`);
                return;
            }

            // Start performance
            const startResult = await this.csound.start();
            if (startResult !== 0) {
                this.logError(`Failed to start Csound: ${startResult}`);
                return;
            }

            this.updateEngineStatus('Playing');
            this.logOutput('CSD playback started');

        } catch (error) {
            this.logError(`Error playing CSD: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
            console.error('Full error object:', error);
        }
    }

    private async evalOrc(orcContent: string) {
        if (!this.csound || !this.isInitialized) {
            this.logError('Csound not initialized');
            return;
        }

        try {
            this.logOutput('Evaluating orchestra code...');
            const result = await this.csound.compileOrc(orcContent);
            if (result === 0) {
                this.logOutput('Orchestra code compiled successfully');
            } else {
                this.logError(`Orchestra compilation failed: ${result}`);
            }
        } catch (error) {
            this.logError(`Error evaluating orchestra: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
            console.error('Full error object:', error);
        }
    }

    private async evalSco(scoContent: string) {
        if (!this.csound || !this.isInitialized) {
            this.logError('Csound not initialized');
            return;
        }

        try {
            this.logOutput('Evaluating score code...');
            const result = await this.csound.inputMessage(scoContent);
            if (result === 0) {
                this.logOutput('Score code evaluated successfully');
            } else {
                this.logError(`Score evaluation failed: ${result}`);
            }
        } catch (error) {
            this.logError(`Error evaluating score: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
            console.error('Full error object:', error);
        }
    }

    private async stopCsound() {
        if (!this.csound) {
            this.logError('Csound not initialized');
            return;
        }

        try {
            this.logOutput('Stopping Csound...');
            await this.csound.stop();
            this.updateEngineStatus('Stopped');
            this.logOutput('Csound stopped');
        } catch (error) {
            this.logError(`Error stopping Csound: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
            console.error('Full error object:', error);
        }
    }

    private async syncProjectFiles(projectFiles: {[path: string]: string}) {
        try {
            for (const [filePath, content] of Object.entries(projectFiles)) {
                // Create directory structure recursively if needed
                const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
                if (dirPath) {
                    await this.createDirectoryRecursive(dirPath);
                }
                
                // Convert string to Uint8Array
                const encoder = new (window as any).TextEncoder();
                const data = encoder.encode(content);
                
                await this.csound!.fs.writeFile(filePath, data);
                this.logOutput(`Synced: ${filePath}`);
            }
            
            // List files to verify they were written
            try {
                const files = await this.csound!.fs.readdir('/');
                this.logOutput(`Root directory contents: ${files.join(', ')}`);
            } catch (error) {
                this.logOutput('Could not list root directory');
            }
        } catch (error) {
            this.logError(`Error syncing project files: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
        }
    }

    private async inlineIncludes(csdContent: string, projectFiles: {[path: string]: string}): Promise<string> {
        let processedContent = csdContent;
        
        // Find all #include statements
        const includeRegex = /#include\s+["']([^"']+)["']/g;
        let match;
        
        while ((match = includeRegex.exec(csdContent)) !== null) {
            const includePath = match[1];
            const fullMatch = match[0];
            
            this.logOutput(`Processing include: ${includePath}`);
            
            // Look for the file in project files
            const includeContent = projectFiles[includePath];
            if (includeContent) {
                this.logOutput(`Inlining ${includePath} (${includeContent.length} characters)`);
                // Replace the #include with the actual content
                processedContent = processedContent.replace(fullMatch, `; Inlined from ${includePath}\n${includeContent}\n; End of ${includePath}`);
            } else {
                this.logOutput(`Warning: Include file ${includePath} not found in project files`);
                // Remove the include statement to avoid errors
                processedContent = processedContent.replace(fullMatch, `; Missing include: ${includePath}`);
            }
        }
        
        return processedContent;
    }

    private async compileCsdManually(csdContent: string, filename: string): Promise<number> {
        try {
            // Parse CSD sections
            const orchestraMatch = csdContent.match(/<CsInstruments>([\s\S]*?)<\/CsInstruments>/i);
            const scoreMatch = csdContent.match(/<CsScore>([\s\S]*?)<\/CsScore>/i);
            const optionsMatch = csdContent.match(/<CsOptions>([\s\S]*?)<\/CsOptions>/i);
            
            // Set options if present
            if (optionsMatch) {
                const options = optionsMatch[1].trim().split(/\s+/);
                for (const option of options) {
                    if (option.trim()) {
                        this.logOutput(`Setting option: ${option}`);
                        await this.csound!.setOption(option);
                    }
                }
            }
            
            // Compile orchestra
            if (orchestraMatch) {
                const orchestra = orchestraMatch[1].trim();
                this.logOutput(`Compiling orchestra (${orchestra.length} characters)...`);
                const orcResult = await this.csound!.compileOrc(orchestra);
                if (orcResult !== 0) {
                    this.logError(`Orchestra compilation failed: ${orcResult}`);
                    return orcResult;
                }
                this.logOutput('Orchestra compiled successfully');
            }
            
            // Handle score
            if (scoreMatch) {
                const score = scoreMatch[1].trim();
                this.logOutput(`Processing score (${score.length} characters)...`);
                const scoreResult = await this.csound!.inputMessage(score);
                if (scoreResult !== 0) {
                    this.logError(`Score processing failed: ${scoreResult}`);
                    return scoreResult;
                }
                this.logOutput('Score processed successfully');
            }
            
            return 0;
        } catch (error) {
            this.logError(`Manual CSD compilation failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
            return -1;
        }
    }

    private async createDirectoryRecursive(dirPath: string) {
        const parts = dirPath.split('/').filter(part => part.length > 0);
        let currentPath = '';
        
        for (const part of parts) {
            currentPath += '/' + part;
            try {
                await this.csound!.fs.mkdir(currentPath);
                this.logOutput(`Created directory: ${currentPath}`);
            } catch (error) {
                // Directory might already exist, ignore error
            }
        }
    }

    private updateStatus(status: string) {
        const element = document.getElementById('status');
        if (element) {
            element.textContent = status;
        }
    }

    private updateEngineStatus(status: string) {
        const element = document.getElementById('engineStatus');
        if (element) {
            element.textContent = status;
        }
    }

    private updateSampleRate(sr: string) {
        const element = document.getElementById('sampleRate');
        if (element) {
            element.textContent = sr;
        }
    }

    private updateChannels(channels: string) {
        const element = document.getElementById('channels');
        if (element) {
            element.textContent = channels;
        }
    }

    private enableInitButton() {
        const button = document.getElementById('initButton') as any;
        if (button) {
            button.disabled = false;
        }
    }

    private disableInitButton() {
        const button = document.getElementById('initButton') as any;
        if (button) {
            button.disabled = true;
        }
    }

    private logOutput(message: string) {
        const console = document.getElementById('console');
        if (console) {
            const line = document.createElement('div');
            line.className = 'console-line';
            line.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
            console.appendChild(line);
            console.scrollTop = console.scrollHeight;
        }
    }

    private logError(message: string) {
        const console = document.getElementById('console');
        if (console) {
            const line = document.createElement('div');
            line.className = 'console-line error';
            line.textContent = `${new Date().toLocaleTimeString()}: ERROR: ${message}`;
            console.appendChild(line);
            console.scrollTop = console.scrollHeight;
        }
    }
}

// Initialize when the page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new CsoundWebView());
} else {
    new CsoundWebView();
}
