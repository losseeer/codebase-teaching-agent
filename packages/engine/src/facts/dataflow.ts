import type { CfgFunction, DataflowFunctionFact, DataflowRole, DataflowUse, DataflowVariable } from "@codebase-tutor/shared";
import type { SyntaxNode } from "../depgraph/parser.js";
import type { FunctionScope } from "./cfg.js";

/**
  函数内的数据流：每个变量的定义点、使用点，以及每次使用「能被哪些定义到达」。
  算的是经典的到达定义（reaching definitions）——沿控制流图的边做前向不动点，
  不是「同一函数里出现过的赋值」那种糊账：后者在 `if` 的两个分支之间会给出假到达。

  刻意只做到**函数内**这一层。跨过程要别名分析（`obj.field` 到底指向谁），Python/JS 这类
  动态语言在静态前提下精度上不去，业界把它当独立产品线做（Soot / WALA / CodeQL）——
  做不动就明说做不动，不交一份看着像、实际会骗人的表。

  两条已写进能力表的限制：
  - 变量粒度是「名字」，不分「名字 + 路径」：`a.b = 1` 记成对 `a` 的一次写。
  - 块是按行区间对上的（取最小的那个包含块），所以同一行上的多个构造会落进同一块。
*/

const MAX_VARIABLES = 200;
const MAX_USES = 60;
const MAX_ROUNDS = 60;

/** 赋值、声明、参数、自增、解构——这些都是「写」。 */
const WRITE_NODE = /assignment|declarator|let_declaration|short_var_declaration|parameter|inc_statement|increment_statement|destructured|equals_value_clause/;
/** 成员访问：点后面那个名字不是对变量的使用。 */
const MEMBERISH = /^(member_expression|member_chain_expression|attribute|member_access_expression|field_expression|navigation_expression)$/;
const TARGET_FIELDS = ["name", "left", "pattern", "declarator", "argument", "operand"];

interface Site {
  name: string;
  line: number;
  block: number;
  role: DataflowRole;
}

