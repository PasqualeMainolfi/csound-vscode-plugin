import { Parser, Query, Tree, Node } from "web-tree-sitter";

export interface ResolveIncludedUdoRequest {
    documentPath: string,
    udoPath: string
}

export interface ResolveIncludedUdoResult {
    uri: string,
    content: string,
    contentHash: string,
    pathBaseName: string
}

export const SEMANTIC_TOKEN_TYPE = [
    "decorator",
    "parameter",
    "macro",
    "type",
    "comment",
    "keyword",
    "property",
    "namespace",
    "variable",
    "string",
    "number",
    "function",
    "operator"
];

export function mapTokenToIndex(label: string): number {
    switch (label) {
        case "decorator": return 0;
        case "parameter": return 1;
        case "macro": return 2;
        case "type": return 3;
        case "comment": return 4;
        case "keyword": return 5;
        case "property": return 6;
        case "namespace": return 7;
        case "variable": return 8;
        case "string": return 9;
        case "number": return 10;
        case "function": return 11;
        case "operator": return 12;
        default: return 8;
    }
}

export function captureToTokenType(capture: string): string {
    switch (capture) {
        case "attribute":
            return "decorator";
        case "variable.parameter":
            return "parameter";
        case "macro.emphasis.strong":
            return "macro";
        case "type":
            return "type";
        case "comment":
            return "comment";
        case "keyword":
        case "keyword.emphasis.strong":
            return "keyword";
        case "constant":
        case "constant.builtin":
        case "constant.builtin.emphasis":
        case "string.special.key":
        case "property":
            return "property";
        case "tag":
        case "tag.emphsis":
            return "namespace";
        case "variable":
        case "label":
            return "variable";
        case "string":
        case "string.special":
            return "string";
        case "number":
            return "number";
        case "function":
        case "entity.name.function":
            return "function";
        case "operator":
        case "punctuation.delimiter":
        case "punctuation.bracket":
            return "operator";
        default:
            return "variable";
    }
}


export interface SemToken {
    node: Node;
    line: number;
    char: number;
    length: number;
    index: number;
    modifier: number;
};

export function getSemanticTokens(query: Query, tree: Tree, text: string): SemToken[] {
    const captures = query.captures(tree.rootNode);

    let tokens: SemToken[] = [];

    let lastRow = 0;
    let lastColumn = 0;

    for (const capture of captures) {
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
                tokens.push({
                    node: node,
                    line: start.row,
                    char: start.column,
                    length: length,
                    index: index,
                    modifier: 0
                });
                lastRow = start.row;
                lastColumn = end.column;
            }
        }
        else {
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
                tokens.push({
                    node: node,
                    line: row,
                    char: col,
                    length: length,
                    index: index,
                    modifier: 0
                });

                lastRow = row;
                lastColumn = col + length;
            }
        }
    }
    return tokens;
}


export function getInjections(
    injection: Query,
    tree: Tree,
    languages: Record<string, { parser: Parser, query: Query }>
): SemToken[] {
    const injectionsCaptures = injection.captures(tree.rootNode);

    let allInjections: SemToken[] = [];
    for (const capture of injectionsCaptures) {
        if (capture.name === "injection.content") {
            let langName = capture.setProperties?.["injection.language"];

            if (!langName) { continue; }

            const lang = languages[langName];
            const node = capture.node;
            const nodeContent = node.text;
            const subTree = lang.parser.parse(nodeContent);

            const currentTokens = getSemanticTokens(lang.query, subTree!, nodeContent);
            for (const token of currentTokens) {
                const absoluteLine = node.startPosition.row + token.line;
                const absoluteChar = (token.line === 0)
                    ? node.startPosition.column + token.char
                    : token.char;

                allInjections.push({ ...token, line: absoluteLine, char: absoluteChar });
            }
        }
    }
    return allInjections;
}

export function getUnusedLabelFromKind(kind: string): string {
    switch (kind) {
        case "label_statement":
            return "Unused label";
        case "macro_ussage":
            return "Unused macro";
        default:
            return "Unused variable";
    }
}

export function getUndefinedLabelFromKind(kind: string): string {
    switch (kind) {
        case "goto_statement":
        case "rigoto_statement":
            return "Undefined label";
        case "macro_ussage":
            return "Undefined macro";
        default:
            return "Undefined variable";
    }
}

export function getCleanNodeText(nodeText: string) {
    let nodeClean = nodeText.trim();
    let lastIndexChar = nodeClean.lastIndexOf(":");
    lastIndexChar = lastIndexChar === -1 ? nodeClean.length : lastIndexChar;
    return nodeClean.slice(0, lastIndexChar);
}

export function getNameAndTypeFromLegacyVar(variable: string): { varName: string, varType: string } {
    const vMatch = variable.match(/^([a-z])(.*?)(\[\])*$/);
    if (!vMatch) { return { varName: variable, varType: "" }; }
    return { varName: vMatch[2], varType: vMatch[1] + (vMatch[3] ?? "") };
}
