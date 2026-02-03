import { TextDocument } from "vscode-languageserver-textdocument";
import { Parser, Tree } from "web-tree-sitter";

export interface DocState {
    tree: Tree | null;
    text: string;
    textLines: string[];
    version: number;
};

export function updateTree(parser: Parser, document: TextDocument, docs: Map<string, DocState>) {
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