function findIdentifier(node: SyntaxNode, depth = 0): SyntaxNode | undefined {
  if (node.type === "identifier") return node;
  if (depth > 4) return undefined;
  for (const child of node.namedChildren) {
    const found = findIdentifier(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** 被写的那个名字：先按各语法的字段名找，再退到子树里第一个标识符（解构模式取头一个）。 */
function targetOf(node: SyntaxNode): SyntaxNode | undefined {
  for (const field of TARGET_FIELDS) {
    const target = node.childForFieldName(field);
    if (!target) continue;
    if (target.type === "identifier") return target;
    const inner = findIdentifier(target);
    if (inner) return inner;
  }
  return findIdentifier(node);
}

function roleOf(node: SyntaxNode): DataflowRole {
  if (/parameter/.test(node.type)) return "param";
  if (/declarator|let_declaration|equals_value_clause/.test(node.type)) return "init";
  return "assign";
}

function isPropertyPosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent || !MEMBERISH.test(parent.type)) return false;
  const owner = parent.childForFieldName("object") ?? parent.childForFieldName("value");
  return owner?.id !== node.id;
}

function inArgumentList(node: SyntaxNode): boolean {
  return /argument_list|arguments|expression_list|actual_parameters/.test(node.parent?.type ?? "");
}

function collectSites(body: SyntaxNode, skipName: SyntaxNode | undefined): { defs: Site[]; reads: Site[] } {
  const defs: Site[] = [];
  const reads: Site[] = [];
  const written = new Set<number>(skipName ? [skipName.id] : []);
  const walk = (node: SyntaxNode): void => {
    if (WRITE_NODE.test(node.type)) {
      const target = targetOf(node);
      if (target && !written.has(target.id)) {
        written.add(target.id);
        const name = target.text.trim();
        if (name) defs.push({ name, line: target.startPosition.row + 1, block: 0, role: roleOf(node) });
      }
    }
    if (node.type === "identifier" && !written.has(node.id) && !isPropertyPosition(node)) {
      const name = node.text.trim();
      const parent = node.parent?.type ?? "";
      const role: DataflowRole = /return/.test(parent) ? "return" : inArgumentList(node) ? "argument" : "read";
      if (name) reads.push({ name, line: node.startPosition.row + 1, block: 0, role });
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(body);
  return { defs, reads };
}

/** 站点归块：取行区间最小的那个包含块（分支块比外层块精确）。 */
function blockFor(graph: CfgFunction, line: number): number {
  let best: { id: number; span: number } | undefined;
  for (const block of graph.blocks) {
    if (line < block.startLine || line > block.endLine) continue;
    const span = block.endLine - block.startLine;
    if (!best || span < best.span) best = { id: block.id, span };
  }
  return best?.id ?? graph.blocks[0]?.id ?? 0;
}

export function analyzeFunctionDataflow(scope: FunctionScope): DataflowFunctionFact {
  const { cfg } = scope;
  // 从整个函数节点起手，而不是只走体：参数是**入口处的一次定义**，漏掉它，函数体里所有
  // 对参数的读都会被误报成「没有任何定义能到达」。函数自己的名字要跳过——它不是对变量的使用。
  const { defs, reads } = collectSites(scope.node, scope.node.childForFieldName("name") ?? undefined);
  const sites = [...defs, ...reads];
  for (const site of sites) site.block = blockFor(cfg, site.line);

  const keyOf = (site: Site): string => `${site.name}@${site.line}`;
  const owners = new Map<string, Site>();
  const gen = new Map<number, string[]>();
  const kill = new Map<number, Set<string>>();
  for (const block of cfg.blocks) {
    const inBlock = defs.filter((site) => site.block === block.id);
    for (const site of inBlock) owners.set(keyOf(site), site);
    const names = new Set(inBlock.map((site) => site.name));
    gen.set(block.id, [...names].map((name) => keyOf(inBlock.filter((site) => site.name === name).at(-1)!)));
    kill.set(block.id, new Set(inBlock.map(keyOf)));
  }

  const predecessors = new Map<number, number[]>();
  for (const edge of cfg.edges) predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
  const incoming = new Map<number, Set<string>>(cfg.blocks.map((block) => [block.id, new Set<string>()]));
  const outgoing = new Map<number, Set<string>>(cfg.blocks.map((block) => [block.id, new Set<string>()]));
  let truncated = false;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changed = false;
    for (const block of cfg.blocks) {
      const merged = new Set<string>();
      for (const from of predecessors.get(block.id) ?? []) for (const item of outgoing.get(from) ?? []) merged.add(item);
      const before = incoming.get(block.id)!;
      if (merged.size !== before.size || [...merged].some((item) => !before.has(item))) {
        changed = true;
        incoming.set(block.id, merged);
      }
      const dead = kill.get(block.id) ?? new Set<string>();
      const out = new Set([...(gen.get(block.id) ?? [])]);
      for (const item of merged) if (!dead.has(item)) out.add(item);
      outgoing.set(block.id, out);
    }
    if (!changed) break;
    if (round === MAX_ROUNDS - 1) truncated = true;
  }

  const reachingLines = (site: Site): number[] => {
    const alive = new Set(incoming.get(site.block) ?? []);
    for (const key of gen.get(site.block) ?? []) {
      const owner = owners.get(key);
      if (owner?.name === site.name && owner.line <= site.line) alive.add(key);
    }
    return [...alive].filter((key) => key.split("@")[0] === site.name).map((key) => Number(key.split("@")[1])).sort((a, b) => a - b);
  };

  const grouped = new Map<string, { defs: Site[]; uses: DataflowUse[] }>();
  const row = (name: string) => {
    const existing = grouped.get(name) ?? { defs: [], uses: [] };
    grouped.set(name, existing);
    return existing;
  };
  for (const site of defs) row(site.name).defs.push(site);
  const unresolved: { name: string; line: number }[] = [];
  for (const site of reads) {
    const reaches = reachingLines(site);
    row(site.name).uses.push({ line: site.line, block: site.block, role: site.role, reaches });
    if (!reaches.length) unresolved.push({ name: site.name, line: site.line });
  }

  const names = [...grouped.keys()].sort();
  if (names.length > MAX_VARIABLES) truncated = true;
  const variables: DataflowVariable[] = names.slice(0, MAX_VARIABLES).map((name) => {
    const entry = grouped.get(name)!;
    const byLine = (left: { line: number }, right: { line: number }): number => left.line - right.line;
    return {
      name,
      defs: entry.defs.sort(byLine).map((site) => ({ line: site.line, block: site.block, role: site.role })),
      uses: entry.uses.sort(byLine).slice(0, MAX_USES).map((use) => ({ line: use.line, block: use.block, role: use.role, reaches: use.reaches }))
    };
  });
  return {
    symbolId: cfg.symbolId,
    name: cfg.name,
    startLine: cfg.startLine,
    endLine: cfg.endLine,
    variables,
    ...(unresolved.length ? { unresolved: unresolved.sort((left, right) => left.line - right.line).slice(0, MAX_USES) } : {}),
    ...(truncated ? { truncated: true } : {})
  };
}
