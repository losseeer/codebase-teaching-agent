import type { CallEdge, FlowEdge, FlowStage, RepositoryAnalysis, RepositoryFlow, SourceAnchor, SymbolInfo } from "@codebase-tutor/shared";

/**
  流程视图的「静态证据层」：从入口出发，沿 `analysis.graph.calls` 的**跨文件**跳展开一条调用链。

  两个用途，必须分清：
  1) 作为 LLM 生成流程的输入材料（把真实的跨文件调用顺序喂给模型，避免它凭空编排）；
  2) LLM 不可用时的降级视图——此时它是答案本身，不是半成品。

  它**自己不是**流程视图的最终形态：回调注册（`add_node("evaluate", evaluate)`）、反射、
  依赖注入这类编排不产生调用边，静态调用图看不见它们。这正是流程视图要交给 LLM 的原因。
 */

const MAX_EVIDENCE_STEPS = 24;
const MAX_EVIDENCE_DEPTH = 5;
const MAX_EVIDENCE_BRANCHES = 6;

export const FLOW_EVIDENCE_LIMITS = {
  maxDepth: MAX_EVIDENCE_DEPTH,
  maxBranchesPerStep: MAX_EVIDENCE_BRANCHES,
  maxSteps: MAX_EVIDENCE_STEPS
} as const;

export interface EvidenceStage {
  order: number;
  depth: number;
  kind: "entry" | "call";
  title: string;
  path: string;
  line: number;
  endLine?: number;
  /** 调用点：谁（函数）在哪一行发起了这次跳转 */
  from?: { title: string; path: string; line: number };
  /** 发起这次跳转的**环节序号**（边要按序号连，光有路径连不起来） */
  fromOrder?: number;
  /** 跨文件去重后的去向总数 */
  branches: number;
  /** 其中本次真正展开成新环节的数量 */
  expanded: number;
  /** 回边：该环节调用的、正好是它自己上游环节的序号（真正的环） */
  loops: number[];
  /** 复用：该环节调用的、已在链上前文出现过的环节序号（不是环，只是共享下游） */
  revisits: number[];
  /** 同文件内部调用数（只计数、不展开） */
  sameFileCalls: number;
  language?: SymbolInfo["language"];
}

export interface FlowEvidence {
  entry: SourceAnchor;
  stages: EvidenceStage[];
  /** 被深度/分支/步数上限截断：链上还有可达环节未展开 */
  truncated: boolean;
  /** 未展开的下游环节数 */
  omitted: number;
}

/** 路径 → 展示用短名（去掉目录与扩展名）。 */
function fileTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "") || base;
}

/**
  从入口按调用关系展开调用链。
  某一步的分支按「该去向自己还能展开出多长的链」排序、连续编号，各自的下游紧随其后，
  于是入口文件里那些收尾型调用（close、configure_logging 之类）不会把主线挤掉。
  纯函数、无 IO；数据不足时返回只有入口的骨架。
 */
