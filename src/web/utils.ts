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
