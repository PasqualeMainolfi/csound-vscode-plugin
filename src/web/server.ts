/// <reference lib="webworker" />
/// <reference lib="dom" />

import { DiagnosticSeverity, DiagnosticTag, TextDocumentSyncKind } from 'vscode-languageserver';
import { TextDocument, TextEdit } from 'vscode-languageserver-textdocument';
import { Parser, Language, Query, Point } from 'web-tree-sitter';
import { updateTree, DocState, iterateTree, parseUdoFile, TreeReport } from './parser';
import {
    SEMANTIC_TOKEN_TYPE,
    getSemanticTokens,
    getInjections,
    getUnusedLabelFromKind,
    getUndefinedLabelFromKind,
    getCleanNodeText,
    ResolveIncludedUdoResult
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
    InsertTextFormat,
    Diagnostic
} from 'vscode-languageserver/browser';

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

let diagnosticReport: TreeReport;

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
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Full,
                save: true
            },
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

documents.onDidChangeContent(async (change) => {
    updateTree(parser, change.document, docs);
    let doc = docs.get(change.document.uri);
    let diagnostics: Diagnostic[] = [];
    let cachedDiagnostics: Set<string> = new Set<string>();
    if (doc) {
        diagnosticReport = iterateTree(doc.tree!, jsonMacros);
        doc.cachedTypedVars = diagnosticReport.typedVars;
        doc.userDefinitions = diagnosticReport.userDefinitions;

        for (const varRef of doc.userDefinitions.userUnusedVars) {
            const findedNode = doc
                .tree!
                .rootNode
                .descendantForIndex(varRef.nodeLocation, varRef.nodeLocation);

            if (!findedNode) { continue; }

            const pKind = findedNode.parent?.type || "";
            const currentDiagnostic: Diagnostic = {
                range: {
                    start: {
                        line: findedNode.startPosition.row,
                        character: findedNode.startPosition.column
                    },
                    end: {
                        line: findedNode.endPosition.row,
                        character: findedNode.endPosition.column
                    }
                },
                severity: DiagnosticSeverity.Hint,
                source: "csound-lsp",
                message: getUnusedLabelFromKind(pKind),
                tags: [DiagnosticTag.Unnecessary]
            };

            const diagKey = `${currentDiagnostic.range.start.line}-${currentDiagnostic.range.end.character}-${currentDiagnostic.message}`;
            if (!cachedDiagnostics.has(diagKey)) {
                cachedDiagnostics.add(diagKey);
                diagnostics.push(currentDiagnostic);
            };
        };

        for (const varRef of doc.userDefinitions.userUndefinedVars) {
            const findedNode = doc
                .tree!
                .rootNode
                .descendantForIndex(varRef.nodeLocation, varRef.nodeLocation);

            if (!findedNode) { continue; }

            const pKind = findedNode.parent?.type || "";
            for (const nodeRange of varRef.references) {
                let pflag = pKind === "macro_usage"; // need to check if var is in udo file
                if (!pflag) {
                    const currentDiagnostic: Diagnostic = {
                        range: {
                            start: {
                                line: nodeRange.startPosition.row,
                                character: nodeRange.startPosition.column
                            },
                            end: {
                                line: nodeRange.endPosition.row,
                                character: nodeRange.endPosition.column
                            }
                        },
                        severity: DiagnosticSeverity.Error,
                        source: "csound-lsp",
                        message: getUndefinedLabelFromKind(pKind),
                        tags: []
                    };

                    const diagKey = `${currentDiagnostic.range.start.line}-${currentDiagnostic.range.end.character}-${currentDiagnostic.message}`;
                    if (!cachedDiagnostics.has(diagKey)) {
                        cachedDiagnostics.add(diagKey);
                        diagnostics.push(currentDiagnostic);
                    };
                }
            }
        }
    }

    connection.sendDiagnostics({
        uri: change.document.uri,
        diagnostics: diagnostics
    });

});

