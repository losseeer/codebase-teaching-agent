import type { CfgBlock, CfgEdge, CfgEdgeKind, CfgFileFact, CfgFunction, FactSkip, SymbolInfo } from "@codebase-tutor/shared";
import { withSyntaxTrees, type GrammarName, type SyntaxNode } from "../depgraph/parser.js";
import { FACTS_VERSION } from "./version.js";

/**
  函数内的控制流图：把「哪些语句可能按什么顺序被执行」收成节点与边。

  与依赖图分家的那一半事实——图回答「谁指向谁」，这里回答**单个函数体内**的走向。
  粒度刻意是语句级的（一块 = 一串顺序语句，边 = 走向），不做教科书式的基本块切分：
  真按基本块切，每语言要伺候的构造多出一倍，而消费方（讲清一段代码怎么走、图上标分支）要的就是语句级。

  三条不撒谎的规矩：
  - 语法树没就绪、或这门语言还没写规则 ⇒ `backend: "none"` 并把原因落到 `skipped`，**绝不交一张空图冒充「这个函数没分支」**。
  - 块数打满上限 ⇒ 置 `truncated`，不悄悄砍。
  - 函数键取自符号表（`symbol:<路径>:<名字>:<行>`），与调用边、讲解切片同一个 id，产物之间能直接对上。
*/

/** 一个函数最多留这么多块，超出只留前面这些并置 `truncated`。 */
const MAX_BLOCKS = 200;

/** 语句序列容器：各语言名字不同，但都是「具名子节点即语句」。 */
const SEQUENCE_NODES = new Set(["statement_block", "block", "compound_statement", "statement_list", "switch_body"]);

/** 注释不是语句：块里数出来的是「走了几步」，把注释算进去会让每个函数都凭空多几步。 */
function isStatement(node: SyntaxNode): boolean {
  return !/^comment|line_comment|block_comment$/i.test(node.type);
}

interface CfgSpec {
  /** 有独立可执行体的载体：每一个开一张图 */
  functionNodes: Set<string>;
  ifNodes: Set<string>;
  loopNodes: Set<string>;
  /** 先跑体、后判条件（do-while） */
  postTestLoops: Set<string>;
  /** 没有条件的循环（Go 的 `for {}`、Rust 的 `loop`） */
  endlessLoops: Set<string>;
  switchNodes: Set<string>;
  caseNodes: Set<string>;
  tryNodes: Set<string>;
  handlerNodes: Set<string>;
  finalizerNodes: Set<string>;
  /** 直接离开当前路径：return / throw / raise */
  exitNodes: Set<string>;
  breakNodes: Set<string>;
  continueNodes: Set<string>;
}

/**
  节点名取自本机语法树的实测读数（`pnpm tsx` 逐语言打了一遍），不是凭记忆写的。
  目前只有 TS 一族；没有条目的语法交 `backend: "none"`，由刀 2 逐门补齐。
*/
const SPECS: Partial<Record<GrammarName, CfgSpec>> = {
  typescript: tsSpec(),
  tsx: tsSpec(),
  javascript: tsSpec()
};

function tsSpec(): CfgSpec {
  return {
    functionNodes: new Set(["function_declaration", "function_expression", "generator_function_declaration", "generator_function", "arrow_function", "function", "method_definition", "method_declaration", "constructor_declaration"]),
    ifNodes: new Set(["if_statement"]),
    loopNodes: new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]),
    postTestLoops: new Set(["do_statement"]),
    endlessLoops: new Set(),
    switchNodes: new Set(["switch_statement"]),
    caseNodes: new Set(["switch_case", "switch_default"]),
    tryNodes: new Set(["try_statement"]),
    handlerNodes: new Set(["catch_clause"]),
    finalizerNodes: new Set(["finally_clause"]),
    exitNodes: new Set(["return_statement", "throw_statement"]),
    breakNodes: new Set(["break_statement"]),
    continueNodes: new Set(["continue_statement"])
  };
}

/** 按字段名依次试（各语法的字段名不统一，位置约定也不统一，所以两条都要）。 */
function fieldOf(node: SyntaxNode, fields: string[]): SyntaxNode | undefined {
  for (const name of fields) {
    const child = node.childForFieldName(name);
    if (child) return child;
  }
  return undefined;
}

