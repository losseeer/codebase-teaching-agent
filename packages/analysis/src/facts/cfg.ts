import type { CfgBlock, CfgEdge, CfgEdgeKind, CfgFileFact, CfgFunction, FactSkip, SymbolInfo } from "@codebase-tutor/domain";

import { declarationNameOf, withSyntaxTrees, type GrammarName, type SyntaxNode } from "../extraction/parser.js";
import { FACTS_VERSION } from "./version.js";

/**
  函数内控制流图：块是语句序列，边是走向，粒度到语句级。
  各语法的节点形状差异集中在 SPECS 与取值函数。
*/

/** 单个函数最多保留的块数，超出则截断并置 `truncated`。 */
const MAX_BLOCKS = 200;

/** 语句序列容器节点：具名子节点即语句。 */
const SEQUENCE_NODES = new Set(["statement_block", "block", "compound_statement", "statement_list", "switch_body", "switch_block", "match_block"]);

/** 外壳本身即分支的节点。 */
const BRANCH_SHELL = /^(else|elif|except|finally)_?clause$/;

/** 分支头与标签名：说明走向依据，不计为语句。 */
const ARM_HEADER = /^(case|default|switch_label|constant_pattern|match_pattern|when|guard|expression_list|label_name|statement_identifier|identifier)$/;

const set = (...types: string[]): Set<string> => new Set(types);

interface CfgSpec {
  /** 有独立可执行体的节点，每个建一张图。 */
  functionNodes: Set<string>;
  ifNodes: Set<string>;
  loopNodes: Set<string>;
  /** 先执行体再判条件的循环（do-while）。 */
  postTestLoops: Set<string>;
  /** 无判定条件的循环（Rust `loop`）。 */
  endlessLoops: Set<string>;
  switchNodes: Set<string>;
  /** 单个分支臂（case、match 臂、select 通信）。 */
  caseNodes: Set<string>;
  /** 执行完不掉入下一臂的分支。 */
  noFallthroughArms: Set<string>;
  /** true：臂尾自动掉入下一臂；false：仅显式 `fallthrough` 才掉。 */
  implicitFall: boolean;
  /** 显式掉入下一臂的语句。 */
  fallthroughNodes: Set<string>;
  tryNodes: Set<string>;
  handlerNodes: Set<string>;
  finalizerNodes: Set<string>;
  /** 正常离开函数的语句，汇入同一出口块。 */
  returnNodes: Set<string>;
  /** 异常离开函数的语句，各自成出口块。 */
  throwNodes: Set<string>;
  breakNodes: Set<string>;
  continueNodes: Set<string>;
  /** 仅包一层体的语句，按顺序展开其中的语句。 */
  transparentNodes: Set<string>;
  /** 可能提前离开函数、也可能继续的语句（Rust `?`）。 */
  propagateNodes: Set<string>;
  gotoNodes: Set<string>;
  labelNodes: Set<string>;
}

const TS_SPEC: CfgSpec = {
  functionNodes: set("function_declaration", "function_expression", "generator_function_declaration", "generator_function", "function", "arrow_function", "method_definition", "method_declaration", "constructor_declaration"),
  ifNodes: set("if_statement"),
  loopNodes: set("for_statement", "for_in_statement", "while_statement", "do_statement"),
  postTestLoops: set("do_statement"),
  endlessLoops: set(),
  switchNodes: set("switch_statement"),
  caseNodes: set("switch_case", "switch_default"),
  noFallthroughArms: set("switch_default"),
  implicitFall: true,
  fallthroughNodes: set(),
  tryNodes: set("try_statement"),
  handlerNodes: set("catch_clause"),
  finalizerNodes: set("finally_clause"),
  returnNodes: set("return_statement"),
  throwNodes: set("throw_statement"),
  breakNodes: set("break_statement"),
  continueNodes: set("continue_statement"),
  transparentNodes: set(),
  propagateNodes: set(),
  gotoNodes: set(),
  labelNodes: set("labeled_statement")
};

const PYTHON_SPEC: CfgSpec = {
  functionNodes: set("function_definition"),
  ifNodes: set("if_statement"),
  loopNodes: set("for_statement", "while_statement"),
  postTestLoops: set(),
  endlessLoops: set(),
  switchNodes: set(),
  caseNodes: set(),
  noFallthroughArms: set(),
  implicitFall: false,
  fallthroughNodes: set(),
  tryNodes: set("try_statement"),
  handlerNodes: set("except_clause"),
  finalizerNodes: set("finally_clause"),
  returnNodes: set("return_statement"),
  throwNodes: set("raise_statement"),
  breakNodes: set("break_statement"),
  continueNodes: set("continue_statement"),
  transparentNodes: set("with_statement"),
  propagateNodes: set(),
  gotoNodes: set(),
  labelNodes: set()
};

