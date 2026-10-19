import type { CfgBlock, CfgEdge, CfgEdgeKind, CfgFileFact, CfgFunction, FactSkip, SymbolInfo } from "@codebase-tutor/shared";
import { declarationNameOf, withSyntaxTrees, type GrammarName, type SyntaxNode } from "../depgraph/parser.js";
import { FACTS_VERSION } from "./version.js";

/**
  函数内的控制流图：把「哪些语句可能按什么顺序被执行」收成节点与边。

  与依赖图分家的那一半事实——图回答「谁指向谁」，这里回答**单个函数体内**的走向。
  粒度刻意是语句级的（一块 = 一串顺序语句，边 = 走向），不做教科书式的基本块切分：
  真按基本块切，每语言要伺候的构造多出一倍，而消费方（讲清一段代码怎么走、图上标分支）要的就是语句级。

  三条不撒谎的规矩：
  - 语法树没就绪、或这门语言还没写规则 ⇒ `backend: "none"` 并把原因落到 `skipped`，**绝不交一张空图冒充「这个函数没分支」**。
  - 块数打满上限 ⇒ 置 `truncated`，不悄悄砍；`goto` 找不到标签 ⇒ 记进 `notes`，不猜一条边接上。
  - 函数键取自符号表（`symbol:<路径>:<名字>:<行>`），与调用边、讲解切片同一个 id，产物之间能直接对上。

  下面每语言的节点名与字段名都出自本机语法树的逐语言普查（不限深度，含 `childForFieldName` 探测），
  不是按记忆写的：同一份普查也钉住了「Python 的 `elif_clause` 带 condition 字段」「Go 的分支直接挂在
  switch 节点上、Rust 隔一层 `match_block`」这类不查就会写错的细节。
*/

/** 一个函数最多留这么多块，超出只留前面这些并置 `truncated`。 */
const MAX_BLOCKS = 200;

/** 语句序列容器：各语言名字不同，但都是「具名子节点即语句」。 */
const SEQUENCE_NODES = new Set(["statement_block", "block", "compound_statement", "statement_list", "switch_body", "switch_block", "match_block"]);

/** 分支壳：`else` / `elif` / `except` / `finally` 这类「外壳本身就是分支」的节点。 */
const BRANCH_SHELL = /^(else|elif|except|finally)_?clause$/;

/** 分支头与标签名（`case 1:` 的 1、`match` 的模式、C# 的 pattern）：说明「凭什么走这条」，不是要执行的语句。 */
const ARM_HEADER = /^(case|default|switch_label|constant_pattern|match_pattern|when|guard|expression_list|label_name|statement_identifier|identifier)$/;

const set = (...types: string[]): Set<string> => new Set(types);