export function buildFlowEvidence(
  analysis: RepositoryAnalysis,
  entry: SourceAnchor,
  limits: { maxDepth: number; maxBranchesPerStep: number; maxSteps: number } = FLOW_EVIDENCE_LIMITS
): FlowEvidence {
  const byId = new Map(analysis.graph.symbols.map((symbol) => [symbol.id, symbol]));
  const byCallerSymbol = new Map<string, CallEdge[]>();
  const byCallerPath = new Map<string, CallEdge[]>();
  const add = (map: Map<string, CallEdge[]>, key: string, call: CallEdge): void => {
    map.set(key, [...(map.get(key) ?? []), call]);
  };
  for (const call of analysis.graph.calls) {
    if (call.callerSymbol) add(byCallerSymbol, call.callerSymbol, call);
    add(byCallerPath, call.callerPath, call);
  }

  interface Cursor {
    key: string;
    title: string;
    path: string;
    line: number;
    endLine?: number;
    language?: SymbolInfo["language"];
    calls: CallEdge[];
  }
  interface Branch {
    cursor: Cursor;
    /** 调用点所在行 */
    line: number;
    /** 发起这次调用的函数名 */
    caller: string;
  }
  const cursorOfCall = (call: CallEdge): Cursor | undefined => {
    const symbol = call.calleeSymbol ? byId.get(call.calleeSymbol) : undefined;
    if (symbol) {
      return {
        key: `symbol:${symbol.id}`,
        title: symbol.name,
        path: symbol.path,
        line: symbol.line,
        endLine: symbol.endLine,
        language: symbol.language,
        calls: byCallerSymbol.get(symbol.id) ?? []
      };
    }
    // 符号表里没有：只在没有 calleeSymbol 时回落文件级；有 id 却查不到说明数据不全，不编造
    if (call.calleeSymbol) return undefined;
    return { key: `file:${call.calleePath}`, title: fileTitle(call.calleePath), path: call.calleePath, line: 1, calls: byCallerPath.get(call.calleePath) ?? [] };
  };

  /** 跨文件去向：同一目标只留首次调用，按 (路径, 行) 稳定排序保证同一份数据得到同一条链。 */
  const branchesOf = (cursor: Cursor): Branch[] => {
    const found = new Map<string, Branch>();
    const calls = [...cursor.calls].sort((left, right) => left.calleePath.localeCompare(right.calleePath) || left.line - right.line);
    for (const call of calls) {
      if (call.calleePath === cursor.path) continue;
      const target = cursorOfCall(call);
      if (!target || found.has(target.key)) continue;
      found.set(target.key, { cursor: target, line: call.line, caller: (call.callerSymbol ? byId.get(call.callerSymbol)?.name : undefined) ?? cursor.title });
    }
    return [...found.values()];
  };
  const sameFileCallsOf = (cursor: Cursor): number => cursor.calls.filter((call) => call.calleePath === cursor.path).length;

  /** 从该去向出发还能走多长的链（记忆化；环上返回 0，避免深度发散）。 */
  const depthCache = new Map<string, number>();
  const depthOf = (cursor: Cursor, seen: Set<string>): number => {
    const cached = depthCache.get(cursor.key);
    if (cached !== undefined) return cached;
    if (seen.has(cursor.key)) return 0;
    seen.add(cursor.key);
    const next = branchesOf(cursor);
    const value = next.length ? 1 + Math.max(...next.map((branch) => depthOf(branch.cursor, seen))) : 0;
    seen.delete(cursor.key);
    depthCache.set(cursor.key, value);
    return value;
  };

  // 入口按「文件」起步：一个入口文件里的每个函数都可能是流程的第一跳
  const entryCursor: Cursor = { key: `file:${entry.path}`, title: fileTitle(entry.path), path: entry.path, line: entry.line, calls: byCallerPath.get(entry.path) ?? [] };
  const stages: EvidenceStage[] = [{
    order: 1,
    depth: 0,
    kind: "entry",
    title: entryCursor.title,
    path: entryCursor.path,
    line: entryCursor.line,
    branches: 0,
    expanded: 0,
    loops: [],
    revisits: [],
    sameFileCalls: 0
  }];
  const orderOf = new Map<string, number>([[entryCursor.key, 1]]);
  let truncated = false;
  let omitted = 0;
  const stack: { cursor: Cursor; depth: number; stepIndex: number; chain: { key: string; order: number }[] }[] = [
    { cursor: entryCursor, depth: 0, stepIndex: 0, chain: [] }
  ];

  while (stack.length) {
    const item = stack.pop()!;
    const step = stages[item.stepIndex];
    const branches = branchesOf(item.cursor).sort((left, right) =>
      depthOf(right.cursor, new Set()) - depthOf(left.cursor, new Set())
      || left.cursor.path.localeCompare(right.cursor.path)
      || left.cursor.line - right.cursor.line);
    step.branches = branches.length;
    step.sameFileCalls = sameFileCallsOf(item.cursor);
    if (item.depth >= limits.maxDepth) {
      if (branches.length) { truncated = true; omitted += branches.length; }
      continue;
    }
    const chain = [...item.chain, { key: item.cursor.key, order: step.order }];
    const descending: typeof stack = [];
    for (const branch of branches) {
      const ancestor = chain.find((link) => link.key === branch.cursor.key);
      if (ancestor) {
        step.loops = [...new Set([...step.loops, ancestor.order])].sort((left, right) => left - right);
        continue;
      }
      const known = orderOf.get(branch.cursor.key);
      if (known !== undefined) {
        step.revisits = [...new Set([...step.revisits, known])].sort((left, right) => left - right);
        continue;
      }
      if (step.expanded >= limits.maxBranchesPerStep || stages.length >= limits.maxSteps) {
        truncated = true;
        omitted += 1;
        continue;
      }
      stages.push({
        order: stages.length + 1,
        depth: item.depth + 1,
        kind: "call",
        title: branch.cursor.title,
        path: branch.cursor.path,
        line: branch.cursor.line,
        endLine: branch.cursor.endLine,
        from: { title: branch.caller, path: item.cursor.path, line: branch.line },
        fromOrder: step.order,
        branches: 0,
        expanded: 0,
        loops: [],
        revisits: [],
        sameFileCalls: 0,
        language: branch.cursor.language
      });
      step.expanded += 1;
      orderOf.set(branch.cursor.key, stages.length);
      // 逆序入栈 → 优先级最高的分支先被展开
      descending.push({ cursor: branch.cursor, depth: item.depth + 1, stepIndex: stages.length - 1, chain });
    }
    for (let index = descending.length - 1; index >= 0; index -= 1) stack.push(descending[index]);
    if (step.expanded < step.branches) { truncated = true; omitted += step.branches - step.expanded; }
  }
  return { entry, stages, truncated, omitted };
}