function isSequence(node: SyntaxNode): boolean {
  return SEQUENCE_NODES.has(node.type);
}

/** 分支壳：`else_clause` / `elif_clause` / `except_clause` 这类「外壳本身就是分支」的节点。 */
function isBranchShell(node: SyntaxNode): boolean {
  return /^(else|elif|except|finally)_?clause$/.test(node.type) || node.type === "else" || node.type === "elif_clause";
}

/** 判定条件：字段拿不到就退到「第一个不是体、也不是注释的具名子节点」。 */
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
  return node.namedChildren.find((child) => isStatement(child) && child !== condition && !isBranchShell(child) && !isParens(child));
}

/** 括号本身在语法树里是个节点（TS 的 `parenthesized_expression`），条件要穿过它。 */
function isParens(node: SyntaxNode): boolean {
  return node.type === "parenthesized_expression";
}

function alternativeOf(node: SyntaxNode): SyntaxNode | undefined {
  return fieldOf(node, ["alternative"]) ?? node.namedChildren.find(isBranchShell);
}

/** 取一个节点的语句序列：体、分支壳、或单语句都归一成数组。 */
function statementsOf(node: SyntaxNode | undefined): SyntaxNode[] {
  if (!node) return [];
  if (isSequence(node)) return node.namedChildren.filter(isStatement);
  if (isBranchShell(node)) {
    const inner = statementsOf(bodyOf(node));
    return inner.length ? inner : node.namedChildren.filter(isStatement).flatMap(statementsOf);
  }
  const inner = bodyOf(node);
  if (inner && (isSequence(inner) || isBranchShell(inner))) return statementsOf(inner);
  return [node];
}

interface Frame {
  builder: Builder;
  spec: CfgSpec;
  /** `break` 的落点（switch 与循环各自设） */
  breakTo?: CfgBlock;
  /** `continue` 的落点（只有循环设） */
  continueTo?: CfgBlock;
}

class Builder {
  readonly blocks: CfgBlock[] = [];
  readonly edges: CfgEdge[] = [];
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

  /** 圈复杂度取图自己的性质：`边 - 节点 + 2`，数的是独立回路个数，不另立一套判据。 */
  complexity(): number {
    return Math.max(1, this.edges.length - this.blocks.length + 2);
  }
}

/**
  跑一串语句，返回**活的尾块**（空数组 = 后面已经没有路径能走到）。

  每个构造都自己负责接线：分支开 `branch`/`loop`/`selector` 块，汇合处再开一个普通块，
  所以调用方拿到的永远是「一个可以往里追加语句的块」或「没有」。
*/
function run(statements: SyntaxNode[], cursor: CfgBlock | null, frame: Frame): CfgBlock[] {
  let current = cursor;
  for (const statement of statements) {
    if (!current) {
      // 已经没有路径走到这里（`return` 之后还有语句）。仍给它开一格且不接线：
      // 不可达代码要在图上是一格进不去的节点，而不是被静默丢掉
      current = frame.builder.open("straight", statement, [statement.type]);
      continue;
    }
    current = step(statement, current, frame);
  }
  return current ? [current] : [];
}