interface CfgSpec {
  /** 有独立可执行体的载体：每一个开一张图 */
  functionNodes: Set<string>;
  ifNodes: Set<string>;
  loopNodes: Set<string>;
  /** 先跑体、后判条件（do-while） */
  postTestLoops: Set<string>;
  /** 没有条件的循环（Rust 的 `loop`）；`for {}` 那种「有条件字段缺失」的情况另判 */
  endlessLoops: Set<string>;
  switchNodes: Set<string>;
  /** 一个分支：`case …:`、`case … ->`、`match` 的一臂、`select` 的一个通信 */
  caseNodes: Set<string>;
  /** 这些分支执行完**不会**掉进下一个（Rust 的 match、C# 的 switch、Java 的 `->` 形式） */
  noFallthroughArms: Set<string>;
  /** 走完一臂不 break 就自动掉进下一臂（C 系、Java 冒号形式、TS）；false = 只有显式 `fallthrough` 才掉 */
  implicitFall: boolean;
  /** 显式「掉下去」的语句（Go 的 `fallthrough`） */
  fallthroughNodes: Set<string>;
  tryNodes: Set<string>;
  handlerNodes: Set<string>;
  finalizerNodes: Set<string>;
  /** 正常离开函数：全部汇到同一个出口块（图上只有一个「走到头」的格子，读图的人才数得清） */
  returnNodes: Set<string>;
  /** 异常离开函数：各自成一个出口块——它和「正常返回」不是一条路，不能合进同一个格子 */
  throwNodes: Set<string>;
  breakNodes: Set<string>;
  continueNodes: Set<string>;
  /** 只是包了一层体的语句（Python 的 `with`、C# 的 `checked`/`lock`）：按顺序穿过去 */
  transparentNodes: Set<string>;
  /** 可能提前离开函数、也可能继续（Rust 的 `?`）：一条继续边 + 一条到出口的异常边 */
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
  // 这份语法里冒号形式与箭头形式都叫 switch_expression，区别在体里是 group 还是 rule
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
  // Go 只在写了 fallthrough 时才掉下去，所以「掉」是一条显式边，不是默认
  noFallthroughArms: set(),
  // Go 只在写了 `fallthrough` 时才掉下去，所以「掉」是一条显式边，不是默认
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

/** C 与 C++ 共用一份语法：差异只体现在「有没有这个节点」，表里并集放着不会错连。 */
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
  // C++ 的 catch 既是处理器也兜住「没有 finally」这件事：同一节点两处出现会被去重，不会画两条边
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

/** 活的出口：一个可以往里追加语句的当前块；null = 这条路已经走断了。 */
type Cursor = CfgBlock | null;

interface Frame {
  builder: Builder;
  spec: CfgSpec;
  /** `break` 的落点（switch 与循环各自设） */
  breakTo?: CfgBlock;
  /** `continue` 的落点（只有循环设） */
  continueTo?: CfgBlock;
  /** `fallthrough` 的落点（Go） */
  fallTo?: CfgBlock;
  /** 函数出口块：`?` 这类提前离开走这里 */
  exit: CfgBlock;
  /** 标签名 → 标签处那个块（给 `goto` 收尾接线用） */
  labels: Map<string, CfgBlock>;
  /** 还没接上的 `goto`：C 与 Go 都允许向前跳，所以先记账、建完再连 */
  gotos: { from: CfgBlock; label: string; line: number }[];
  /** 接不上的东西（goto 找不到标签、break 在循环外）：如实记，不猜一条边 */
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

  /**
    收尾：把「从入口走不到、又不记任何语句」的脚手架块摘掉，连带它的边。

    这类块是建图过程的副产品——没人用到的汇合点、标签语句后面那一格、`goto` 之后为下一条
    语句临时开的空壳。**有语句的走不到块要留着**：那是死代码，是有效读数。
    留着空壳，图上就多一格谁都进不去的方块，读图的人会以为那里有一条路。
  */
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