const JAVA_SPEC: CfgSpec = {
  functionNodes: set("method_declaration", "constructor_declaration"),
  ifNodes: set("if_statement"),
  loopNodes: set("for_statement", "enhanced_for_statement", "while_statement", "do_statement"),
  postTestLoops: set("do_statement"),
  endlessLoops: set(),
  // 冒号形式与箭头形式都叫 switch_expression，区别在体里是 group 还是 rule
  switchNodes: set("switch_expression"),
  caseNodes: set("switch_block_statement_group", "switch_rule"),
  noFallthroughArms: set("switch_rule"),
  implicitFall: true,
  fallthroughNodes: set(),
  tryNodes: set("try_statement", "try_with_resources_statement"),
  handlerNodes: set("catch_clause"),
  finalizerNodes: set("finally_clause"),
  returnNodes: set("return_statement"),
  throwNodes: set("throw_statement"),
  breakNodes: set("break_statement"),
  continueNodes: set("continue_statement"),
  transparentNodes: set(),
  propagateNodes: set(),
  gotoNodes: set(),
  labelNodes: set("labeled_statement")
};

const GO_SPEC: CfgSpec = {
  functionNodes: set("function_declaration", "method_declaration"),
  ifNodes: set("if_statement"),
  loopNodes: set("for_statement"),
  postTestLoops: set(),
  endlessLoops: set(),
  switchNodes: set("expression_switch_statement", "type_switch_statement", "select_statement"),
  caseNodes: set("expression_case", "type_case", "default_case", "communication_case"),
  noFallthroughArms: set(),
  implicitFall: false,
  fallthroughNodes: set("fallthrough_statement"),
  tryNodes: set(),
  handlerNodes: set(),
  finalizerNodes: set(),
  returnNodes: set("return_statement"),
  throwNodes: set(),
  breakNodes: set("break_statement"),
  continueNodes: set("continue_statement"),
  transparentNodes: set(),
  propagateNodes: set(),
  gotoNodes: set("goto_statement"),
  labelNodes: set("labeled_statement")
};

const RUST_SPEC: CfgSpec = {
  functionNodes: set("function_item", "closure_expression"),
  ifNodes: set("if_expression"),
  loopNodes: set("for_expression", "while_expression", "loop_expression"),
  postTestLoops: set(),
  endlessLoops: set("loop_expression"),
  switchNodes: set("match_expression"),
  caseNodes: set("match_arm"),
  noFallthroughArms: set("match_arm"),
  implicitFall: false,
  fallthroughNodes: set(),
  tryNodes: set(),
  handlerNodes: set(),
  finalizerNodes: set(),
  returnNodes: set("return_expression"),
  throwNodes: set(),
  breakNodes: set("break_expression"),
  continueNodes: set("continue_expression"),
  transparentNodes: set(),
  propagateNodes: set("try_expression"),
  gotoNodes: set(),
  labelNodes: set()
};

const CSHARP_SPEC: CfgSpec = {
  functionNodes: set("method_declaration", "constructor_declaration", "destructor_declaration"),
  ifNodes: set("if_statement"),
  loopNodes: set("for_statement", "foreach_statement", "while_statement", "do_statement"),
  postTestLoops: set("do_statement"),
  endlessLoops: set(),
  switchNodes: set("switch_statement"),
  caseNodes: set("switch_section"),
  noFallthroughArms: set("switch_section"),
  implicitFall: false,
  fallthroughNodes: set(),
  tryNodes: set("try_statement"),
  handlerNodes: set("catch_clause"),
  finalizerNodes: set("finally_clause"),
  returnNodes: set("return_statement"),
  throwNodes: set("throw_statement"),
  breakNodes: set("break_statement"),
  continueNodes: set("continue_statement"),
  transparentNodes: set("checked_statement", "unchecked_statement", "unsafe_statement", "lock_statement", "using_statement"),
  propagateNodes: set(),
  gotoNodes: set("goto_statement"),
  labelNodes: set("labeled_statement")
};

