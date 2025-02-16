// This file is based on code from https://github.com/scaleton-labs/tvm-disassembler

import {DebugSymbols} from '@scaleton/func-debug-symbols';
import {
  BlockNode,
  InstructionNode,
  MethodNode,
  NodeType,
  ProcedureNode,
  ProgramNode, ScalarNode,
} from '../ast';
import {Writer} from "../utils/Writer";

const OPCODE_RENAMES = new Map([
  ['PUSHINT_4', 'PUSHINT'],
  ['PUSHINT_8', 'PUSHINT'],
  ['PUSHINT_16', 'PUSHINT'],
  ['PUSHINT_LONG', 'PUSHINT'],
  ['PUSHCONT_SHORT', 'PUSHCONT'],
  ['THROWIFNOT_SHORT', 'THROWIFNOT'],
  ['THROWIF_SHORT', 'THROWIF'],
]);

export class AssemblerWriter {
  #writer = new Writer();

  readonly knownGlobals = new Map<number, string>();
  readonly knownMethods = new Map<number, string>();
  readonly knownProcedures = new Map<string, string>();

  constructor(debugSymbols: DebugSymbols) {
    debugSymbols.globals.forEach((glob) => {
      this.knownGlobals.set(glob.index, glob.name);
    });

    debugSymbols.procedures.forEach((proc) => {
      this.knownMethods.set(proc.methodId, proc.name);
      this.knownProcedures.set(proc.cellHash, proc.name);
    });
  }

  protected resolveGlobalName(index: number) {
    return this.knownGlobals.get(index) ?? `${index}`;
  }

  protected resolveMethodName(methodId: number) {
    return this.knownMethods.get(methodId) ?? `?fun_${methodId}`;
  }

  protected resolveProcedureName(hash: string) {
    return (
      this.knownProcedures.get(hash) ?? `?fun_ref_${hash.substring(0, 16)}`
    );
  }

  writeProgramNode(node: ProgramNode) {
    this.#writer.writeLine('PROGRAM{');
    this.#writer.indent(() => {
      // Sort
      const methods = [...node.methods].sort((a, b) => a.id - b.id);
      const procedures = [...node.procedures].sort((a, b) =>
        a.hash.localeCompare(b.hash),
      );

      methods.forEach((method) => {
        this.#writer.writeLine(
          `DECLPROC ${this.resolveMethodName(method.id)};`,
        );
      });