const MAX_STAGE_TITLE = 14;

/**
  把静态证据直接渲染成流程（LLM 不可用时的降级视图）。
  降级必须显式：`reason` 会写进 `caveats`，界面在页脚原样展示——静默降级等于把静态链
  冒充成模型结论，读者无从知道它看不到回调注册这类编排。

  边也在这里产出：每个环节的 `fromOrder` 就是它的入边，`loops`/`revisits` 是真实的回边与共享去向，
  两者都是跨文件调用（`buildFlowEvidence` 只展开跨文件跳转），因此 `origin` 一律是 `static`。
*/
export function staticFlow(evidence: FlowEvidence, reason: string): RepositoryFlow {
  const stages: FlowStage[] = evidence.stages.map((step) => {
    const kind: FlowStage["kind"] = step.kind === "entry"
      ? "entry"
      : step.loops.length
        ? "loop"
        : step.branches > 1 ? "decision" : "stage";
    return {
      order: step.order,
      kind,
      title: [...step.title].slice(0, MAX_STAGE_TITLE).join(""),
      detail: step.from ? `由 ${step.from.title} 在 ${step.from.path}:${step.from.line} 调用；本次共 ${step.branches} 条跨文件去向。` : "流程起点。",
      files: [{ path: step.path, line: step.line, note: step.from ? `由 ${step.from.title} 调用` : "入口文件" }],
      branches: [],
      ...(step.loops.length ? { loopsTo: step.loops[0] } : {})
    };
  });
  const byOrder = new Map(evidence.stages.map((step) => [step.order, step]));
  const edgeOf = (from: number, to: number): FlowEdge | undefined => {
    const source = byOrder.get(from);
    const target = byOrder.get(to);
    if (!source || !target || from === to) return undefined;
    return { from, to, origin: "static", evidence: `${source.path}:${source.line} → ${target.path}:${target.line}` };
  };
  const edges: FlowEdge[] = [];
  const pushEdge = (edge: FlowEdge | undefined): void => {
    if (edge && !edges.some((item) => item.from === edge.from && item.to === edge.to)) edges.push(edge);
  };
  for (const step of evidence.stages) {
    if (step.fromOrder !== undefined) pushEdge(edgeOf(step.fromOrder, step.order));
    for (const loop of step.loops) pushEdge(edgeOf(step.order, loop));
    for (const revisit of step.revisits) pushEdge(edgeOf(step.order, revisit));
  }
  const caveats = [
    reason,
    `当前展示的是静态调用链（${evidence.stages.length} 个环节），同文件内部调用只计数不展开`,
    evidence.truncated ? `另有 ${evidence.omitted} 个去向未展开` : "",
    "回调注册、路由表、反射、依赖注入等编排不产生调用边，静态链看不到，因此环节可能比真实执行路径少"
  ].filter(Boolean).join("；");
  const uncovered = [
    "同文件内部调用未展开（只计数）",
    evidence.truncated ? `${evidence.omitted} 个跨文件去向因深度/分支/步数上限未展开` : "",
    "回调注册、路由表、依赖注入等编排在静态调用图上看不见"
  ].filter(Boolean);
  return {
    entry: evidence.entry,
    title: `${fileTitle(evidence.entry.path)} 调用链`,
    summary: `从 ${evidence.entry.path} 出发、按跨文件调用展开的 ${evidence.stages.length} 个环节。`,
    stages,
    edges,
    uncovered,
    caveats: `${caveats}。`,
    generatedAt: new Date().toISOString()
  };
}