/** C 与 C++ 共用一份节点表。 */
const CLIKE_SPEC: CfgSpec = {
  functionNodes: set("function_definition", "method_definition", "constructor_declaration", "destructor_declaration"),
  ifNodes: set("if_statement"),
  loopNodes: set("for_statement", "for_range_loop", "while_statement", "do_statement"),
  postTestLoops: set("do_statement"),
  endlessLoops: set(),
  switchNodes: set("switch_statement"),
  caseNodes: set("case_statement"),
  noFallthroughArms: set(),
  implicitFall: true,
  fallthroughNodes: set(),
  tryNodes: set("try_statement"),
  handlerNodes: set("catch_clause"),
  // C++ 语法没有 finally 节点
  finalizerNodes: set(),
  returnNodes: set("return_statement"),
  throwNodes: set("throw_statement"),
  breakNodes: set("break_statement"),
  continueNodes: set("continue_statement"),
  transparentNodes: set(),
  propagateNodes: set(),
  gotoNodes: set("goto_statement"),
  labelNodes: set("labeled_statement")
};

const SPECS: Partial<Record<GrammarName, CfgSpec>> = {
  typescript: TS_SPEC,
  tsx: TS_SPEC,
  javascript: TS_SPEC,
  python: PYTHON_SPEC,
  java: JAVA_SPEC,
  go: GO_SPEC,
  rust: RUST_SPEC,
  csharp: CSHARP_SPEC,
  cpp: CLIKE_SPEC
};

/** 当前可追加语句的块；null 表示该路径已终止。 */
type Cursor = CfgBlock | null;

interface Frame {
  builder: Builder;
  spec: CfgSpec;
  /** `break` 的落点。 */
  breakTo?: CfgBlock;
  /** `continue` 的落点。 */
  continueTo?: CfgBlock;
  /** `fallthrough` 的落点。 */
  fallTo?: CfgBlock;
  /** 函数出口块，提前离开时走这里。 */
  exit: CfgBlock;
  /** 标签名到标签块的映射，供 `goto` 接线。 */
  labels: Map<string, CfgBlock>;
  /** 待接线的 `goto`，构建完成后统一连接。 */
  gotos: { from: CfgBlock; label: string; line: number }[];
  /** 无法接线的结构记录于此，不补边。 */
  notes: string[];
}

class Builder {
  blocks: CfgBlock[] = [];
  edges: CfgEdge[] = [];
  truncated = false;
  private nextId = 0;

  open(kind: CfgBlock["kind"], at: SyntaxNode, statements: string[] = []): CfgBlock {
    if (this.blocks.length >= MAX_BLOCKS) {
      this.truncated = true;
      const tail = this.blocks.at(-1);
      if (tail) return tail;
    }
    const block: CfgBlock = { id: this.nextId++, kind, startLine: at.startPosition.row + 1, endLine: at.endPosition.row + 1, statements };
    this.blocks.push(block);
    return block;
  }

  append(block: CfgBlock, node: SyntaxNode): void {
    block.statements.push(node.type);
    block.endLine = Math.max(block.endLine, node.endPosition.row + 1);
  }

  link(from: CfgBlock, to: CfgBlock, kind: CfgEdgeKind): void {
    this.edges.push({ from: from.id, to: to.id, kind });
  }

  /** 移除不可达且不记语句的脚手架块及其边。 */
  settle(entryId: number): void {
    const reachable = new Set<number>([entryId]);
    let frontier = [entryId];
    while (frontier.length) {
      const next: number[] = [];
      for (const id of frontier) for (const edge of this.edges) {
        if (edge.from === id && !reachable.has(edge.to)) { reachable.add(edge.to); next.push(edge.to); }
      }
      frontier = next;
    }
    const dead = new Set(this.blocks.filter((block) => block.statements.length === 0 && !reachable.has(block.id)).map((block) => block.id));
    this.blocks = this.blocks.filter((block) => !dead.has(block.id));
    this.edges = this.edges.filter((edge) => !dead.has(edge.from) && !dead.has(edge.to));
  }

  /** 圈复杂度 = 边数 - 块数 + 2。 */
  complexity(): number {
    return Math.max(1, this.edges.length - this.blocks.length + 2);
  }
}

/** 按顺序尝试字段名，命中即返回。 */
function fieldOf(node: SyntaxNode, fields: string[]): SyntaxNode | undefined {
  for (const name of fields) {
    const child = node.childForFieldName(name);
    if (child) return child;
  }
  return undefined;
}

function isStatement(node: SyntaxNode): boolean {
  return !/^comment|line_comment|block_comment$/i.test(node.type);
}

function isSequence(node: SyntaxNode): boolean {
  return SEQUENCE_NODES.has(node.type);
}