documents.onDidSave(async (change) => {
    let doc = docs.get(change.document.uri);
    if (doc) {
        for (const [udoFilePath, udoFileCaptured] of diagnosticReport.includedUdoFiles.entries()) { // move in onSave
            let pflag = false;
            try {
                const result = await connection.sendRequest<ResolveIncludedUdoResult>("csound-lsp/resolveIncludedUdo", {
                    documentPath: change.document.uri,
                    udoPath: udoFilePath
                });

                if (result && result.content) {
                    let udoFile = doc.cachedIncludedUdoFiles.get(udoFilePath);
                    if (udoFile && udoFile.contentHash !== result.contentHash) {
                        udoFile.content = result.content;
                        udoFile.contentHash = result.contentHash;
                        pflag = true;
                    } else {
                        udoFileCaptured.content = result.content;
                        udoFileCaptured.contentHash = result.contentHash;
                        udoFileCaptured.fileName = result.pathBaseName;
                        doc.cachedIncludedUdoFiles.set(udoFilePath, udoFileCaptured);
                        pflag = true;
                    }
                };

                if (pflag) {
                    let cachedUdoFile = doc.cachedIncludedUdoFiles.get(udoFilePath);
                    if (cachedUdoFile) {
                        parseUdoFile(cachedUdoFile, parser);
                    } else {
                        connection.console.warn("Something went wrong while parsing .udo file...");
                    }
                }

            } catch (err) {
                connection.console.warn(`Something went wrong in resolve .udo file: ${err}`);
            }
        }

        const udoToRemoveFromCache = Array.from(doc.cachedIncludedUdoFiles.keys())
            .filter(k => !diagnosticReport.includedUdoFiles.has(k));

        for (const udoToRemoveKey of udoToRemoveFromCache) {
            doc.cachedIncludedUdoFiles.delete(udoToRemoveKey);
        }
    }

});

connection.onHover(({ textDocument, position }): Hover | null => {
    const docState = docs.get(textDocument.uri);
    if (!docState || !docState.tree) { return null; }

    const rootNode = docState.tree!.rootNode;
    const nodePos: Point = { row: position.line, column: position.character };
    const currentNode = rootNode.descendantForPosition(nodePos, nodePos);

    if (!currentNode) { return null; }

    const nodeKind = currentNode.type;
    const nodeText = docState.text.slice(currentNode.startIndex, currentNode.endIndex).trim();
    const opName = getCleanNodeText(nodeText);

    switch (nodeKind) {
        case "opcode_name":
            const doc = opcodeFromManual[opName];
            if (doc) {
                return {
                    contents: {
                        kind: "markdown",
                        value: doc
                    }
                };
            }
            const localUdo = docState.userDefinitions.userDefinedOpcodes.get(opName);
            if (localUdo) {
                const md = `## User-Defined Opcode\n\`\`\`csound\n${localUdo.signature}\n\`\`\``;
                return {
                    contents: {
                        kind: "markdown",
                        value: md
                    }
                };
            }
            for (const udoFile of docState.cachedIncludedUdoFiles.values()) {
                const ud = udoFile.userDefinedOpcodes.get(opName);
                if (ud) {
                    const md = `## User-Defined Opcode (imported from ${udoFile.fileName})\n\`\`\`csound\n${ud.signature}\n\`\`\``;
                    return {
                        contents: {
                            kind: "markdown",
                            value: md
                        }
                    };
                }
            }
            return null;
        case "identifier":
            const nodeParent = currentNode.parent;
            const isType = nodeParent && ["typed_identifier", "type_identifier", "typed_opcode_name"].includes(nodeParent.type);
            let childTypeName = getCleanNodeText(currentNode.text) ?? "";
            if (isType) {
                const sd = docState.userDefinitions.userDefinedTypes.get(childTypeName);
                if (sd) {
                    const md = `## User-Defined Type\n\`\`\`csound\n${sd.udtFormat}\n\`\`\``;
                    return {
                        contents: {
                            kind: "markdown",
                            value: md
                        }
                    };
                }
                const opTypedName = opcodeFromManual[childTypeName];
                if (opTypedName) {
                    return {
                        contents: {
                            kind: "markdown",
                            value: opTypedName
                        }
                    };
                }
                for (const udoFile of docState.cachedIncludedUdoFiles.values()) {
                    const sd = udoFile.userDefinedTypes.get(opName);
                    if (sd) {
                        const md = `## User-Defined Type (imported from ${udoFile.fileName})\n\`\`\`csound\n${sd.udtFormat}\n\`\`\``;
                        return {
                            contents: {
                                kind: "markdown",
                                value: md
                            }
                        };
                    }
                }
            } else {
                return null;
            }
        default:
            return null;
    }
});

