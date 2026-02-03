/// <reference lib="webworker" />
/// <reference lib="dom" />

import { SEMANTIC_TOKEN_TYPE, mapTokenToIndex, captureToTokenType, getDeltaPos } from './utils';
import { TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { Parser, Language, Tree, Query, Point } from 'web-tree-sitter';
import {
    createConnection,
    BrowserMessageReader,
    BrowserMessageWriter,
    TextDocuments,
    InitializeResult,
    Hover,
    CompletionItem,
    CompletionItemKind,
    SemanticTokensBuilder,
    DocumentFormattingParams,
    InsertTextFormat
} from 'vscode-languageserver/browser';

// TODO: resolve included .udo files
// TODO: resolve unused and undefined vars
// TODO: language injections
// TODO: resolve var scope

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

    const newTree = parser.parse(text);

    if (newTree) {
        docs.set(uri, {
            tree: newTree,
            text: text,
            textLines: textLines,
            version: version
        });
    }
}

let parser: Parser;
let csoundLanguage: Language;
let docs: Map<string, DocState> = new Map();

let highlightsQuery: Query;
let indentsQuery: Query;
let injectionsQuery: Query;

let opcodeFromManual: Record<string, string>;

let jsonOpcodes: Map<string, any>;
let jsonFlags: Map<string, any>;
let jsonMacros: Map<string, any>;

// injections resources
let htmlParser: Parser;
let htmlLanguage: Language;
let htmlHighlightsQuery: Query;
let jsonParser: Parser;
let jsonLanguage: Language;
let jsonHighlightsQuery: Query;
let pythonParser: Parser;
let pythonLanguage: Language;
let pythonHighlightsQuery: Query;

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

        opcodeFromManual = options.opcodeInfos;
        jsonOpcodes = options.opcodeCompletions;
        jsonFlags = options.flagCompletions;
        jsonMacros = options.macroCompletions;

        // html
        const htmlBuffer = base64ToUint8Array(options.htmlWasmUri);
        htmlLanguage = await Language.load(htmlBuffer);
        htmlParser = new Parser();
        htmlParser.setLanguage(htmlLanguage);

        if (options.htmlHighlights) {
            htmlHighlightsQuery = new Query(htmlLanguage, options.htmlHighlights);
        }

        // json
        const jsonBuffer = base64ToUint8Array(options.jsonWasmUri);
        jsonLanguage = await Language.load(jsonBuffer);
        jsonParser = new Parser();
        jsonParser.setLanguage(jsonLanguage);

        if (options.jsonHighlights) {
            jsonHighlightsQuery = new Query(jsonLanguage, options.jsonHighlights);
        }

        // python
        const pythonBuffer = base64ToUint8Array(options.pythonWasmUri);
        pythonLanguage = await Language.load(pythonBuffer);
        pythonParser = new Parser();
        pythonParser.setLanguage(pythonLanguage);

        if (options.pythonHighlights) {
            pythonHighlightsQuery = new Query(pythonLanguage, options.pythonHighlights);
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
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['.', ':', '$', '-']
            },
            documentFormattingProvider: true
        }
    };
});

documents.onDidClose(params => {
    docs.delete(params.document.uri);
});

documents.onDidChangeContent(change => {
    updateTree(change.document);
});

connection.onHover(({ textDocument, position }): Hover | null => {
    const docState = docs.get(textDocument.uri);
    if (!docState || !docState.tree) { return; }

    const rootNode = docState.tree?.rootNode;
    const nodePos: Point = { row: position.line, column: position.character };
    const nodeAtPos = rootNode.descendantForPosition(nodePos, nodePos);
    const nodeKind = nodeAtPos.type;
    const nodeText = docState.text.slice(nodeAtPos.startIndex, nodeAtPos.endIndex).trim();

    switch (nodeKind) {
        case "opcode_name":
            const doc = opcodeFromManual[nodeText];
            if (!doc) { return null; }
            return {
                contents: {
                    kind: "markdown",
                    value: doc
                }
            };
        case "identifier":
            return;
        default:
            return null;
    }
});