function isBranchShell(node: SyntaxNode): boolean {
  return BRANCH_SHELL.test(node.type);
}

/** 判定条件：字段缺失时取首个非体、非壳、非注释的具名子节点。 */
function conditionOf(node: SyntaxNode): SyntaxNode | undefined {
  return fieldOf(node, ["condition", "test", "value"]) ?? node.namedChildren.find((child) => isStatement(child) && !isSequence(child) && !isBranchShell(child) && !looksLikeBody(child));
}

/** 循环体与函数体：字段缺失时取最后一个具名子节点。 */
function bodyOf(node: SyntaxNode): SyntaxNode | undefined {
  return fieldOf(node, ["body", "consequent", "consequence", "then"]) ?? node.namedChildren.filter(isStatement).at(-1);
}

function looksLikeBody(node: SyntaxNode): boolean {
  return isSequence(node) || node.type === "do";
}

/** `if` 的 then 体：排除条件、else 壳与括号后的那一个。 */
function consequentOf(node: SyntaxNode): SyntaxNode | undefined {
  const condition = conditionOf(node);
  return node.namedChildren.find((child) => isStatement(child) && child.id !== condition?.id && !isBranchShell(child) && child.type !== "parenthesized_expression");
}

function alternativeOf(node: SyntaxNode): SyntaxNode | undefined {
  return fieldOf(node, ["alternative"]) ?? node.namedChildren.find(isBranchShell);
}

/** `if` 之后的分支壳（`elif` 链与 `else`），或挂在 alternative 上的那一块。 */
function elseArmsOf(node: SyntaxNode): SyntaxNode[] {
  const shells = node.namedChildren.filter(isBranchShell);
  if (shells.length) return shells;
  const alternative = alternativeOf(node);
  return alternative && alternative !== consequentOf(node) ? [alternative] : [];
}

interface IfArm {
  /** 本臂判定节点，计入 `branch` 块的行区间。 */
  node: SyntaxNode;
  body: SyntaxNode[];
}

/** 将 `if / elif / else` 链展平为判定序列与可选 else。 */
function flattenIf(statement: SyntaxNode, spec: CfgSpec): { arms: IfArm[]; otherwise: SyntaxNode | undefined } {
  const arms: IfArm[] = [{ node: statement, body: statementsOf(consequentOf(statement)) }];
  let current: SyntaxNode | undefined = statement;
  let otherwise: SyntaxNode | undefined;
  while (current) {
    const shells = elseArmsOf(current);
    current = undefined;
    for (const shell of shells) {
      const nested = spec.ifNodes.has(shell.type) || (isBranchShell(shell) && conditionOf(shell));
      if (!nested) {
        otherwise = shell;
        continue;
      }
      arms.push({ node: shell, body: statementsOf(isBranchShell(shell) ? fieldOf(shell, ["consequence", "body"]) ?? shell : consequentOf(shell)) });
      current = shell;
    }
  }
  return { arms, otherwise };
}

/** 取节点的语句数组：体、分支壳、单语句归一。 */
function statementsOf(node: SyntaxNode | undefined): SyntaxNode[] {
  if (!node) return [];
  if (isSequence(node)) return splice(node.namedChildren.filter(isStatement));
  if (isBranchShell(node)) {
    const inner = statementsOf(bodyOf(node));
    return inner.length ? inner : splice(node.namedChildren.filter(isStatement));
  }
  const inner = bodyOf(node);
  if (inner && (isSequence(inner) || isBranchShell(inner))) return statementsOf(inner);
  return [node];
}

/** 递归展开嵌套的语句序列容器。 */
function splice(children: SyntaxNode[]): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const child of children) {
    if (isSequence(child)) out.push(...splice(child.namedChildren.filter(isStatement)));
    else out.push(child);
  }
  return out;
}

/** 取 switch/select 的分支清单，不进入嵌套的那一层。 */
function armsOf(node: SyntaxNode, spec: CfgSpec): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const walk = (current: SyntaxNode): void => {
    for (const child of current.namedChildren) {
      if (spec.caseNodes.has(child.type)) {
        found.push(child);
        continue;
      }
      if (spec.switchNodes.has(child.type)) continue;
      walk(child);
    }
  };
  walk(node);
  return found;
}

function armHeaderOf(arm: SyntaxNode): SyntaxNode | undefined {
  return arm.namedChildren.find((child) => ARM_HEADER.test(child.type));
}

