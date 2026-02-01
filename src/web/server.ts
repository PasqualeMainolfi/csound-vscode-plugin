/// <reference lib="webworker" />
/// <reference lib="dom" />

import { SEMANTIC_TOKEN_TYPE, mapTokenToIndex, captureToTokenType } from './utils';
import { TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { Parser, Language, Tree, Query } from 'web-tree-sitter';
import {
    createConnection,
    BrowserMessageReader,
    BrowserMessageWriter,
    TextDocuments,
    TextDocumentSyncKind,
    InitializeResult,
    Hover,
    CompletionItem,
    CompletionItemKind,
    SemanticTokensBuilder,
    DocumentFormattingParams
} from 'vscode-languageserver/browser';

// TODO: resolve included files

const messageReader = new BrowserMessageReader(self as any);
const messageWriter = new BrowserMessageWriter(self as any);
const connection = createConnection(messageReader, messageWriter);

const documents = new TextDocuments(TextDocument);

interface DocState {
    tree: Tree | null;
    text: string;
    textLines: string[];
    version: number;
};

function updateTree(document: TextDocument) {
    if (!parser) { return; }
    const uri = document.uri;
    const text = document.getText();
    const textLines = text.split(/\r?\n/);
    const version = document.version;

    const oldState = trees.get(uri);
    const newTree = parser.parse(text);

    if (newTree) {
        trees.set(uri, {
            tree: newTree,
            text: text,
            textLines: textLines,
            version: version
        });
    }
}

let parser: Parser;
let csoundLanguage: Language;
let trees: Map<string, DocState> = new Map();

let highlightsQuery: Query;
let indentsQuery: Query;
let injectionsQuery: Query;


function base64ToUint8Array(base64: string | undefined): Uint8Array {
    if (!base64) {
        throw new Error("Missing Base64 data (undefined)");
    }

    const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

connection.onInitialize(async (params): Promise<InitializeResult> => {
    const options = params.initializationOptions;
    if (!options) { throw new Error("Missing options"); };

    try {
        const coreBuffer = base64ToUint8Array(options.mainWasmUri);
        await Parser.init({ wasmBinary: coreBuffer } as any);

        parser = new Parser();

        const csoundBuffer = base64ToUint8Array(options.csoundWasmUri);
        csoundLanguage = await Language.load(csoundBuffer);

        parser.setLanguage(csoundLanguage);

        if (options.highlights) {
            highlightsQuery = new Query(csoundLanguage, options.highlights);
        }
        if (options.indents) {
            indentsQuery = new Query(csoundLanguage, options.indents);
        }
        if (options.injections) {
            injectionsQuery = new Query(csoundLanguage, options.injections);
        }
        connection.console.log("Csound LSP-Web initialized!");

    } catch (error: any) {
        console.error("LSP Init Error:", error);
        return {
            capabilities: {},
            retry: false,
            message: error.message
        } as any;
    }

    return {
        capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: SEMANTIC_TOKEN_TYPE,
                    tokenModifiers: []
                },
                full: true
            },
            documentOnTypeFormattingProvider: {
                firstTriggerCharacter: '\n',
                moreTriggerCharacter: ['n', 'f', '}']
            },
            documentFormattingProvider: true
        }
    };
});

documents.onDidClose(params => {
    trees.delete(params.document.uri);
});

documents.onDidChangeContent(change => {
    updateTree(change.document);
});

// connection.onHover(({ textDocument, position }): Hover | null => {});
// connection.onCompletion(({ textDocument, position }): CompletionItem[] => {});

connection.languages.semanticTokens.on((params) => {
    const doc = documents.get(params.textDocument.uri);
    const docState = trees.get(params.textDocument.uri);
    if (!docState || !docState.tree || !highlightsQuery) { return { data: [] }; }
    if (!doc || (doc.version !== docState.version)) { return { data: [] }; }

    const tokenBuilder = new SemanticTokensBuilder();
    const captures = highlightsQuery.captures(docState.tree.rootNode);

    const sortedCaptures = captures.sort((a, b) => {
        const startA = a.node.startPosition;
        const startB = b.node.startPosition;
        if (startA.row !== startB.row) { return startA.row - startB.row; }
        if (startA.column !== startB.column) { return startA.column - startB.column; }
        return (b.node.endIndex - b.node.startIndex) - (a.node.endIndex - a.node.startIndex);
    });

    let lastRow = 0;
    let lastColumn = 0;

    for (const capture of sortedCaptures) {
        const node = capture.node;

        if (node.isError || node.isMissing) { continue; }

        const type = captureToTokenType(capture.name);
        const index = mapTokenToIndex(type);
        if (index < 0) { continue; }

        const start = node.startPosition;
        const end = node.endPosition;

        if (start.row < lastRow || (start.row === lastRow && start.column < lastColumn)) {
            continue;
        }

        if (start.row === end.row) {
            const length = end.column - start.column;
            if (length > 0) {
                tokenBuilder.push(start.row, start.column, length, index, 0);
                lastRow = start.row;
                lastColumn = end.column;
            }
        }
        else {
            const text = docState.text;
            const startByte = node.startIndex;
            const endByte = node.endIndex;
            const slicedText = text.slice(startByte, endByte);
            const lines = slicedText.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const lineText = lines[i];
                const length = lineText.length;

                if (length === 0) { continue; }

                const row = start.row + i;
                const col = i === 0 ? start.column : 0;
                if (row < lastRow || (row === lastRow && col < lastColumn)) {
                    continue;
                }
                tokenBuilder.push(row, col, length, index, 0);

                lastRow = row;
                lastColumn = col + length;
            }
        }
    }

    return tokenBuilder.build();
});

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
    const docState = trees.get(params.textDocument.uri);
    if (!docState || !indentsQuery) { return []; }

    const tree = docState?.tree;
    const text = docState.text;
    const textLines = docState.textLines;
    const indents = new Array(textLines.length).fill(0);

    const edits: TextEdit[] = [];
    const rootNode = tree?.rootNode;
    if (rootNode) {
        const captures = indentsQuery.captures(rootNode);
        for (const capture of captures) {
            const cnode = capture.node;
            const start = cnode.startPosition.row;
            const end = cnode.endPosition.row;

            const cname = capture.name;
            if (cname === "indent.begin") {
                for (let i = start + 1; i <= end; i++) {
                    if (i < indents.length) { indents[i]++; }
                };
            } else if (cname === "indent.end" || cname === "indent.branch") {
                if (start < indents.length) {
                    indents[start] = Math.max(0, indents[start] - 1);
                }
            };
        }

        for (let i = 0; i < indents.length; i++) {
            const line = textLines[i];
            if (line.trim().length === 0) {
                if (line.length > 0) {
                    edits.push({
                        range: {
                            start: { line: i, character: 0 },
                            end: { line: i, character: line.length }
                        },
                        newText: ''
                    });
                }
                continue;
            }

            const desLevel = indents[i];
            const desIndent = params.options.insertSpaces
                ? ' '.repeat(desLevel * params.options.tabSize)
                : '\t'.repeat(desLevel);
            const currentIndentMatch = line.match(/^\s*/);
            const currentIndent = currentIndentMatch ? currentIndentMatch[0] : '';
            if (currentIndent !== desIndent) {
                edits.push({
                    range: {
                        start: { line: i, character: 0 },
                        end: { line: i, character: currentIndent.length }
                    },
                    newText: desIndent
                });
            }
        }
    }

    return edits;

});


documents.listen(connection);
connection.listen();