connection.onCompletion(({ textDocument, position }): CompletionItem[] => {
    let items: CompletionItem[] = [];
    const docState = docs.get(textDocument.uri);
    if (!docState || !docState.tree) { return items; }

    const rootNode = docState.tree?.rootNode;
    const nodePos: Point = { row: position.line, column: position.character - 1};
    const nodeAtPos = rootNode.descendantForPosition(nodePos, nodePos);

    if (!nodeAtPos) { return items; }

    const nodeKind = nodeAtPos.type;
    const findedNodeText = nodeAtPos.text;

    switch (nodeKind) {
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
            for (const udoFile of docState.cachedIncludedUdoFiles.values()) {
                for (const udtName of udoFile.typeList) {
                    const structDoc = `Data type ${udtName} (from ${udoFile.fileName})`;
                    items.push({
                        label: udtName,
                        kind: CompletionItemKind.Field,
                        detail: udtName,
                        insertText: udtName,
                        documentation: structDoc
                    });
                }
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
            for (const udoFile of docState.cachedIncludedUdoFiles.values()) {
                for (const includedMacro of udoFile.userDefinedMacros.values()) {
                    const macroDoc = `User-Defined macro (from ${udoFile.fileName})`;
                    items.push({
                        label: includedMacro.macroLabel,
                        kind: CompletionItemKind.Field,
                        detail: `# ${includedMacro.macroValue} #`,
                        insertText: includedMacro.macroName,
                        documentation: macroDoc
                    });
                }
            }
            for (const userMacro of docState.userDefinitions.userDefinedMacros.values()) {
                items.push({
                    label: userMacro.macroLabel,
                    kind: CompletionItemKind.Field,
                    detail: `# ${userMacro.macroValue} #`,
                    insertText: userMacro.macroName,
                    documentation: "User-Defined macro"
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
            const nodeParent = nodeAtPos.parent;
            const pKind = nodeParent?.type ?? "";

            switch (pKind) {
                case "struct_access":
                    const childStruct = nodeParent?.childForFieldName("called_struct");
                    if (childStruct) {
                        const sName = getCleanNodeText(childStruct.text);
                        if (sName.length > 0) {
                            const structTypeName = docState.cachedTypedVars.get(sName) ?? "";
                            const members = docState.userDefinitions.userDefinedTypes.get(structTypeName)?.udtMembers;
                            if (members) {
                                for (const member of members) {
                                    const structDoc = `Field od struct ${sName} (Type: ${structTypeName})`;
                                    items.push({
                                        label: member.name,
                                        kind: CompletionItemKind.Field,
                                        detail: `: ${member.type}`,
                                        insertText: member.name,
                                        documentation: structDoc
                                    });
                                }
                            }

                            for (const udoFile of docState.cachedIncludedUdoFiles.values()) {
                                const udt = udoFile.userDefinedTypes.get(structTypeName);
                                const members = udt?.udtMembers;
                                if (members) {
                                    for (const member of members) {
                                        const structDoc = `Field od struct ${sName} (Type: ${structTypeName}) (from ${udoFile.path})`;
                                        items.push({
                                            label: member.name,
                                            kind: CompletionItemKind.Field,
                                            detail: `: ${member.type}`,
                                            insertText: member.name,
                                            documentation: structDoc
                                        });
                                    }
                                }
                            }
                        }
                    }
                    return items;
                default:
                    if (
                        pKind !== "flag_content" && pKind !== "struct_access" &&
                        pKind !== "modern_udo_inputs" && pKind !== "ERROR" &&
                        nodeAtPos.type !== "legacy_udo_args"
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