// tree-sitter 的子节点是新建包装对象，比较用 `.id`。
function armBodyOf(arm: SyntaxNode, header: SyntaxNode | undefined): SyntaxNode[] {
  return splice(arm.namedChildren.filter((child) => isStatement(child) && child.id !== header?.id && !ARM_HEADER.test(child.type)));
}

function labelNameOf(node: SyntaxNode): string | undefined {
  return fieldOf(node, ["label"])?.text.trim() ?? node.namedChildren.at(0)?.text.trim();
}

function gotoTargetOf(node: SyntaxNode): string | undefined {
  return fieldOf(node, ["label"])?.text.trim() ?? node.namedChildren.at(-1)?.text.trim();
}

/** 依次执行语句，返回末尾仍存的块；null 表示路径终止。 */
function run(statements: SyntaxNode[], cursor: Cursor, frame: Frame): Cursor {
  let current = cursor;
  for (const statement of statements) {
    if (!current) {
      // 不可达语句仍建块并继续遍历，向前 goto 才有落点
      current = frame.builder.open("straight", statement);
    }
    current = step(statement, current, frame);
  }
  return current;
}

/** 剥掉语句位置的 `expression_statement` 壳，露出内层控制构造。 */
function unwrapStatement(node: SyntaxNode, spec: CfgSpec): SyntaxNode {
  if (node.type !== "expression_statement") return node;
  const inner = node.namedChildren.find(isStatement);
  if (!inner) return node;
  const control = spec.ifNodes.has(inner.type) || spec.loopNodes.has(inner.type) || spec.switchNodes.has(inner.type) || spec.tryNodes.has(inner.type)
    || spec.returnNodes.has(inner.type) || spec.throwNodes.has(inner.type) || spec.breakNodes.has(inner.type) || spec.continueNodes.has(inner.type) || spec.propagateNodes.has(inner.type);
  return control ? inner : node;
}

/** 处理一条语句，返回新的当前块；null 表示路径终止。 */
function step(node: SyntaxNode, current: CfgBlock, frame: Frame): Cursor {
  const { builder, spec } = frame;
  const statement = unwrapStatement(node, spec);

  if (spec.returnNodes.has(statement.type) || spec.throwNodes.has(statement.type)) {
    // 每条离开函数的语句独占一个出口块，数据流按行定位使用点
    const left = builder.open("exit", statement, [statement.type]);
    builder.link(current, left, "next");
    return null;
  }
  if (spec.breakNodes.has(statement.type) || spec.continueNodes.has(statement.type) || spec.fallthroughNodes.has(statement.type) || spec.gotoNodes.has(statement.type)) {
    builder.append(current, statement);
    const label = spec.gotoNodes.has(statement.type) ? gotoTargetOf(statement) : undefined;
    if (label) frame.gotos.push({ from: current, label, line: statement.startPosition.row + 1 });
    else if (spec.breakNodes.has(statement.type)) {
      if (frame.breakTo) builder.link(current, frame.breakTo, "next");
      else frame.notes.push(`break@${statement.startPosition.row + 1}：不在循环或 switch 里，没有落点`);
    } else if (spec.continueNodes.has(statement.type)) {
      if (frame.continueTo) builder.link(current, frame.continueTo, "back");
      else frame.notes.push(`continue@${statement.startPosition.row + 1}：不在循环里，没有落点`);
    } else if (frame.fallTo) builder.link(current, frame.fallTo, "next");
    return null;
  }
  if (spec.propagateNodes.has(statement.type)) {
    const gate = builder.open("branch", statement, [statement.type]);
    builder.link(current, gate, "next");
    builder.link(gate, frame.exit, "exception");
    return gate;
  }
  if (spec.ifNodes.has(statement.type)) return buildIf(statement, current, frame);
  if (spec.loopNodes.has(statement.type)) return buildLoop(statement, current, frame);
  if (spec.switchNodes.has(statement.type)) return buildSwitch(statement, current, frame);
  if (spec.tryNodes.has(statement.type)) return buildTry(statement, current, frame);
  if (spec.transparentNodes.has(statement.type)) return run(statementsOf(bodyOf(statement)), current, frame);
  if (spec.labelNodes.has(statement.type)) return buildLabel(statement, current, frame);

  // 传播表达式可嵌在普通语句中（`let v = f()?;`）
  if (spec.propagateNodes.size && hasPropagate(statement, spec)) {
    const gate = builder.open("branch", statement, [statement.type, "propagate"]);
    builder.link(current, gate, "next");
    builder.link(gate, frame.exit, "exception");
    return gate;
  }
  builder.append(current, statement);
  return current;
}