/** 处理一条语句，返回新的当前块（null = 这条语句把路径走断了）。 */
function step(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock | null {
  const { builder, spec } = frame;

  if (spec.exitNodes.has(statement.type)) {
    const exit = builder.open("exit", statement, [statement.type]);
    builder.link(current, exit, "next");
    return null;
  }
  if (spec.breakNodes.has(statement.type)) {
    if (frame.breakTo) builder.link(current, frame.breakTo, "next");
    return null;
  }
  if (spec.continueNodes.has(statement.type)) {
    if (frame.continueTo) builder.link(current, frame.continueTo, "back");
    return null;
  }
  if (spec.ifNodes.has(statement.type)) return buildIf(statement, current, frame);
  if (spec.loopNodes.has(statement.type)) return buildLoop(statement, current, frame);
  if (spec.switchNodes.has(statement.type)) return buildSwitch(statement, current, frame);
  if (spec.tryNodes.has(statement.type)) return buildTry(statement, current, frame);

  builder.append(current, statement);
  return current;
}

function buildIf(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const branch = builder.open("branch", statement, ["if"]);
  builder.link(current, branch, "next");
  const thenLive = run(statementsOf(consequentOf(statement)), linkInto(builder, branch, "true", statement), frame);

  const alternative = alternativeOf(statement);
  const merge = builder.open("straight", statement);
  if (alternative) {
    const elseLive = run(statementsOf(alternative), linkInto(builder, branch, "false", alternative), frame);
    for (const tail of [...thenLive, ...elseLive]) builder.link(tail, merge, tail === branch ? "false" : "next");
  } else {
    // 没有 else：条件不成立就是直接往下，这条 `false` 边必须存在，否则图上看不出「还有一条路」
    builder.link(branch, merge, "false");
    for (const tail of thenLive) builder.link(tail, merge, "next");
  }
  void spec;
  return merge;
}

/** 分支的入口块：先开一个空块接住这条边，语句才有地方落。 */
function linkInto(builder: Builder, from: CfgBlock, kind: CfgEdgeKind, at: SyntaxNode): CfgBlock {
  const entry = builder.open("straight", at);
  builder.link(from, entry, kind);
  return entry;
}

function buildLoop(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const head = builder.open("loop", statement, spec.endlessLoops.has(statement.type) ? ["loop"] : ["condition"]);
  const after = builder.open("straight", statement);
  const inner: Frame = { ...frame, breakTo: after, continueTo: head };
  const body = statementsOf(bodyOf(statement));

  if (spec.postTestLoops.has(statement.type)) {
    const entry = linkInto(builder, current, "next", statement);
    const tails = run(body, entry, inner);
    for (const tail of tails) builder.link(tail, head, "back");
    builder.link(head, entry, "true");
    builder.link(head, after, "false");
    return after;
  }
  builder.link(current, head, "next");
  const entry = linkInto(builder, head, spec.endlessLoops.has(statement.type) ? "next" : "true", statement);
  const tails = run(body, entry, inner);
  for (const tail of tails) builder.link(tail, head, "back");
  if (!spec.endlessLoops.has(statement.type)) builder.link(head, after, "false");
  return after;
}

function buildSwitch(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const selector = builder.open("selector", statement, ["switch"]);
  builder.link(current, selector, "next");
  const after = builder.open("straight", statement);
  const arms = (bodyOf(statement)?.namedChildren ?? []).filter((child) => spec.caseNodes.has(child.type));  let pending: CfgBlock[] = [];
  for (const arm of arms) {
    const label = arm.namedChildren.find((child) => !isSequence(child));
    const armEntry = builder.open("straight", arm, [arm.type]);
    builder.link(selector, armEntry, "next");
    if (label) builder.append(armEntry, label);
    // 上一个分支没写 break 就掉进来：这条 fallthrough 边必须画出来，不然「少一个 break」这个经典 bug 在图上不存在
    for (const tail of pending) builder.link(tail, armEntry, "next");
    pending = run(arm.namedChildren.filter((child) => isStatement(child) && child !== label && !spec.caseNodes.has(child.type)), armEntry, { ...frame, breakTo: after });
  }
  for (const tail of pending) builder.link(tail, after, "next");
  if (!arms.length) builder.link(selector, after, "next");
  return after;
}

function buildTry(statement: SyntaxNode, current: CfgBlock, frame: Frame): CfgBlock {
  const { builder, spec } = frame;
  const bodyEntry = linkInto(builder, current, "next", statement);
  const bodyTails = run(statementsOf(bodyOf(statement)), bodyEntry, frame);
  const merge = builder.open("straight", statement);
  for (const tail of bodyTails) builder.link(tail, merge, "next");

  for (const child of statement.namedChildren) {
    if (!spec.handlerNodes.has(child.type)) continue;
    const handler = builder.open("handler", child, ["catch"]);
    // 异常边从**体内每一个活块**出去：静态上不知道抛在哪一行，所以不假装知道——画成「进体之后任何一点都可能跳出去」
    for (const tail of bodyTails.length ? bodyTails : [bodyEntry]) builder.link(tail, handler, "exception");
    for (const tail of run(statementsOf(bodyOf(child)), handler, frame)) builder.link(tail, merge, "next");
  }
  let live: CfgBlock[] = [merge];
  for (const child of statement.namedChildren) {
    if (!spec.finalizerNodes.has(child.type)) continue;
    const entry = linkInto(builder, live.length ? live[0] : merge, "finally", child);
    live = run(statementsOf(bodyOf(child)), entry, frame);
  }
  for (const tail of live) if (tail !== merge) builder.link(tail, merge, "next");
  return merge;
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
      const name = (holder ? holder.childForFieldName("name")?.text : child.childForFieldName("name")?.text)?.trim();
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
  const frame: Frame = { builder: new Builder(), spec };
  const builder = frame.builder;
  const entry = builder.open("entry", carrier.node);
  const tails = run(statementsOf(bodyOf(carrier.node)), entry, frame);
  // 只有「走到函数尾」真的可达时才补一个出口块：以 `return` 收尾的函数不需要第二个出口，
  // 补了就是一个谁都进不去的孤立节点，图上多一格假的
  const exit = tails.length ? builder.open("exit", carrier.node) : undefined;
  for (const tail of tails) builder.link(tail, exit!, "next");
  const sinks = builder.blocks.filter((block) => !builder.edges.some((edge) => edge.from === block.id)).map((block) => block.id);
  return {
    symbolId: symbol?.id ?? `symbol:${path}:${carrier.name}:${carrier.line}`,
    name: carrier.name,
    kind: symbol?.kind ?? "function",
    startLine: carrier.line,
    endLine: carrier.endLine,
    blocks: builder.blocks,
    edges: builder.edges,
    exitBlocks: exit ? [exit.id, ...sinks.filter((id) => id !== exit.id)] : sinks,
    complexity: builder.complexity(),
    ...(builder.truncated ? { truncated: true } : {})
  };
}

/**
  一个文件的控制流图。`symbols` 传符号表（决定函数 id 与归属），返回的形状里
  `backend` 为 `none` 时 `functions` 必空、`skipped` 必非空——空图与没判过永远不混。

  ⚠️ 整张图必须在 `withSyntaxTrees` 的回调**里面**算完：回调一返回，语法树就被释放，
  留在外面的节点引用会读出空值与 `ERROR`（第一版就是这么写的，测试当场抓到了）。
  所以回调只往外交「已经算好的普通对象 + 定位用的行号」，一个节点都不留。
*/
export function buildFileCfg(path: string, content: string, symbols: SymbolInfo[], language: string): CfgFileFact {
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
      drawn.push(buildOne(carrier, path, symbol, spec));
    }
  });
  if (!trees) {
    return { path, language, backend: "none", version: FACTS_VERSION, functions: [], skipped: [{ name: path, reason: "语法树不可用（解析器未就绪或该文件没有对应语法），本文件未做控制流分析" }] };
  }
  const skipped: FactSkip[] = [
    ...executable.filter((symbol) => !claimed.has(symbol.id)).map((symbol): FactSkip => ({ name: `${symbol.name}@${symbol.line}`, reason: "符号表里有这个函数，语法树里却找不到对应的可执行体（多为宏或生成代码），未画控制流" })),
    ...orphanCarriers.map((carrier): FactSkip => ({ name: `${carrier.name}@${carrier.line}`, reason: "语法树里有可执行体，符号表里没有它——两处的判据漂了，这张图不替它圆场" })),
    ...anonymous.map((carrier): FactSkip => ({ name: `${carrier.name}@${carrier.line}`, reason: "匿名函数体（没有可寻址的名字），未单独成图" }))
  ].sort((left, right) => Number(left.name.split("@").at(-1)) - Number(right.name.split("@").at(-1)));
  return { path, language, backend: "ast", version: FACTS_VERSION, functions: drawn.sort((left, right) => left.startLine - right.startLine), ...(skipped.length ? { skipped } : {}) };
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