      procedures.forEach((procedure) => {
        this.#writer.writeLine(
          `DECLPROC ${this.resolveProcedureName(procedure.hash)};`,
        );
      });

      methods.forEach((method) => this.writeMethodNode(method));
      procedures.forEach((procedure) => this.writeNode(procedure));
    });
    this.#writer.writeLine('}END>c');
  }

  writeMethodNode(node: MethodNode) {
    const methodName = this.resolveMethodName(node.id);

    this.#writer.write(`${methodName} PROC:`);
    this.writeBlockNode(node.body, false);
    this.#writer.newLine();
  }

  writeProcedureNode(node: ProcedureNode) {
    const procedureName = this.resolveProcedureName(node.hash);

    this.#writer.write(`${procedureName} PROCREF:`);
    this.writeBlockNode(node.body, false);
    this.#writer.newLine();
  }

  writeBlockNode(node: BlockNode, top: boolean) {
    if (!top) {
      this.#writer.writeLine('<{');
      this.#writer.indent(() => {
          for (const instruction of node.instructions) {
              this.writeInstructionNode(instruction);
          }
      });
      this.#writer.write('}>');
      return;
    }

    for (const instruction of node.instructions) {
      this.writeInstructionNode(instruction);
    }
  }

  maybeSpecificWrite(node: InstructionNode): string | null {
    const firstArg = (node.arguments[0] as ScalarNode)?.value
    const secondArg = (node.arguments[1] as ScalarNode)?.value;
    if (firstArg === undefined) {
        return null;
    }

    if (node.opcode.definition.mnemonic === 'SETCP') {
      return `SETCP${firstArg}`;
    }

    if (node.opcode.definition.mnemonic === 'XCHG_0I') {
      return `s0 s${firstArg} XCHG`;
    }

    if (node.opcode.definition.mnemonic === 'XCHG_1I') {
      return `s1 s${firstArg} XCHG`;
    }

    if (node.opcode.definition.mnemonic === 'GETPARAM') {
      if (firstArg === 3) {
        return 'NOW';
      }
      if (firstArg === 4) {
        return 'BLOCKLT';
      }
      if (firstArg === 5) {
        return 'LTIME';
      }
      if (firstArg === 6) {
        return 'RANDSEED';
      }
      if (firstArg === 7) {
        return 'BALANCE';
      }
      if (firstArg === 8) {
        return 'MYADDR';
      }
      if (firstArg === 9) {
        return 'CONFIGROOT';
      }
    }

    if (node.opcode.definition.mnemonic === 'ADDCONST') {
      if (firstArg === 1) {
        return 'INC';
      }
      if (firstArg === -1) {
        return 'DEC';
      }
    }

    if (node.opcode.definition.mnemonic === 'MULCONST') {
      if (firstArg === -1) {
        return 'NEGATE';
      }
    }

    // Debug
    if (node.opcode.definition.mnemonic === 'DEBUG') {
      if (firstArg === 0x00) {
        return 'DUMPSTK';
      }
      if (firstArg === 0x14) {
        return 'STRDUMP';
      }
    }

    return null
  }

  writeInstructionNode(node: InstructionNode) {
    //this.#writer.write(`[${node.hash.substring(0, 16)}:${node.offset}] `);

    const specific = this.maybeSpecificWrite(node);
    if (specific) {
      this.#writer.writeLine(specific);
      return;
    }

    node.arguments.forEach((arg) => {
      switch (arg.type) {
        case NodeType.STACK_ENTRY:
          this.#writer.write(`s${arg.value} `);
          break;

        case NodeType.CONTROL_REGISTER:
          this.#writer.write(`c${arg.value} `);
          break;

        case NodeType.SCALAR:
          this.#writer.write(`${arg.value} `);
          break;

        case NodeType.REFERENCE:
          this.#writer.write(`${this.resolveProcedureName(arg.hash)} `);
          break;

        case NodeType.GLOBAL_VARIABLE:
          this.#writer.write(`${this.resolveGlobalName(arg.value)} `);
          break;

        case NodeType.METHOD_REFERENCE:
          this.#writer.write(`${this.resolveMethodName(arg.methodId)} `);
          break;

        case NodeType.BLOCK:
          this.writeBlockNode(arg, false);
          this.#writer.write(' ');
          break;
      }
    });

    this.#writer.writeLine(OPCODE_RENAMES.get(node.opcode.definition.mnemonic) || node.opcode.definition.mnemonic);
  }

  writeNode(
    node:
      | ProgramNode
      | MethodNode
      | ProcedureNode
      | BlockNode
      | InstructionNode,
    top: boolean = false,
  ) {
    switch (node.type) {
      case NodeType.PROGRAM:
        this.writeProgramNode(node);
        break;

      case NodeType.METHOD:
        this.writeMethodNode(node);
        break;

      case NodeType.PROCEDURE:
        this.writeProcedureNode(node);
        break;

      case NodeType.BLOCK:
        this.writeBlockNode(node, top);
        break;

      case NodeType.INSTRUCTION:
        this.writeInstructionNode(node);
        break;
    }
  }

  output() {
    return this.#writer.end();
  }

  static write(
    node: ProgramNode | MethodNode | ProcedureNode | BlockNode,
    debugSymbols?: DebugSymbols,
  ): string {
    const writer = new AssemblerWriter(
      debugSymbols ?? {
        globals: [],
        procedures: [],
        constants: []
      },
    );

    writer.writeNode(node, true);

    return writer.output();
  }
}