/** 语句子树内是否有提前离开函数的构造，限深 6 层。 */
function hasPropagate(node: SyntaxNode, spec: CfgSpec, depth = 0): boolean {
  if (depth > 6) return false;
  for (const child of node.namedChildren) {
    if (spec.propagateNodes.has(child.type)) return true;
    if (hasPropagate(child, spec, depth + 1)) return true;
  }
  return false;
}

function buildIf(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const { arms, otherwise } = flattenIf(statement, spec);
  const first = builder.open("branch", statement, ["if"]);
  builder.link(current, first, "next");
  const merge = builder.open("straight", statement);
  const tails: Cursor[] = [];
  let branch = first;
  arms.forEach((arm, index) => {
    if (index > 0) {
      const next = builder.open("branch", arm.node, [arm.node.type]);
      builder.link(branch, next, "false");
      branch = next;
    }
    const tail = run(arm.body, entryFrom(builder, branch, "true", arm.node, "then"), frame);
    tails.push(tail ?? null);
  });
  if (otherwise) {
    const tail = run(statementsOf(otherwise), entryFrom(builder, branch, "false", otherwise, otherwise.type), frame);
    if (tail) tails.push(tail);
  } else {
    builder.link(branch, merge, "false");
  }
  for (const tail of tails) if (tail) builder.link(tail, merge, "next");
  return merge;
}

function entryFrom(builder: Builder, from: CfgBlock, kind: CfgEdgeKind, at: SyntaxNode, label: string): CfgBlock {
  const entry = builder.open("straight", at, [label]);
  builder.link(from, entry, kind);
  return entry;
}

function buildLoop(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const endless = spec.endlessLoops.has(statement.type) || !conditionOf(statement);
  const head = builder.open("loop", statement, [endless ? "loop" : "condition"]);
  const after = builder.open("straight", statement);
  const inner: Frame = { ...frame, breakTo: after, continueTo: head };
  const body = statementsOf(bodyOf(statement));
  const elseBody = statementsOf(alternativeOf(statement));

  if (spec.postTestLoops.has(statement.type)) {
    const entry = entryFrom(builder, current, "next", statement, "do");
    const tail = run(body, entry, inner);
    if (tail) builder.link(tail, head, "back");
    builder.link(head, entry, "true");
    builder.link(head, after, "false");
    return after;
  }
  builder.link(current, head, "next");
  const entry = entryFrom(builder, head, endless ? "next" : "true", statement, "body");
  const tail = run(body, entry, inner);
  if (tail) builder.link(tail, head, "back");
  // Python 的 `for … else` / `while … else`：仅在未 break 正常结束时进入 else
  if (elseBody.length) {
    const elseTail = run(elseBody, entryFrom(builder, head, "false", statement, "else"), frame);
    if (elseTail) builder.link(elseTail, after, "next");
  } else if (!endless) {
    builder.link(head, after, "false");
  }
  return after;
}

function buildSwitch(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const selector = builder.open("selector", statement, [statement.childForFieldName("value") || statement.childForFieldName("condition") ? "switch-on" : "switch"]);
  builder.link(current, selector, "next");
  const after = builder.open("straight", statement);
  const arms = armsOf(statement, spec);
  // 先建全部分支入口并接上 selector：fallthrough 目标是下一臂入口
  const entries = arms.map((arm) => {
    const entry = builder.open("straight", arm, [arm.type]);
    builder.link(selector, entry, "next");
    const header = armHeaderOf(arm);
    if (header) builder.append(entry, header);
    return entry;
  });
  arms.forEach((arm, index) => {
    const canFall = spec.implicitFall || spec.fallthroughNodes.size > 0;
    const nextEntry = canFall && index + 1 < arms.length && !spec.noFallthroughArms.has(arms[index + 1].type) ? entries[index + 1] : undefined;
    const tail = run(armBodyOf(arm, armHeaderOf(arm)), entries[index], { ...frame, breakTo: after, fallTo: nextEntry });
    if (tail && spec.implicitFall && nextEntry) builder.link(tail, nextEntry, "next");
    if (tail) builder.link(tail, after, "next");
  });
  if (!arms.length) builder.link(selector, after, "next");
  // 无 default 时补一条 selector→after 边
  else if (!arms.some(isDefaultArm)) builder.link(selector, after, "false");
  return after;
}

