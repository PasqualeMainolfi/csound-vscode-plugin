import { TextDocument } from "vscode-languageserver-textdocument";
import { Parser, Point, Range, Tree } from "web-tree-sitter";

export interface DocState {
    tree: Tree | null;
    text: string;
    textLines: string[];
    version: number;
};

export interface DocReport { } // NODE COLLECTION FOR DIAGNOSTIC

export interface UdtMember {
    name: string;
    type: string;
};

export interface UserDefinedType {
    udtName: string;
    udtFormat: string;
    udtMembers: UdtMember[];
};

export type VarDataType =
    | { kind: "INIT_TIME" }
    | { kind: "KONTROL_RATE" }
    | { kind: "AUDIO_RATE" }
    | { kind: "STRING" }
    | { kind: "SPECTRAL" }
    | { kind: "MACRO" }
    | { kind: "INSTR_DEF" }
    | { kind: "INSTR" }
    | { kind: "OPCODE" }
    | { kind: "OPCODE_DEF" }
    | { kind: "COMPLEX" }
    | { kind: "COOL" }
    | { kind: "TYPE_DEF", name: string }
    | { kind: "VOID" }
    | { kind: "UNKNOWN" };

export type VarDataShape =
    | { kind: "SCALAR" }
    | { kind: "ARRAY", size: number }
    | { kind: "BOOLEAN" }
    | { kind: "SPECTRA" }
    | { kind: "EXPRESSION" }
    | { kind: "STRUCT", name: string }
    | { kind: "NO_SHAPE" }
    | { kind: "UNKNOWN" };

export type Scope =
    | { kind: "INSTR", name: string }
    | { kind: "UDO", name: string }
    | { kind: "SCORE" }
    | { kind: "GLOBAL" }
    | { kind: "UNKNOWN" };

export enum UdoType {
    legacy,
    modern,
    unknown
};

export interface VariableData {
    dataType: VarDataType;
    dataShape: VarDataShape;
};

export interface UdoArg {
    position: number;
    arg: VariableData;
};

export interface UserDefinedMacro {
    nodeLocation: number;
    macroName: string;
    macroLabel: string;
    macroValue: string;
};

export interface UserDefinedVariable {
    nodeLocation: number;
    varName: string;
    varScope: Scope;
    varCalls: number;
    isUndefined: boolean;
    isUnused: boolean;
    references: Range[];
    dataType: VariableData | undefined;
};

export interface Udo {
    nodePosition: {start: Point, end: Point};
    signature: string;
    inputs: UdoArg[];
    outputs: UdoArg[];
    udoType: UdoType;
    isValid: boolean;
};

export interface UserDefinitions {
    userDefinedTypes: Map<string, UserDefinedType>;
    userDefinedOpcodes: Map<string, Udo>;
    userDefinedMacros: Map<string, UserDefinedMacro>;
    userDefinedVars: UserDefinedVariable[];
    userUndefinedVars: UserDefinedVariable[];
    userDefinedLocalVars: Map<Scope, Map<string, UserDefinedVariable>>;
    userDefinedGlobalVars: Map<string, UserDefinedVariable>;
    varsWithoutDefinition: Set<string>;
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

function updateVarUse() { };
function addUserDefinedVar() { };
function addUserDefinedType() { };
function addUserDefinedOpcode() { };
