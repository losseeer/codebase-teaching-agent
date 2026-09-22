import type { FlowEdge, RepositoryAnalysis, RepositoryFlow, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { executeReadFile } from "../source/read-file.js";

/**
  按需深入：主调用之后，对**模型自认是推断的**那些去向做一次有界的核实。

 为什么需要这一步：流程视图存在的理由就是静态调用图看不见编排（`add_node("evaluate", evaluate)`、
  路由表、依赖注入）。这类结构**在代码正文里看得见、在调用图上没有边**——所以「依赖图证不出来」
  并不等于「代码里没有」。主调用没读正文（只有入口前 120 行），只能猜；这一步把那些文件的
  **真实片段**给它看，让它要么给出可核对的依据（`origin: "code"` + 文件:行），要么承认仍不确定。

  三条硬边界：
  1. **只读被问到的文件的窗口，起点由符号表给出**（不是随机读文件、不是整份正文）；
  2. 条数与文件数都有上限（`MAX_DEEP_EDGES` / `MAX_DEEP_FILES`）；窗口是给定的，**问哪几条边**
     按「文件被多少条推断边需要」加权选（09-22 修正：旧选择法按边迭代序拿前 3 个文件，一条流程的
     6 条推断边常涉及十几个文件，多数边根本没读到正文——提示词又规定「没给片段一律判 inferred」，
     等于注定白问）；窗口大小也按同一天的重放定：真仓 19 条 flow、136 条推断边，「端点全落窗口」
     （唯一问得出来的边）在 3 文件窗口下只有 1 条，放宽到 5 是 13 条——字符预算 `MAX_DEEP_CHARS`
     本来就只装得下 4~5 个 80 行窗口，3 是白留预算，5 是收在预算内；
  3. **核实失败不损失流程**：解析不出、调用失败、引用对不上，都保留原边并把情况写进 caveats。
*/

/** 一次最多核实几条推断边。 */
const MAX_DEEP_EDGES = 6;
/**
  一次最多读几个文件。读窗口才是这一步的成本大头，但真正的闸是下面的字符预算：
  80 行窗口 × 5 文件已贴近 16k 上界，6 个只是被字符闸悄悄裁掉——这里放宽到 5 不增加最坏成本。
*/
const MAX_DEEP_FILES = 5;
/** 每个窗口的行数：够看清一个函数与它周边十几行即可。 */
const DEEP_EXCERPT_LINES = 80;
/**
  所有窗口加起来的字符预算。行数上限管不住成本——`read_file` 的单次字闸是 12,000 字符，
  三个文件最坏能凑出三万多字符（≈9k token），比主调用还贵。这里按字符收口，保证这一步
  永远是「有界的小调用」。
*/
const MAX_DEEP_CHARS = 16_000;
/** 窗口从符号起始行往上多带几行，便于看到装饰器/注册语句。 */
const DEEP_LEAD_LINES = 5;
const DEEP_MAX_TOKENS = 900;
const DEEP_SCENE = "map.flow.deep";

const DEEP_SYSTEM_PROMPT = [
  "下面是一个代码仓库执行流程里若干条**待核实的去向**，以及这些去向涉及文件的真实源码片段（带行号）。",
  "请只依据给出的代码判断每一条：这条去向在代码里是否真的有依据（例如回调或节点注册、路由表、依赖注入、事件订阅、显式调用）。",
  '有依据写 verdict="code"，evidence 必须写清「文件路径:行」（路径照抄片段里给出的 path，至少写到能认出是哪个文件的后缀）并说明是什么结构（如 graph/builder.py:112 注册 evaluate 节点）。',
  '看不出来就写 verdict="inferred"，evidence 写一句为什么仍不确定。',
  "不要因为「通常这么写」就判有依据；只认代码里看得见的东西。没给出代码片段的文件，一律判 inferred。",
  '严格输出 JSON 数组：[{"from":1,"to":9,"verdict":"code|inferred","evidence":"…"}]，长度不超过输入条数。不要输出其他文字。'
].join("\n");

export interface DeepenResult {
  flow: RepositoryFlow;
  usage?: LlmUsage;
  /** 本次核实了几条推断边 */
  examined: number;
  /** 其中在代码里找到依据、升级为 `code` 的条数 */
  confirmed: number;
  /** 仍无法确认（含引用对不上被驳回）的条数 */
  stillInferred: number;
}

/** 解析核实结果，按 `from:to` 建索引；读不出就返回空表（调用方保持原状）。 */
export function parseDeepenReply(text: string): Map<string, { verdict: "code" | "inferred"; evidence: string }> {
  const results = new Map<string, { verdict: "code" | "inferred"; evidence: string }>();
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) return results;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return results;
  }
  if (!Array.isArray(parsed)) return results;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as { from?: unknown; to?: unknown; verdict?: unknown; evidence?: unknown };
    if (!Number.isInteger(record.from) || !Number.isInteger(record.to)) continue;
    const verdict = record.verdict === "code" || record.verdict === "inferred" ? record.verdict : undefined;
    const evidence = typeof record.evidence === "string" ? record.evidence.trim().replace(/\s+/g, " ") : "";
    if (!verdict || !evidence) continue;
    results.set(`${record.from}:${record.to}`, { verdict, evidence });
  }
  return results;
}