/** 默认臂：`default:`、Go 的 `default_case`、Rust 的 `_ =>`。 */
function isDefaultArm(arm: SyntaxNode): boolean {
  if (arm.type.includes("default")) return true;
  const text = arm.text.trimStart();
  if (text.startsWith("default") || text.startsWith("_ =>") || text.startsWith("_ if")) return true;
  return arm.namedChildren.some((child) => child.text.trim() === "_");
}

function buildTry(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const bodyEntry = entryFrom(builder, current, "next", statement, "try");
  const bodyTail = run(statementsOf(bodyOf(statement)), bodyEntry, frame);
  const merge = builder.open("straight", statement);
  if (bodyTail) builder.link(bodyTail, merge, "next");

  const sources = bodyTail && bodyTail !== bodyEntry ? [bodyEntry, bodyTail] : [bodyEntry];
  for (const child of statement.namedChildren) {
    if (!spec.handlerNodes.has(child.type)) continue;
    const handler = builder.open("handler", child, ["catch"]);
    // 静态无法确定抛出行，异常边同时从体入口与体尾引出
    for (const source of sources) builder.link(source, handler, "exception");
    const filter = child.namedChildren.find((item) => /filter|guard/.test(item.type));
    if (filter) builder.append(handler, filter);
    const tail = run(statementsOf(bodyOf(child)), handler, frame);
    if (tail) builder.link(tail, merge, "next");
  }
  let live: CfgBlock | null = merge;
  for (const child of statement.namedChildren) {
    if (!spec.finalizerNodes.has(child.type)) continue;
    const entry: CfgBlock = live ? entryFrom(builder, live, "finally", child, "finally") : builder.open("straight", child, ["finally"]);
    live = run(statementsOf(bodyOf(child)), entry, frame) ?? entry;
  }
  if (live && live !== merge) builder.link(live, merge, "next");
  return merge;
}

/** `标签: 语句`：标签块是 `goto` 落点，其后块是 `break 标签` 落点。 */
function buildLabel(statement: SyntaxNode, current: CfgBlock, frame: Frame): Cursor {
  const { builder, spec } = frame;
  const name = labelNameOf(statement);
  const body = statement.namedChildren.filter(isStatement).at(-1);
  const here = builder.open("straight", statement, name ? [`label:${name}`] : []);
  builder.link(current, here, "next");
  if (name) frame.labels.set(name, here);
  const after = builder.open("straight", statement);
  const tail = run(statementsOf(body), here, { ...frame, breakTo: after });
  if (tail) builder.link(tail, after, "next");
  void spec;
  return after;
}

interface Carrier {
  node: SyntaxNode;
  name: string;
  line: number;
  endLine: number;
  /** 匿名函数体，不成图，计入 `skipped`。 */
  anonymous?: boolean;
}

/** 收集有体节点并与符号表对齐；函数 id 必须与 `SymbolInfo.id` 一致。 */
function collectCarriers(root: SyntaxNode, spec: CfgSpec, out: Carrier[]): void {
  for (const child of root.namedChildren) {
    if (spec.functionNodes.has(child.type)) {
      const holder = child.parent?.type === "variable_declarator" ? child.parent : undefined;
      const name = (holder ? holder.childForFieldName("name")?.text.trim() : declarationNameOf(child)) || undefined;
      out.push({
        node: child,
        name: name ?? "(匿名)",
        line: (holder ?? child).startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        ...(name ? {} : { anonymous: true })
      });
    }
    collectCarriers(child, spec, out);
  }
}

function buildOne(carrier: Carrier, path: string, symbol: SymbolInfo | undefined, spec: CfgSpec): CfgFunction {
  const builder = new Builder();
  const entry = builder.open("entry", carrier.node);
  const exit = builder.open("exit", carrier.node);
  exit.startLine = carrier.endLine;
  exit.endLine = carrier.endLine;
  const frame: Frame = { builder, spec, exit, labels: new Map<string, CfgBlock>(), gotos: [], notes: [] };
  const tail = run(statementsOf(bodyOf(carrier.node)), entry, frame);
  if (tail) builder.link(tail, exit, "next");
  for (const goto of frame.gotos) {
    const target = frame.labels.get(goto.label);
    if (target) builder.link(goto.from, target, "next");
    else frame.notes.push(`goto ${goto.label}@${goto.line}：本函数里没有这个标签，没有替它编一条边`);
  }
  builder.settle(entry.id);
  const sinks = builder.blocks.filter((block) => !builder.edges.some((edge) => edge.from === block.id)).map((block) => block.id);
  const kept = builder.blocks.includes(exit);
  return {
    symbolId: symbol?.id ?? `symbol:${path}:${carrier.name}:${carrier.line}`,
    name: carrier.name,
    kind: symbol?.kind ?? "function",
    startLine: carrier.line,
    endLine: carrier.endLine,
    // 块按行号排序，边只引用 id
    blocks: builder.blocks.sort((left, right) => left.startLine - right.startLine || left.id - right.id),
    edges: builder.edges,
    exitBlocks: kept && sinks.includes(exit.id) ? sinks : kept ? [exit.id, ...sinks] : sinks,
    complexity: builder.complexity(),
    ...(builder.truncated ? { truncated: true } : {}),
    ...(frame.notes.length ? { notes: frame.notes } : {})
  };
}