  /** 圈复杂度取图自己的性质：`边 - 节点 + 2`，数的是独立回路个数，不另立一套判据。 */
  complexity(): number {
    return Math.max(1, this.edges.length - this.blocks.length + 2);
  }
}

/** 按字段名依次试（各语法的字段名不统一，位置约定也不统一，所以两条都要）。 */
function fieldOf(node: SyntaxNode, fields: string[]): SyntaxNode | undefined {
  for (const name of fields) {
    const child = node.childForFieldName(name);
    if (child) return child;
  }
  return undefined;
}

/** 注释不是语句：块里数出来的是「走了几步」，把注释算进去每个函数都凭空多几步。 */
function isStatement(node: SyntaxNode): boolean {
  return !/^comment|line_comment|block_comment$/i.test(node.type);
}

function isSequence(node: SyntaxNode): boolean {
  return SEQUENCE_NODES.has(node.type);
}

function isBranchShell(node: SyntaxNode): boolean {
  return BRANCH_SHELL.test(node.type);
}

/** 判定条件：字段拿不到就退到「第一个不是体、不是壳、不是注释的具名子节点」。 */
function conditionOf(node: SyntaxNode): SyntaxNode | undefined {
  return fieldOf(node, ["condition", "test", "value"]) ?? node.namedChildren.find((child) => isStatement(child) && !isSequence(child) && !isBranchShell(child) && !looksLikeBody(child));
}

/** 循环体 / 函数体：字段拿不到就退到最后一个具名子节点（各语言的体都在末尾）。 */
function bodyOf(node: SyntaxNode): SyntaxNode | undefined {
  return fieldOf(node, ["body", "consequent", "consequence", "then"]) ?? node.namedChildren.filter(isStatement).at(-1);
}

function looksLikeBody(node: SyntaxNode): boolean {
  return isSequence(node) || node.type === "do";
}

/** 一个 `if` 的 then 体：排除条件、else 壳与括号之后剩下的那一个。 */
function consequentOf(node: SyntaxNode): SyntaxNode | undefined {
  const condition = conditionOf(node);
  return node.namedChildren.find((child) => isStatement(child) && child.id !== condition?.id && !isBranchShell(child) && child.type !== "parenthesized_expression");
}

function alternativeOf(node: SyntaxNode): SyntaxNode | undefined {
  return fieldOf(node, ["alternative"]) ?? node.namedChildren.find(isBranchShell);
}

/** 一个 `if` 后面挂着的分支壳（`elif` 链 + `else`），或某些语法里直接挂在 alternative 上的那一块。 */
function elseArmsOf(node: SyntaxNode): SyntaxNode[] {
  const shells = node.namedChildren.filter(isBranchShell);
  if (shells.length) return shells;
  const alternative = alternativeOf(node);
  return alternative && alternative !== consequentOf(node) ? [alternative] : [];
}

interface IfArm {
  /** 这一臂的判定节点（进 `branch` 块的行区间） */
  node: SyntaxNode;
  body: SyntaxNode[];
}

/**
  把 `if / elif / else if / else` 拉平成一串判定 + 一个可选的 else。
  为什么要拉平：Python 把 elif 与 else 并排挂在同一个 if_statement 上，Java/Go 却把 else-if 塞成
  alternative 位置的嵌套 if——只读 `alternative` 那一份的实现会**整条丢掉 elif 体**（第一版就是），
  拉平之后两种形状走同一段代码。
*/
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

/** 取一个节点的语句序列：体、分支壳、或单语句都归一成数组。 */
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

/**
  Go 的函数体是 `block` 里再套一层 `statement_list`（C# 的 switch 段同理）：
  不splice 就会把整串语句当成**一条**语句塞进一个块，函数看着只有两格、其实全糊在一起。
*/
function splice(children: SyntaxNode[]): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const child of children) {
    if (isSequence(child)) out.push(...splice(child.namedChildren.filter(isStatement)));
    else out.push(child);
  }
  return out;
}

/**
  分支清单：从 switch/select 往下找 `caseNodes`，**不钻进嵌套的那一层**。
  为什么不直接读某个字段：六门语法把分支挂在三种位置上——TS/Java/C# 在 body 那个容器里、
  Go 直接是 switch 自己的子节点、Rust 隔一层 `match_block`。按字段名写死就会一换语言就空表。
*/
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

/** 分支头（`case 1:` 的 1、`match` 的模式）：留在块上，图上才说得出「凭什么走这条」。 */
function armHeaderOf(arm: SyntaxNode): SyntaxNode | undefined {
  return arm.namedChildren.find((child) => ARM_HEADER.test(child.type));
}

/** ⚠️ 一律比 `id` 而不是比对象：tree-sitter 每次取子节点都返回新的包装对象，`a !== b` 恒成立。 */
function armBodyOf(arm: SyntaxNode, header: SyntaxNode | undefined): SyntaxNode[] {
  return splice(arm.namedChildren.filter((child) => isStatement(child) && child.id !== header?.id && !ARM_HEADER.test(child.type)));
}

function labelNameOf(node: SyntaxNode): string | undefined {
  return fieldOf(node, ["label"])?.text.trim() ?? node.namedChildren.at(0)?.text.trim();
}

function gotoTargetOf(node: SyntaxNode): string | undefined {
  return fieldOf(node, ["label"])?.text.trim() ?? node.namedChildren.at(-1)?.text.trim();
}

/**
  跑一串语句，返回**最后一个活的块**（null = 后面已经没有路径能走到）。

  每个构造都自己负责接线：分支开 `branch`/`loop`/`selector` 块，汇合处再开一个普通块，
  所以调用方拿到的永远是「一个可以往里追加语句的块」或「没有」。
*/
function run(statements: SyntaxNode[], cursor: Cursor, frame: Frame): Cursor {
  let current = cursor;
  for (const statement of statements) {
    if (!current) {
      // 已经没有路径走到这里（`return`/`goto` 之后）。仍给它开一格且不接线：不可达代码要在图上是
      // 一格进不去的节点，而不是被静默丢掉。但仍然要过一遍 step —— 标签得注册、循环要建出来，
      // 否则「向前 goto」会因为标签没登记而永远接不上
      current = frame.builder.open("straight", statement);
    }
    current = step(statement, current, frame);
  }
  return current;
}