/**
  找到覆盖该行的符号，用它的**起始行**当窗口锚点——这就是「行区间由符号表给出」的落点。
  找不到就退回原行号（模型给的行业已经过范围校验）。
*/
function anchorLine(analysis: RepositoryAnalysis, path: string, line: number): number {
  const symbol = analysis.graph.symbols.find((item) => item.path === path && item.line <= line && item.endLine >= line);
  return symbol ? symbol.line : line;
}

export async function deepenInferredEdges(input: {
  repositoryPath: string;
  analysis: RepositoryAnalysis;
  index: RepositoryIndex;
  flow: RepositoryFlow;
  provider: LlmProvider;
}): Promise<DeepenResult> {
  const { flow } = input;
  const stageOf = (order: number) => flow.stages.find((stage) => stage.order === order);
  const inferred = flow.edges.filter((edge) => edge.origin === "inferred" && stageOf(edge.from) && stageOf(edge.to));
  if (!inferred.length) return { flow, examined: 0, confirmed: 0, stillInferred: 0 };
  const pathsOf = (edge: FlowEdge): string[] =>
    [...new Set([...stageOf(edge.from)!.files, ...stageOf(edge.to)!.files].map((file) => file.path))];

  // 选文件：按「被几条推断边需要」加权取前 MAX_DEEP_FILES 个窗口，锚点用这些边里该文件的最小符号起始行。
  // 同分按流程出现顺序（Map 插入序 + 稳定排序）。
  const score = new Map<string, { edges: number; anchor: number }>();
  for (const edge of inferred) {
    const entries = [...stageOf(edge.from)!.files, ...stageOf(edge.to)!.files];
    for (const path of new Set(entries.map((file) => file.path))) {
      const anchor = anchorLine(input.analysis, path, entries.find((file) => file.path === path)!.line);
      const row = score.get(path);
      if (row) { row.edges += 1; row.anchor = Math.min(row.anchor, anchor); }
      else score.set(path, { edges: 1, anchor });
    }
  }
  const wanted = new Map([...score].sort((a, b) => b[1].edges - a[1].edges).slice(0, MAX_DEEP_FILES).map(([path, row]) => [path, row.anchor]));
  const window = new Set(wanted.keys());
  // 问哪些边：端点在窗口里的才问得到（没读到的片段按提示词一律判 inferred，问了注定白问）；全覆盖优先，截到 MAX_DEEP_EDGES。
  const askable = inferred.filter((edge) => pathsOf(edge).some((path) => window.has(path)));
  const pending = askable
    .map((edge) => ({ edge, full: pathsOf(edge).every((path) => window.has(path)) }))
    .sort((a, b) => Number(b.full) - Number(a.full))
    .slice(0, MAX_DEEP_EDGES)
    .map((item) => item.edge);
  const skipped = inferred.length - pending.length;
  if (!pending.length) {
    return { flow: { ...flow, caveats: joinCaveat(flow.caveats, `按需深入未执行：${inferred.length} 条推断边的端点文件都没落进 ${MAX_DEEP_FILES} 个阅读窗口`) }, examined: 0, confirmed: 0, stillInferred: 0 };
  }
  const excerpts: { path: string; from: number; to: number; content: string }[] = [];
  let usedChars = 0;
  for (const [path, anchor] of wanted) {
    const offset = Math.max(1, anchor - DEEP_LEAD_LINES);
    const read = executeReadFile(input.repositoryPath, JSON.stringify({ path, offset, limit: DEEP_EXCERPT_LINES }));
    if (read.audit.denied) continue;
    // 预算之外就不再读：宁可少核实一条，也不让这一步变成没上限的调用
    if (excerpts.length && usedChars + read.content.length > MAX_DEEP_CHARS) continue;
    usedChars += read.content.length;
    excerpts.push({ path, from: offset, to: offset + (read.audit.lines ?? 0) - 1, content: read.content });
  }

  const requested = pending.map((edge) => {
    const from = stageOf(edge.from)!;
    const to = stageOf(edge.to)!;
    return {
      from: edge.from,
      to: edge.to,
      fromStage: { title: from.title, detail: from.detail, files: from.files.map((file) => `${file.path}:${file.line}`) },
      toStage: { title: to.title, detail: to.detail, files: to.files.map((file) => `${file.path}:${file.line}`) }
    };
  });
  if (!excerpts.length) {
    // 一个窗口都读不出来（护栏拒绝/文件不在磁盘）：不下这次调用，如实说明
    return { flow: { ...flow, caveats: joinCaveat(flow.caveats, `按需深入未执行：${pending.length} 条推断边涉及的代码片段都读不到`) }, examined: 0, confirmed: 0, stillInferred: 0 };
  }

  let usage: LlmUsage | undefined;
  let revised: Map<string, { verdict: "code" | "inferred"; evidence: string }>;
  try {
    const response = await input.provider.complete({
      system: DEEP_SYSTEM_PROMPT,
      user: JSON.stringify({ edges: requested, code: excerpts }),
      maxTokens: DEEP_MAX_TOKENS,
      temperature: 0,
      scene: DEEP_SCENE
    });
    usage = response.usage;
    revised = parseDeepenReply(response.text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { flow: { ...flow, caveats: joinCaveat(flow.caveats, `按需深入调用失败（${reason}），${pending.length} 条推断边保持原样`) }, examined: 0, confirmed: 0, stillInferred: 0 };
  }

  let confirmed = 0;
  let rejected = 0;
  let answered = 0;
  const edges: FlowEdge[] = flow.edges.map((edge) => {
    const verdict = revised.get(`${edge.from}:${edge.to}`);
    if (!verdict) return edge;
    answered += 1;
    if (verdict.verdict === "inferred") return { ...edge, evidence: verdict.evidence };
    // 「在代码里读到」必须引到这条边自己的文件上：引一个不相干的文件不算依据
    const owned = [...new Set([...(stageOf(edge.from)?.files ?? []), ...(stageOf(edge.to)?.files ?? [])].map((file) => file.path))];
    if (!citesOwnedFile(verdict.evidence, owned)) {
      rejected += 1;
      return edge;
    }
    confirmed += 1;
    return { ...edge, origin: "code", evidence: verdict.evidence };
  });

  const notes = [
    `按需深入：核对了 ${pending.length} 条推断边`,
    answered ? `其中 ${confirmed} 条在代码里找到依据（已标为 code）` : "模型没有给出结论",
    rejected ? `${rejected} 条因引用的文件不属于该边被驳回` : "",
    answered && confirmed + rejected < answered ? `${answered - confirmed - rejected} 条仍不确定` : "",
    skipped ? `${skipped} 条因端点文件不在本次阅读窗口内未送核实` : ""
  ].filter(Boolean);
  return {
    flow: { ...flow, edges, caveats: joinCaveat(flow.caveats, notes.join("，")) },
    ...(usage ? { usage } : {}),
    examined: answered,
    confirmed,
    stillInferred: answered - confirmed
  };
}

/**
  依据文本里是否引用了这条边自己的文件。

  真仓重放（09-22）：19 条 code 判定被驳回 18 条——全因旧匹配要求 evidence 里出现**完整路径**，
  而模型按提示只写了裸文件名（`nodes.py:4` 而非 `src/main/java/com/hmdp/graph/nodes.py:4`）。
  现在允许「完整路径 / 目录后缀 / 裸文件名」，但必须**整段相等**：`IShopServiceImpl.java`
  不能冒充 `ShopServiceImpl.java`，`core/redis.py` 依然对不上任何一端。
*/
function citesOwnedFile(evidence: string, ownedPaths: string[]): boolean {
  for (const match of evidence.matchAll(/[\w./\\-]+\.[A-Za-z0-9]+/g)) {
    const token = match[0].replace(/\\/g, "/");
    if (ownedPaths.some((path) => path === token || path.endsWith(`/${token}`))) return true;
  }
  return false;
}

function joinCaveat(current: string | undefined, extra: string): string {
  return current ? `${current}；${extra}` : extra;
}