/** 一个函数的体节点、控制流图与对齐到的符号。 */
export interface FunctionScope {
  node: SyntaxNode;
  cfg: CfgFunction;
  symbol?: SymbolInfo;
  language: string;
}

/** 一次解析、逐函数回调，返回该文件的控制流事实。 */
export function eachFunction(path: string, content: string, symbols: SymbolInfo[], language: string, visit?: (scope: FunctionScope) => void, onRoot?: (root: SyntaxNode) => void): CfgFileFact {
  const executable = symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method");
  const spec = SPECS[grammarKeyOf(path)];
  if (!spec) {
    return {
      path,
      language,
      backend: "none",
      version: FACTS_VERSION,
      functions: [],
      skipped: [{ name: path, reason: `引擎还没有 ${language} 的控制流规则（语法树已解析，只是没有节点表）` }]
    };
  }
  const claimed = new Set<string>();
  const drawn: CfgFunction[] = [];
  const orphanCarriers: { name: string; line: number }[] = [];
  const anonymous: { name: string; line: number }[] = [];
  // visit 必须在回调内用完节点：回调返回后语法树即释放
  const trees = withSyntaxTrees(path, content, (root) => {
    onRoot?.(root);
    const carriers: Carrier[] = [];
    collectCarriers(root, spec, carriers);
    for (const carrier of carriers) {
      if (carrier.anonymous) {
        anonymous.push({ name: carrier.name, line: carrier.line });
        continue;
      }
      const symbol = executable.find((item) => !claimed.has(item.id) && item.name === carrier.name && item.line === carrier.line)
        ?? executable.find((item) => !claimed.has(item.id) && item.line === carrier.line);
      if (!symbol) {
        orphanCarriers.push({ name: carrier.name, line: carrier.line });
        continue;
      }
      claimed.add(symbol.id);
      const cfg = buildOne(carrier, path, symbol, spec);
      drawn.push(cfg);
      visit?.({ node: carrier.node, cfg, symbol, language });
    }
  });
  if (!trees) {
    return { path, language, backend: "none", version: FACTS_VERSION, functions: [], skipped: [{ name: path, reason: "语法树不可用（解析器未就绪或该文件没有对应语法），本文件未做控制流分析" }] };
  }
  const skipped: FactSkip[] = [
    ...executable.filter((symbol) => !claimed.has(symbol.id)).map((symbol): FactSkip => ({ name: `${symbol.name}@${symbol.line}`, reason: "符号表里有这个函数，语法树里却找不到对应的可执行体（多为宏或生成代码），未画控制流" })),
    ...orphanCarriers.map((carrier): FactSkip => ({ name: `${carrier.name}@${carrier.line}`, reason: "语法树里有可执行体，符号表里没有它——两处的判据漂了，这里如实记录、不并入控制流图" })),
    ...anonymous.map((carrier): FactSkip => ({ name: `${carrier.name}@${carrier.line}`, reason: "匿名函数体（没有可寻址的名字），未单独成图" }))
  ];
  return { path, language, backend: "ast", version: FACTS_VERSION, functions: drawn.sort((left, right) => left.startLine - right.startLine), ...(skipped.length ? { skipped } : {}) };
}

/** 一个文件的控制流图；`backend` 为 `none` 时 `functions` 为空、`skipped` 非空。 */
export function buildFileCfg(path: string, content: string, symbols: SymbolInfo[], language: string): CfgFileFact {
  return eachFunction(path, content, symbols, language);
}

/** 按扩展名选节点表；`.vue` 用 tsx 语法，符号表按 vue 记。 */
function grammarKeyOf(path: string): GrammarName {
  if (path.endsWith(".tsx") || path.endsWith(".jsx") || path.endsWith(".vue")) return "tsx";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".cs")) return "csharp";
  if (/\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(path)) return "cpp";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  return "javascript";
}