connection.onCompletion(({ textDocument, position }): CompletionItem[] => {
    const docState = docs.get(textDocument.uri);
    if (!docState || !docState.tree) { return; }

    const rootNode = docState.tree?.rootNode;
    const nodePos: Point = { row: position.line, column: position.character };
    const nodeAtPos = rootNode.descendantForPosition(nodePos, nodePos);
    const nodeKind = nodeAtPos.type;

    switch (nodeKind) {
        case "struct_access":
            return;
        default:
            const targetLine = position.line;
            const targetChar = position.character;
            const textLine = docState.textLines[targetLine] || "";
            const nodeToFindPos: Point = { row: targetLine, column: targetChar - 1 };
            const findedNode = rootNode.descendantForPosition(nodeToFindPos, nodeToFindPos);
            const findedNodeKind = findedNode.type;
            const findedNodeText = findedNode.text;

            let items: CompletionItem[] = [];
            switch (findedNodeKind) {
                case ":":
                    const types = [
                        "a", "i", "k", "b", "S", "f", "w",
                        "InstrDef", "Instr", "Opcode", "OpcodeDef", "Complex"
                    ];
                    for (const ty of types) {
                        items.push({
                            label: ty,
                            kind: CompletionItemKind.Field,
                            insertText: ty,
                            documentation: `Data type ${ty}`
                        });
                    }
                    return items;
                case "$":
                    for (const [key, data] of jsonMacros) {
                        items.push({
                            label: key,
                            kind: CompletionItemKind.Field,
                            insertText: key,
                            detail: `Value: ${data["value"]}`,
                            documentation: `Equivalent to: ${data["equivalent_to"]}`
                        });
                    }
                    return items;
                case "flag_identifier":
                    for (const [key, data] of jsonFlags) {
                        const rawBody = data["body"];
                        const dataBody = Array.isArray(rawBody) ? rawBody.join('\n') : rawBody;
                        const sliceBody = dataBody.replace(/^--/, "");
                        items.push({
                            label: key,
                            kind: CompletionItemKind.Field,
                            insertText: sliceBody,
                            documentation: {
                                kind: "markdown",
                                value: data["description"]
                            }
                        });
                        }
                default:
                    if (findedNodeText.length) {
                        const nodeParent = findedNode.parent;
                        const pKind = nodeParent.type;
                        if (
                            pKind !== "flag_content" && pKind !== "struct_access" &&
                            pKind !== "modern_udo_inputs" && pKind !== "ERROR" &&
                            findedNode.type !== "legacy_udo_args"
                        ) {
                            for (const [key, data] of jsonOpcodes) {
                                if (key.startsWith(findedNodeText)) {
                                    const rawBody = data["body"];
                                    const dataBody: string = Array.isArray(rawBody) ? rawBody.join('\n') : rawBody;
                                    const isSnip: boolean = dataBody.includes("$");
                                    items.push({
                                        label: data["prefix"],
                                        kind: isSnip
                                            ? CompletionItemKind.Snippet
                                            : CompletionItemKind.Function,
                                        insertText: dataBody,
                                        insertTextFormat: isSnip
                                            ? InsertTextFormat.Snippet
                                            : InsertTextFormat.PlainText,
                                        documentation: data["description"]
                                    });
                                }
                            }
                        }
                    }
                    return items;
            }
    }
});

connection.languages.semanticTokens.on((params) => {
    const doc = documents.get(params.textDocument.uri);
    const docState = docs.get(params.textDocument.uri);
    if (!docState || !docState.tree || !highlightsQuery) { return { data: [] }; }
    if (!doc || (doc.version !== docState.version)) { return { data: [] }; }

    const tokenBuilder = new SemanticTokensBuilder();
    const captures = highlightsQuery.captures(docState.tree.rootNode);

    const sortedCaptures = getDeltaPos(captures);

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
    const docState = docs.get(params.textDocument.uri);
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
