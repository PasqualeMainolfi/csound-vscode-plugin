/// <reference lib="webworker" />
/// <reference lib="dom" />

import { TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { Parser, Language, Tree, Query, Point } from 'web-tree-sitter';
import { updateTree, DocState } from './parser';
import {
    SEMANTIC_TOKEN_TYPE,
    getSemanticTokens,
    getInjections
} from './utils';

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
// TODO: resolve var scope

const messageReader = new BrowserMessageReader(self as any);
const messageWriter = new BrowserMessageWriter(self as any);
const connection = createConnection(messageReader, messageWriter);

const documents = new TextDocuments(TextDocument);

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

let injectedLanguages: Record<string, { parser: Parser, query: Query }> = {};

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

        // csound
        parser = new Parser();
        const csoundBuffer = base64ToUint8Array(options.csoundWasmUri);
        csoundLanguage = await Language.load(csoundBuffer);
        parser.setLanguage(csoundLanguage);
        highlightsQuery = new Query(csoundLanguage, options.highlights);
        indentsQuery = new Query(csoundLanguage, options.indents);
        injectionsQuery = new Query(csoundLanguage, options.injections);

        opcodeFromManual = options.opcodeInfos;
        jsonOpcodes = options.opcodeCompletions;
        jsonFlags = options.flagCompletions;
        jsonMacros = options.macroCompletions;

        // html
        const htmlBuffer = base64ToUint8Array(options.htmlWasmUri);
        const htmlLanguage = await Language.load(htmlBuffer);
        const htmlParser = new Parser();
        htmlParser.setLanguage(htmlLanguage);
        const htmlHighlightsQuery = new Query(htmlLanguage, options.htmlHighlights);

        // json
        const jsonBuffer = base64ToUint8Array(options.jsonWasmUri);
        const jsonLanguage = await Language.load(jsonBuffer);
        const jsonParser = new Parser();
        jsonParser.setLanguage(jsonLanguage);
        const jsonHighlightsQuery = new Query(jsonLanguage, options.jsonHighlights);

        // python
        const pythonBuffer = base64ToUint8Array(options.pythonWasmUri);
        const pythonLanguage = await Language.load(pythonBuffer);
        const pythonParser = new Parser();
        pythonParser.setLanguage(pythonLanguage);
        const pythonHighlightsQuery = new Query(pythonLanguage, options.pythonHighlights);

        // bash
        const bashBuffer = base64ToUint8Array(options.bashWasmUri);
        const bashLanguage = await Language.load(bashBuffer);
        const bashParser = new Parser();
        bashParser.setLanguage(bashLanguage);
        const bashHighlightsQuery = new Query(bashLanguage, options.bashHighlights);

        injectedLanguages["csound"] = { parser: parser, query: highlightsQuery };
        injectedLanguages["html"] = { parser: htmlParser, query: htmlHighlightsQuery };
        injectedLanguages["json"] = { parser: jsonParser, query: jsonHighlightsQuery };
        injectedLanguages["python"] = { parser: pythonParser, query: pythonHighlightsQuery };
        injectedLanguages["bash"] = { parser: bashParser, query: bashHighlightsQuery };

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
    updateTree(parser, change.document, docs);
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
                    return items;
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

    const csTokens = getSemanticTokens(highlightsQuery, docState.tree, docState.text);
    const injTokens = getInjections(injectionsQuery, docState.tree, injectedLanguages);

    const allTokens = [...csTokens, ...injTokens];
    const sortedTokens = allTokens.sort((a, b) => {
        if (a.line !== b.line) { return a.line - b.line; }
        return a.char - b.char;
    });

    for (const token of sortedTokens) {
        tokenBuilder.push(token.line, token.char, token.length, token.index, token.modifier);
    };

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