/**
  语句位置的壳要穿过去：Rust 的 `if` / `match` / `return` 本质是**表达式**，
  语法树把它们包在 `expression_statement` 里。不穿这一层，整个 Rust 函数就只剩一串普通语句、
  一条分支都没有——形状看着对，内容全是假的。
*/
function unwrapStatement(node: SyntaxNode, spec: CfgSpec): SyntaxNode {
  if (node.type !== "expression_statement") return node;
  const inner = node.namedChildren.find(isStatement);
  if (!inner) return node;
  const control = spec.ifNodes.has(inner.type) || spec.loopNodes.has(inner.type) || spec.switchNodes.has(inner.type) || spec.tryNodes.has(inner.type)
    || spec.returnNodes.has(inner.type) || spec.throwNodes.has(inner.type) || spec.breakNodes.has(inner.type) || spec.continueNodes.has(inner.type) || spec.propagateNodes.has(inner.type);
  return control ? inner : node;
}

/** 处理一条语句，返回新的当前块（null = 这条语句把路径走断了）。 */
function step(node: SyntaxNode, current: CfgBlock, frame: Frame): Cursor {
  const { builder, spec } = frame;
  const statement = unwrapStatement(node, spec);

  if (spec.returnNodes.has(statement.type) || spec.throwNodes.has(statement.type)) {
    // 每条离开函数的语句各占一格，并记在自己的行区间上：数据流靠「这一行落在哪个块」把使用
    // 点对到定义，汇成一个出口会把 `return x` 那行的归属丢掉（第一版就是这么错的）
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
    // Rust 的 `?`：Err 走出口、Ok 继续往下。两条边都给，不假装知道走哪条
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

  // 普通语句。Rust 的 `?` 常常藏在 `let v = f()?;` 里，而它**能提前离开函数**：
  // 只看语句类型会把它当成一步普通赋值，图上就少一条出函数的路。所以扫一遍子树，
  // 有传播型错误就把这一格升成判定块（继续 / 走出口两条边）。
  if (spec.propagateNodes.size && hasPropagate(statement, spec)) {
    const gate = builder.open("branch", statement, [statement.type, "propagate"]);
    builder.link(current, gate, "next");
    builder.link(gate, frame.exit, "exception");
    return gate;
  }
  builder.append(current, statement);
  return current;
}

/** 语句子树里有没有「可能提前离开函数」的构造（限深 6 层：再深就不是一个语句该管的事了）。 */
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
      // 每一臂都是图上一个独立的判定块：读图的人才看得出「这里有第三种可能」，而不是以为只有真/假两条
      const next = builder.open("branch", arm.node, [arm.node.type]);
      builder.link(branch, next, "false");
      branch = next;
    }
    const tail = run(arm.body, entryFrom(builder, branch, "true", arm.node, "then"), frame);
    tails.push(tail ?? null);
  });
  if (otherwise) {
    // `elif` 之后没有 else 时，最后那个判定的 false 直接汇到 merge；有 else 才走 else 体
    const tail = run(statementsOf(otherwise), entryFrom(builder, branch, "false", otherwise, otherwise.type), frame);
    if (tail) tails.push(tail);
  } else {
    builder.link(branch, merge, "false");
  }
  for (const tail of tails) if (tail) builder.link(tail, merge, "next");
  return merge;
}

/** 分支的入口块：先开一个空块接住这条边，语句才有地方落。 */
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
  // Python 的 `for … else` / `while … else`：正常跑完（没 break）才进 else，所以 break 天然绕过它
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
  // 每臂的入口先全部建好并接上 selector：fallthrough 的目标就是「下一臂的入口」本身，
  // 为它另开一格会让图上多出一个谁都进不去的孤儿块
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
    // C/Java 冒号形式/C++：没写 break 就掉进下一臂。Go 只有显式 fallthrough 才掉，Rust 与 C# 根本不掉
    if (tail && spec.implicitFall && nextEntry) builder.link(tail, nextEntry, "next");
    if (tail) builder.link(tail, after, "next");
  });
  if (!arms.length) builder.link(selector, after, "next");
  // 没有 default 的 switch 必须有一条「一个都没匹配上，直接往下」的边：
  // 否则「每个分支都 terminating」的 switch 会让 after 变成走不到，后面的代码在图上凭空消失
  else if (!arms.some(isDefaultArm)) builder.link(selector, after, "false");
  return after;
}

/** 这一臂是不是兜底臂：`default:`、Go 的 `default_case`、Rust 的 `_ =>`。 */
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
    // 异常边从「进体」与「体出来」两处出去：静态上不知道抛在哪一行，所以不假装知道
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

/** `标签: 语句`：标签处是被标注语句的**入口**（Go/C 的 `goto` 落这里），而 `break 标签` 落在这条语句之后。 */
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
  /** 没有名字的函数体（回调那些）：不成图，但要在 `skipped` 里点名，不能当它不存在 */
  anonymous?: boolean;
}

/**
  找出「有体的那些节点」并与符号表对上：id 必须与 `SymbolInfo.id` 逐字一致，
  否则这张图与调用边、讲解切片说的是两个函数。
*/
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
  // 出口块先建好：`return` 与 Rust 的 `?` 都要往这里接线
  const exit = builder.open("exit", carrier.node);
  exit.startLine = carrier.endLine;
  exit.endLine = carrier.endLine;
  const frame: Frame = { builder, spec, exit, labels: new Map<string, CfgBlock>(), gotos: [], notes: [] };
  const tail = run(statementsOf(bodyOf(carrier.node)), entry, frame);
  // 只有「走到函数尾」真的可达时才接线：以 `return` 收尾的函数不需要第二条出边
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
    // 按行号排：块的数组顺序就是读代码的顺序，而边只认 id，排序不会改接线
    blocks: builder.blocks.sort((left, right) => left.startLine - right.startLine || left.id - right.id),
    edges: builder.edges,
    exitBlocks: kept && sinks.includes(exit.id) ? sinks : kept ? [exit.id, ...sinks] : sinks,
    complexity: builder.complexity(),
    ...(builder.truncated ? { truncated: true } : {}),
    ...(frame.notes.length ? { notes: frame.notes } : {})
  };
}

/** 一个函数：语法树里的体节点 + 它的控制流图 + 对上的符号（可能没有，见 skipped）。 */
export interface FunctionScope {
  node: SyntaxNode;
  cfg: CfgFunction;
  symbol?: SymbolInfo;
  language: string;
}

/**
  一次解析，逐函数回调。控制流图与数据流、类型关系**共用这一趟**：语法树解析是全仓最贵的一步，
  每多一类产物就多扫一遍源码（复审 #170 就记过「一轮两遍全仓读」这笔账）。

  ⚠️ `visit` 必须在回调内用完节点：回调一返回语法树就被释放，留在外面的节点引用会读出空值与
  `ERROR`（第一版把节点存到数组里，测试当场抓到了）。
*/
export function eachFunction(path: string, content: string, symbols: SymbolInfo[], language: string, visit?: (scope: FunctionScope) => void): CfgFileFact {
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
  const trees = withSyntaxTrees(path, content, (root) => {
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
    ...orphanCarriers.map((carrier): FactSkip => ({ name: `${carrier.name}@${carrier.line}`, reason: "语法树里有可执行体，符号表里没有它——两处的判据漂了，这张图不替它圆场" })),
    ...anonymous.map((carrier): FactSkip => ({ name: `${carrier.name}@${carrier.line}`, reason: "匿名函数体（没有可寻址的名字），未单独成图" }))
  ];
  return { path, language, backend: "ast", version: FACTS_VERSION, functions: drawn.sort((left, right) => left.startLine - right.startLine), ...(skipped.length ? { skipped } : {}) };
}

/**
  一个文件的控制流图。`symbols` 传符号表（决定函数 id 与归属），返回的形状里
  `backend` 为 `none` 时 `functions` 必空、`skipped` 必非空——空图与没判过永远不混。
*/
export function buildFileCfg(path: string, content: string, symbols: SymbolInfo[], language: string): CfgFileFact {
  return eachFunction(path, content, symbols, language);
}

/** `.vue` 走 tsx/js 语法，但符号表按 vue 记：这里只按扩展名挑节点表。 */
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
