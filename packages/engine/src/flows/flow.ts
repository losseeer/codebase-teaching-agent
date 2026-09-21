import {
  FLOW_MAX_STAGES,
  type DependencyGraphData,
  type FileEntry,
  type FileRole,
  type FileTreeNode,
  type FlowEdge,
  type FlowStage,
  type FlowStageFile,
  type FlowStageKind,
  type Hotspot,
  type RepositoryAnalysis,
  type RepositoryFlow,
  type RepositoryFlowResult,
  type RepositoryIndex,
  type SourceAnchor
} from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { addUsage } from "../llm/usage.js";
import type { TutorDatabase } from "../store/database.js";
import { classifyFileRoles, roleOf } from "../depgraph/roles.js";
import { rankSymbolsByCalls } from "../depgraph/symbol-rank.js";
import { layerCacheKey } from "../lib.js";
import { executeReadFile } from "../source/read-file.js";
import { deepenInferredEdges } from "./deepen.js";
import { buildFlowEvidence, staticFlow } from "./evidence.js";

/**
  流程视图的服务端（宏观设计 · 流程视图）：

  流程由 LLM 生成，而不是直接把静态调用链画出来。理由是静态调用图看不见**编排**——
  `add_node("evaluate", evaluate)`、路由表、插件注册、依赖注入都不会产生调用边，
  于是真正的主干（如 LangGraph 的 evaluate → improve → 回环）在静态链上是断的。
  模型可以从文件、符号与依赖语义里读出这类结构，这是流程视图相对架构视图的增量。

  静态调用链没有被丢掉，它做两件事：作为 LLM 的输入证据（真实的跨文件调用顺序），
  以及 LLM 不可用时的降级视图（显式标注，不冒充模型结论）。

  与 `coursetree/entry-suggest.ts` 同一套约定：失败不抛给调用方，返回降级结果 + 原因；
  缓存只存**可信答案**——成功结果与确定性降级（模型给不出更多了，见 `GeneratedFlow.deterministic`），
  瞬时失败（调用异常 / 内容解析不出）不固化，下次访问仍重试。
 */

const MAX_DIGEST_FILES = 60;
const MAX_SYMBOLS_PER_FILE = 8;
const MAX_IMPORTS_PER_FILE = 8;
const MAX_CALL_CHAIN = 24;
const ENTRY_EXCERPT_LINES = 120;
/** 目录骨架用的行数上限：全量文件的目录树在大型仓库会失控，超出即截断并显式告知模型。 */
const MAX_TREE_LINES = 200;
/** 热点只给最靠前的若干个：完整列表是索引内部数据，喂给模型的是「哪里最常被改动」这个信号。 */
const MAX_HOTSPOTS = 15;
const MAX_TITLE = 18;
const MAX_SUMMARY = 100;
const MAX_STAGE_TITLE = 14;
/** 环节说明进的是详情抽屉（可滚动），不是画布卡片；提示词已要求一句话简要描述，这里是防御性硬上限。 */
const MAX_STAGE_DETAIL = 160;
const MAX_STAGE_FILES = 3;
const MAX_FILE_NOTE = 40;
const MAX_BRANCHES = 4;
const MAX_BRANCH_TEXT = 60;
const MAX_CAVEATS = 240;
/** 环节数上限 12，边比环节多不了太多；给点余量，多出来的会在校验时丢弃并计数。 */
const MAX_EDGES = 24;
const MAX_EDGE_EVIDENCE = 60;
const MAX_UNCOVERED = 6;
const MAX_UNCOVERED_TEXT = 40;
/** 环节被丢弃到低于该数量就不再算「一条流程」，回落静态视图。 */
const MIN_STAGES = 3;
const FALLBACK_UNPARSEABLE = "模型返回的内容无法解析成一条完整流程";
const FALLBACK_UNGROUNDED = "模型给出的环节缺少仓内代码落点";
const FALLBACK_DIGEST_FAILED = "流程输入组装失败，已回落静态调用链";

/**
  流程层的输入口径版本，进缓存键。`buildFlowDigest` 的形状、上面各 `MAX_*` 裁剪阈值、或
  `SYSTEM_PROMPT` 的文本改了，模型看到的输入可以一字不变——这类失效只有版本号管得了，改它们要同步 bump。
  */
const FLOW_INPUT_VERSION = "digest-v3";

/** 与 buildFlowDigest 配套的流程生成系统提示词；导出供探针/测试复用（改提示词时同步看 flow.test.ts）。 */
export const SYSTEM_PROMPT = [
  "你是代码教学产品的架构讲解者。给定一个仓库的执行入口、文件清单（含符号名与依赖）与静态调用链证据，",
  "输出「一次执行从入口到结束经过哪些环节」。",
  "硬性要求：",
  "1. 环节按真实执行顺序排列，覆盖静态调用链看不到的**编排**（回调/节点注册、路由表、插件与依赖注入、事件订阅）——这是本次任务的重点，不要只把调用链誊一遍。",
  "2. 每个环节关联 1~3 个**清单里确实存在**的文件路径，并给出该文件在这个环节里的作用；给不出真实路径就不要写这一项，路径编错会导致整个环节被丢弃。",
  `3. 环节数 ${MIN_STAGES}~${FLOW_MAX_STAGES} 个。第 1 个环节必须是入口。`,
  "4. kind 取值：entry（入口）、stage（普通环节）、decision（有条件分支，用 branches 写清判断依据与去向）、loop（回到更早环节，用 loopsTo 写目标序号）、exit（结束/产出）。",
  "5. 只描述代码能支持的内容，不编造模块名或函数名；把握不准的地方写进 caveats。",
  `6. edges 是环节之间的去向，每条必须有 from/to（环节序号，1 起）、origin 与 evidence。origin=static 表示「依赖图上真的有这条路」（两个环节的文件之间存在 import 或跨文件调用），evidence 写「文件:行 → 文件:行」；origin=inferred 表示「代码里读不出、是你按编排语义推断的」（回调或节点注册、路由表、依赖注入、事件订阅），evidence 写一句依据。`,
  `   注意：主调用**不会**给你那些文件的完整代码（只有入口前若干行），所以本次 origin 只能写 static 或 inferred——声称「在源码里读到」会被改标为推断；code 是后续核实环节读过正文之后才能给的标记。branches 仍用于分叉的文字说明，回环除了 loopsTo 也应在 edges 里有一条从后向前的回边。`,
  `7. uncovered 必填：列出你这次没能确认的部分（怀疑参与但证据不足的文件、看不清的分支），每条 ≤${MAX_UNCOVERED_TEXT} 字；确实没有就填空数组。`,
  "8. detail 只做简要描述：一句话讲清该环节**做什么**即止，不要展开函数名、字段、参数或实现步骤——看细节是点开环节之后的事，展开只会把卡片和抽屉撑爆。",
  "证据字段说明：files 是参与执行的文件详表（含符号名、依赖方向与角色 role，role 取值 core=执行主干 / infra=配置存储日志网络等设施接入 / support=支撑逻辑 / tool=末端工具 / test=测试）；带 summary 的文件有一条**已确认**的一句话职责，没有 summary 的文件即职责未确认——`withheldSummaries` 说明其中有多少条摘要因覆盖不足被隐去，别把它们当已知事实；directoryTree 是全部被索引文件的目录骨架，目录后的 (N) 是该目录下被索引的文件数，用来看详表之外还有什么；hotspots 是 git 改动次数最多的文件，改动频繁处通常承载主流程；callChain 是静态跨文件调用链（对回调注册这类编排是盲的，不要照抄）。",
  `严格输出 JSON：{"title":"≤${MAX_TITLE}字","summary":"≤${MAX_SUMMARY}字",`,
  `"stages":[{"title":"≤${MAX_STAGE_TITLE}字","detail":"一句话简要说明、≤${MAX_STAGE_DETAIL}字","kind":"entry|stage|decision|loop|exit",`,
  `"files":[{"path":"清单中的路径","line":1,"note":"≤${MAX_FILE_NOTE}字"}],"branches":["≤${MAX_BRANCH_TEXT}字"],"loopsTo":1}],`,
  `"edges":[{"from":1,"to":2,"origin":"static|inferred","evidence":"≤${MAX_EDGE_EVIDENCE}字"}],`,
  `"uncovered":["≤${MAX_UNCOVERED_TEXT}字"],`,
  `"caveats":"≤${MAX_CAVEATS}字，说明不确定处或已知遗漏"}。`,
  "不要输出 JSON 以外的任何文字。"
].join("");

export interface FlowDigestFile {
  path: string;
  lines: number;
  symbols: string[];
  imports: string[];
  importedBy: number;
  /** 结构角色（core 主干 / infra 设施 / support 支撑 / tool 末端 / test 测试），与摘要表同一套分类。 */
  role: FileRole;
  /**
    该文件的**已确认**一句话职责（来自 L1 摘要表）。覆盖不足的摘要**不会**出现在这里——
    摘要不可信就当没有，别把猜测喂进去当事实（有多少条被隐去由 `withheldSummaries` 说明）。
  */
  summary?: string;
}

/** L1 摘要表在流程证据里的投影：只需要「一句话职责」和「它可不可信」。 */
export interface FlowDigestSummary {
  summary: string;
  coverageLow?: boolean;
}

export interface FlowDigest {
  entry: { path: string; label: string };
  entryExcerpt?: string;
  files: FlowDigestFile[];
  /** 被截断的文件总数（清单未含全部文件时告知模型） */
  omittedFiles: number;
  /** 静态跨文件调用链：入口 → … 的紧凑序列 */
  callChain: string[];
  /** 静态链是否被展开上限截断 */
  callChainTruncated: boolean;
  /** 全部被索引文件的目录骨架；目录行为 `name/ (N)`，N 是该目录下被索引文件数 */
  directoryTree: string[];
  /** 目录骨架是否被行数上限截断 */
  directoryTreeTruncated: boolean;
  /** git 改动热点；**已过滤到被索引的文件**，避免模型引用一个不在索引里的路径 */
  hotspots: Hotspot[];
  /** 有多少个文件的摘要因**覆盖不足**被隐去（那些文件的职责未确认，别当已知事实用） */
  withheldSummaries: number;
}

/**
  构造喂给模型的证据。证据只含「模型推不出、但必须知道」的事实：
  真实路径、符号名、依赖方向、静态调用顺序。刻意不放源码全文——那会把成本推高一个量级，
  而流程编排靠符号名与文件名已经能读出来。

  ⚠️ 字段顺序即前缀缓存成本：`entry` 与 `entryExcerpt` 随入口变，所以**新增段一律追加在末尾**，
  别往中间插（会让其后全部失效）；`files` 的排序是全仓维度、不随入口变，改动它同样会破缓存。
 */
export function buildFlowDigest(
  repositoryPath: string,
  index: RepositoryIndex,
  analysis: RepositoryAnalysis,
  entry: SourceAnchor,
  summaries: Map<string, FlowDigestSummary>
): FlowDigest {
  const inDegree = new Map<string, number>();
  for (const targets of Object.values(analysis.graph.imports)) {
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }
  const ranked = rankSymbolsByCalls(analysis.graph.symbols, analysis.graph.calls, [entry.path], MAX_SYMBOLS_PER_FILE);
  const symbolsByPath = new Map<string, string[]>([...ranked].map(([path, list]) => [path, list.map((symbol) => symbol.name)]));
  // 角色按结构判（不依赖有没有配模型），因此同一份仓库任何时候算出的角色都一样
  const roles = classifyFileRoles({
    files: index.files,
    symbols: analysis.graph.symbols,
    calls: analysis.graph.calls,
    imports: analysis.graph.imports,
    entrypoints: analysis.graph.entrypoints
  });

  // 有依赖边或有符号的文件才进清单：流程视图关心的是「谁参与执行」，不是全量文件清单
  const candidates = index.files
    .map((file) => {
      const known = summaries.get(file.path);
      return {
        path: file.path,
        lines: file.lines,
        symbols: symbolsByPath.get(file.path) ?? [],
        imports: (analysis.graph.imports[file.path] ?? []).slice(0, MAX_IMPORTS_PER_FILE),
        importedBy: inDegree.get(file.path) ?? 0,
        role: roleOf(roles, file.path),
        // 摘要只放**已确认**的：覆盖不足等于这条摘要不可信，宁可缺字段也不把它当事实喂进去
        ...(known && !known.coverageLow ? { summary: known.summary } : {})
      };
    })
    .filter((file) => file.path === entry.path || file.imports.length || file.importedBy > 0 || file.symbols.length)
    .sort((left, right) =>
      Number(right.path === entry.path) - Number(left.path === entry.path)
      || right.importedBy - left.importedBy
      || right.lines - left.lines
      || left.path.localeCompare(right.path));
  const files = candidates.slice(0, MAX_DIGEST_FILES);

  const evidence = buildFlowEvidence(analysis, entry);
  const callChain = evidence.stages.map((stage) => `${stage.path}:${stage.title}${stage.kind === "entry" ? "（入口）" : ""}`);

  // 入口文件的真实内容：让模型知道入口到底做了什么，而不是从文件名猜
  const read = executeReadFile(repositoryPath, JSON.stringify({ path: entry.path, offset: 1, limit: ENTRY_EXCERPT_LINES }));
  const entryExcerpt = read.audit.denied ? undefined : read.content;

  const tree = renderDirectoryTree(index.fileTree, MAX_TREE_LINES);
  // 热点可能落在未索引的文件上（gitHotspots 只按 .tutorignore 过滤、不看扩展名），
  // 而 parseFlow 会把「不在索引里的路径」当编造丢弃——先把这类路径剔掉，免得模型白白踩坑。
  const indexedPaths = new Set(index.files.map((file) => file.path));
  const hotspots = index.hotspots.filter((hotspot) => indexedPaths.has(hotspot.path)).slice(0, MAX_HOTSPOTS);

  return {
    entry: { path: entry.path, label: entry.label },
    ...(entryExcerpt ? { entryExcerpt } : {}),
    files,
    omittedFiles: candidates.length - files.length,
    callChain: callChain.slice(0, MAX_CALL_CHAIN),
    callChainTruncated: evidence.truncated || callChain.length > MAX_CALL_CHAIN,
    directoryTree: tree.lines,
    directoryTreeTruncated: tree.truncated,
    hotspots,
    withheldSummaries: files.filter((file) => summaries.get(file.path)?.coverageLow).length
  };
}

/** 目录骨架：只列目录与被索引文件，目录行附该目录下被索引文件数。超出 maxLines 即截断并标记。 */
function renderDirectoryTree(nodes: FileTreeNode[], maxLines: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  const walk = (list: FileTreeNode[], depth: number): void => {
    for (const node of list) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      lines.push(`${"  ".repeat(depth)}${node.name}${node.kind === "directory" ? `/ (${countIndexedFiles(node)})` : ""}`);
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return { lines, truncated };
}

function countIndexedFiles(node: FileTreeNode): number {
  if (node.kind === "file") return 1;
  return (node.children ?? []).reduce((sum, child) => sum + countIndexedFiles(child), 0);
}

export interface GenerateFlowInput {
  repositoryPath: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
  entry: SourceAnchor;
  provider: LlmProvider;
  /** L1 摘要表（按路径索引）；缺某个文件就是「该文件职责未确认」。 */
  summaries: Map<string, FlowDigestSummary>;
  /** 持久层（`layer_cache` 表）。缺省时只走内存缓存——测试与降级路径不落盘。 */
  database?: TutorDatabase;
}

export interface GeneratedFlow extends RepositoryFlowResult {
  usage?: LlmUsage;
  /**
    降级是否为**确定性结论**：模型返回了合法 JSON、但环节在仓内没有代码落点——同一输入再跑一次
    模型给的答案一样，所以与成功结果一样可入缓存（与推荐入口的 `declined` 同一套口径）；
    调用异常、内容解析不出这类瞬时失败不带此标记，不入缓存。
  */
  deterministic?: boolean;
}

/** 生成一条流程。任何失败（调用异常 / JSON 不合法 / 校验后环节落点不足）都回落静态调用链，并带上原因。 */
export async function generateRepositoryFlow(input: GenerateFlowInput): Promise<GeneratedFlow> {
  const digest = tryBuildFlowDigest(input);
  if (!digest) return degradedFlow(input.analysis, input.entry, FALLBACK_DIGEST_FAILED);
  return generateFromDigest(input, digest);
}

/** 组装本层输入（= 真正发给模型的 user 消息）。失败返回 undefined，由调用方降级——它不该抛给路由。 */
function tryBuildFlowDigest(input: GenerateFlowInput): FlowDigest | undefined {
  try {
    return buildFlowDigest(input.repositoryPath, input.index, input.analysis, input.entry, input.summaries);
  } catch (error) {
    console.error("[flows] 流程输入组装失败:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** 用**已算好的**输入摘要生成一条流程：digest 既是发给模型的内容，也是缓存键的哈希对象。 */
async function generateFromDigest(input: GenerateFlowInput, digest: FlowDigest): Promise<GeneratedFlow> {
  const evidence = buildFlowEvidence(input.analysis, input.entry);
  try {
    const response = await input.provider.complete({
      system: SYSTEM_PROMPT,
      user: JSON.stringify(digest),
      maxTokens: 3_200,
      temperature: 0.2,
      scene: "map.flow"
    });
    const parsed = parseFlowOutcome(response.text, {
      entry: input.entry,
      availablePaths: new Set(input.index.files.map((file) => file.path)),
      linesOf: new Map(input.index.files.map((file) => [file.path, file.lines])),
      areRelated: buildRelatedPairs(input.analysis)
    });
    if ("failure" in parsed) {
      // 失败分两种（同推荐入口 declined 的口径）：合法 JSON 但环节没有落点 = 模型已经尽力了，是确定性结论，
      // 带 deterministic 入缓存，别每次访问都重烧一遍钱；内容解析不出按瞬时异常处理，不缓存、下次重试。
      const deterministic = parsed.failure === "ungrounded";
      const reason = deterministic ? FALLBACK_UNGROUNDED : FALLBACK_UNPARSEABLE;
      return {
        flow: staticFlow(evidence, reason),
        source: "static",
        reason,
        ...(deterministic ? { deterministic: true } : {}),
        usage: response.usage
      };
    }
    // 按需深入：只对模型自认是推断的去向、有界地读一次代码正文。
    // 没有推断边就一条调用都不发生；这一步失败也只损失 caveats 一行，不会丢掉主调用的结果。
    const deepened = await deepenInferredEdges({
      repositoryPath: input.repositoryPath,
      analysis: input.analysis,
      index: input.index,
      flow: parsed.flow,
      provider: input.provider
    });
    return { flow: deepened.flow, source: "llm", usage: addUsage(response.usage, deepened.usage) };
  } catch (error) {
    const reason = `流程生成调用失败（${error instanceof Error ? error.message : String(error)}）`;
    console.error("[flows] LLM 调用失败，回落静态调用链:", reason);
    return { flow: staticFlow(evidence, reason), source: "static", reason };
  }
}

/** 用量相加的唯一实现在 `llm/usage.ts`；此处转出是为兼容既有按本模块导入的探针与测试。 */
export { addUsage };

interface ParseContext {
  entry: SourceAnchor;
  availablePaths: Set<string>;
  linesOf: Map<string, number>;
  /** 两个文件在依赖图上有没有真实关系（import 边或跨文件调用边，任一方向；同一文件视为有关系）。 */
  areRelated: (leftPath: string, rightPath: string) => boolean;
}

/**
  依赖图的「有关系」判据。边级校验靠它把「声称来自代码」的边验一遍——
  双向都塞进集合，查起来才是 O(1)。
*/
export function buildRelatedPairs(analysis: RepositoryAnalysis): (leftPath: string, rightPath: string) => boolean {
  const pairs = new Set<string>();
  const link = (left: string, right: string): void => {
    if (left !== right) pairs.add(`${left}\u0000${right}`);
  };
  for (const [from, targets] of Object.entries(analysis.graph.imports)) {
    for (const to of targets) {
      link(from, to);
      link(to, from);
    }
  }
  for (const call of analysis.graph.calls) {
    link(call.callerPath, call.calleePath);
    link(call.calleePath, call.callerPath);
  }
  return (left, right) => left === right || pairs.has(`${left}\u0000${right}`);
}

/** 两个环节之间是否存在真实的文件级依赖（任一文件对命中即可）。 */
function stagesRelated(left: FlowStage, right: FlowStage, areRelated: ParseContext["areRelated"]): boolean {
  return left.files.some((one) => right.files.some((other) => areRelated(one.path, other.path)));
}

/**
  校验失败的两种原因，口径与推荐入口的 `declined` 一致：
  - `ungrounded`：响应是合法 JSON、`stages` 也是数组，但落到仓内代码的环节不足——模型对这份输入
    能给的就是这些，是**确定性结论**，可以让降级结果进缓存。
  - `unparseable`：连一个 JSON 对象都提不出来（或没有 stages 数组），按坏输出/瞬时异常处理，不缓存。
*/
type FlowParseFailure = "ungrounded" | "unparseable";

type FlowParseOutcome = { flow: RepositoryFlow } | { failure: FlowParseFailure };

/** 把模型输出校验成 `RepositoryFlow`：路径必须真实、行号必须落在文件范围内、序号与回环重排一致。 */
export function parseFlow(text: string, context: ParseContext): RepositoryFlow | null {
  const outcome = parseFlowOutcome(text, context);
  return "flow" in outcome ? outcome.flow : null;
}

function parseFlowOutcome(text: string, context: ParseContext): FlowParseOutcome {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return { failure: "unparseable" };
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return { failure: "unparseable" };
  }
  if (!raw || typeof raw !== "object") return { failure: "unparseable" };
  const record = raw as Record<string, unknown>;

  const droppedFiles = { count: 0 };
  // 行号越界不再静默收缩：模型给的行号若不在文件范围内会被改到范围内，**并在这里记账**，
  // 最终写进 caveats。这些行号只说明「大概在这个文件里」，不能当精确定位读。
  const clampedLines = { count: 0 };
  // 序号以模型输出数组的位置为准（1 起）：提示词已要求「按真实执行顺序排列」，数组顺序比模型自填的
  // order 字段可靠——自填序号一旦跳号，回环目标就会整体错位。
  const kept = (Array.isArray(record.stages) ? record.stages : [])
    .slice(0, FLOW_MAX_STAGES)
    .map((item, index) => normalizeStage(item, context, droppedFiles, clampedLines, index + 1))
    .filter((stage): stage is NormalizedStage => stage !== null);
  // 路径全部编造的环节直接丢弃：宁可少一个环节，也不给一个指不到代码的环节。
  // 给过 stages 数组却落不到 3 个环节 = 模型的确定性结论（ungrounded）；压根没给数组 = 坏输出（unparseable）。
  if (kept.length < MIN_STAGES) return { failure: Array.isArray(record.stages) ? "ungrounded" : "unparseable" };

  const orderMap = new Map<number, number>();
  kept.forEach((stage, index) => orderMap.set(stage.sourceOrder, index + 1));
  const stages: FlowStage[] = kept.map((stage, index) => {
    const order = index + 1;
    const kind: FlowStageKind = order === 1 ? "entry" : stage.kind === "entry" ? "stage" : stage.kind;
    const target = stage.loopsTo !== undefined ? orderMap.get(stage.loopsTo) : undefined;
    // 回环只能指向更靠前的环节；指向自己或未来环节不是回环，是数据错误
    const loopsTo = target !== undefined && target < order ? target : undefined;
    return {
      order,
      kind,
      title: stage.title,
      detail: stage.detail,
      files: stage.files,
      branches: stage.branches,
      ...(loopsTo !== undefined ? { loopsTo } : {})
    };
  });

  const droppedStages = (Array.isArray(record.stages) ? record.stages.length : 0) - kept.length;
  const edgeStats = { dropped: 0, downgradedStatic: 0, demotedCode: 0 };
  const edges = normalizeEdges(record.edges, stages, context, edgeStats, orderMap);
  const uncovered = (Array.isArray(record.uncovered) ? record.uncovered : [])
    .map((item) => asText(item, MAX_UNCOVERED_TEXT))
    .filter(Boolean)
    .slice(0, MAX_UNCOVERED);
  const notes = [
    asText(record.caveats, MAX_CAVEATS),
    droppedStages > 0 ? `有 ${droppedStages} 个环节因未给出存在的文件路径被丢弃` : "",
    droppedFiles.count > 0 ? `有 ${droppedFiles.count} 个文件路径不在仓库中，已剔除` : "",
    clampedLines.count > 0 ? `有 ${clampedLines.count} 个文件的行号超出该文件行数，已改到范围内；这些行号只说明位置在该文件内，不能当精确定位` : "",
    edgeStats.dropped > 0 ? `有 ${edgeStats.dropped} 条边因端点或依据不合格被丢弃` : "",
    edgeStats.downgradedStatic > 0 ? `有 ${edgeStats.downgradedStatic} 条边声称来自代码但与依赖图对不上，已改标为推断` : "",
    edgeStats.demotedCode > 0 ? `有 ${edgeStats.demotedCode} 条边声称「在源码里读到」，但本次并没有读过那些文件，已改标为推断` : "",
    Array.isArray(record.uncovered) ? "" : "模型没有给出未覆盖清单"
  ].filter(Boolean);

  return {
    flow: {
      entry: context.entry,
      title: asText(record.title, MAX_TITLE) || `${context.entry.path} 的执行流程`,
      summary: asText(record.summary, MAX_SUMMARY),
      stages,
      edges,
      ...(uncovered.length ? { uncovered } : {}),
      ...(notes.length ? { caveats: notes.join("；") } : {}),
      generatedAt: new Date().toISOString()
    }
  };
}

/**
  `/flow` 的入口解析：**推断入口优先，人工指定兜底**。
  入口识别（`detectEntrypoints`）是启发式——package.json 清单 + 约定文件名——裸脚本、
  非常规布局的仓会一无所获；这时允许把任意**已索引文件**当作流程起点（GUI 的「自定义入口」）。
  指定的路径不在索引里返回 undefined（调用方 404），不猜。

  不带路径时优先选**有仓内证据**的入口（传 `graph` 才启用，GUI 用同一口径）：
  Spring 启动类排在他的识别清单最前，但它的 import 全指向框架，静态证据凑不出一条流程、
  必然降级；控制器这类入口有真实依赖边，默认选它，全体都没边时才回落第一个。
  */
export function resolveFlowEntry(
  wanted: string,
  entrypoints: SourceAnchor[],
  files: FileEntry[],
  graph?: Pick<DependencyGraphData, "imports" | "calls">
): SourceAnchor | undefined {
  const path = wanted.trim();
  if (path) {
    const detected = entrypoints.find((item) => item.path === path);
    if (detected) return detected;
    return files.some((file) => file.path === path) ? { path, line: 1, label: "手动指定" } : undefined;
  }
  if (!graph) return entrypoints[0];
  const linked = new Set<string>();
  for (const [from, targets] of Object.entries(graph.imports)) {
    // 只有出现在**边**上才算证据：序列化的 imports 里每个已分析文件都是键（真仓 172 键、89 个空数组），
    // 无条件 `linked.add(from)` 会让全体入口入围，启动类以 entrypoints[0] 溜回默认——2026-09-21 journal 实查。
    if (targets.length) linked.add(from);
    for (const target of targets) linked.add(target);
  }
  for (const call of graph.calls) {
    linked.add(call.callerPath);
    linked.add(call.calleePath);
  }
  return entrypoints.find((item) => linked.has(item.path)) ?? entrypoints[0];
}

/**
  边的校验。三件事：
  1. 端点必须是**保留下来的**环节（模型给的是它自己的数组序号，被丢弃的环节会让序号整体前移，
     因此要经 `orderMap` 换算）；依据与 origin 必填——空依据的边等于没有依据。
  2. **声称 `static` 的边要由依赖图证明**：两个环节的文件之间必须真有 import 或跨文件调用。
     证不出来就**降级为 `inferred`**，不删边：删边会篡改拓扑，降级保真度更高。
  3. 去重、按上限截断，并如实记下丢了几条、降级了几条（进 caveats，不静默）。
*/
function normalizeEdges(
  value: unknown,
  stages: FlowStage[],
  context: ParseContext,
  stats: { dropped: number; downgradedStatic: number; demotedCode: number },
  orderMap: Map<number, number>
): FlowEdge[] {
  const candidates = Array.isArray(value) ? value : [];
  if (candidates.length > MAX_EDGES) stats.dropped += candidates.length - MAX_EDGES;
  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, MAX_EDGES)) {
    if (!candidate || typeof candidate !== "object") {
      stats.dropped += 1;
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const from = Number.isInteger(record.from) ? orderMap.get(Number(record.from)) : undefined;
    const to = Number.isInteger(record.to) ? orderMap.get(Number(record.to)) : undefined;
    const evidence = asText(record.evidence, MAX_EDGE_EVIDENCE);
    const origin = record.origin === "static" || record.origin === "code" || record.origin === "inferred" ? record.origin : undefined;
    if (from === undefined || to === undefined || from === to || !evidence || !origin) {
      stats.dropped += 1;
      continue;
    }
    if (seen.has(`${from}\u0000${to}`)) continue;
    seen.add(`${from}\u0000${to}`);
    // 边级校验：**只降不升**。两种情况都降为 inferred，条数分别记账（进 caveats，不静默）：
    // ① 声称 static 而依赖图证不出来；
    // ② 声称 code ——这一步只读了入口前 120 行，「在源码里读到」不成立（真正的 code 边由按需深入给出）。
    // 反过来永远不成立：模型自己说推断的边，就算图上恰有关系也不抬成「来自代码」。
    const downgradedStatic = origin === "static" && !stagesRelated(stages[from - 1], stages[to - 1], context.areRelated);
    const demotedCode = origin === "code";
    if (downgradedStatic) stats.downgradedStatic += 1;
    if (demotedCode) stats.demotedCode += 1;
    edges.push({ from, to, origin: downgradedStatic || demotedCode ? "inferred" : origin, evidence });
  }
  return edges;
}

type NormalizedStage = Omit<FlowStage, "order" | "loopsTo"> & { sourceOrder: number; loopsTo?: number };

function normalizeStage(
  item: unknown,
  context: ParseContext,
  droppedFiles: { count: number },
  clampedLines: { count: number },
  sourceOrder: number
): NormalizedStage | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const title = asText(record.title, MAX_STAGE_TITLE);
  if (!title) return null;
  const files: FlowStageFile[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(record.files) ? record.files : []) {
    if (files.length >= MAX_STAGE_FILES) break;
    if (!candidate || typeof candidate !== "object") continue;
    const file = candidate as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path.trim().replace(/^\.\//, "") : "";
    if (!path) continue;
    if (!context.availablePaths.has(path)) { droppedFiles.count += 1; continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const limit = Math.max(1, context.linesOf.get(path) ?? 1);
    // 越界的行号仍要落回文件范围内（指到文件外更没有意义），但**不再无声无息**：
    // 改了几处由调用方记账并写进 caveats。缺行号（没给）不算越界——那是省略，不是错报。
    const raw = Number(file.line);
    const requested = Number.isFinite(raw) ? Math.floor(raw) : 1;
    const line = Math.min(Math.max(1, requested), limit);
    if (line !== requested) clampedLines.count += 1;
    const note = asText(file.note, MAX_FILE_NOTE);
    files.push(note ? { path, line, note } : { path, line });
  }
  // 一个指不到代码的环节没有价值：静默保留会让读者以为它对应某处实现
  if (!files.length) return null;
  const kindText = typeof record.kind === "string" ? record.kind : "";
  const kind: FlowStageKind = kindText === "entry" || kindText === "decision" || kindText === "loop" || kindText === "exit" ? kindText : "stage";
  const branches = (Array.isArray(record.branches) ? record.branches : [])
    .map((branch) => asText(branch, MAX_BRANCH_TEXT))
    .filter(Boolean)
    .slice(0, MAX_BRANCHES);
  const loopsTo = Number.isInteger(record.loopsTo) ? Number(record.loopsTo) : undefined;
  return { sourceOrder, kind, title, detail: asText(record.detail, MAX_STAGE_DETAIL), files, branches, ...(loopsTo !== undefined ? { loopsTo } : {}) };
}

function asText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const chars = [...value.trim().replace(/\s+/g, " ")];
  // 截断要留痕：静默掐尾会让界面把半截句子当成模型的完整结论（省略号占一格，总长仍不超 limit）
  if (chars.length <= limit) return chars.join("");
  return `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/**
  流程缓存：键 = 层名 + 仓库 + 入口 + **本层实际输入的哈希**（即发给模型的 digest）。
  缓存成功结果与确定性降级（`deterministic`，见 `GeneratedFlow`）；瞬时失败（调用异常 / 内容解析不出）
  不入缓存，下次访问重试。TTL 是**闲置时长**而非「生成后的固定时长」——每次命中都把 `at` 推到当下，
  所以只要这个入口还在被访问，缓存就一直有效。

  为什么续期是安全的（此处原先靠全仓 `versionStamp` 兜底）：digest 变了键就变，而 digest 涵盖
  入口、文件清单与符号、跨文件依赖、静态调用链证据、已确认的 L1 摘要——仓库改到这些里的任何一处、
  换了模型，都会翻键。反过来说，digest 一字不变时模型看到的问题就一字不变，缓存里那条流程正是它
  当下会给出的答案；LSP 从降级恢复但结构事实没变，也落在这一类里（恢复会改 digest 时才需要重算）。
  所以不需要再论证「哪些变更会作废流程」。
  */
const flowCache = new Map<string, { result: GeneratedFlow; at: number }>();
const FLOW_CACHE_TTL_MS = 10 * 60_000;
const FLOW_CACHE_MAX = 60;
/** 持久层的闲置 TTL：键是输入精确哈希，「过期」条目只是不再被读到的垃圾，不存在可信性问题，
    所以可以远长于内存层的 10 分钟——它防的是重启后重烧（dev 模式 tsx watch 每次改代码都重启）。 */
const FLOW_PERSISTED_TTL_MS = 7 * 24 * 60 * 60_000;

/** 清空流程缓存：供测试隔离回合间状态。换仓/卸载路径**不**调它——键里已带 `repositoryId`，
    跨仓库不会串味，且有 TTL + 条数上限，切回来还能继续命中。 */
export function clearRepositoryFlowCache(): void {
  flowCache.clear();
}

export async function generateRepositoryFlowCached(input: GenerateFlowInput & { repositoryId: string }): Promise<GeneratedFlow> {
  const digest = tryBuildFlowDigest(input);
  if (!digest) return generateRepositoryFlow(input);
  const key = layerCacheKey({
    layer: "flow",
    repositoryId: input.repositoryId,
    contractVersion: FLOW_INPUT_VERSION,
    modelVersion: input.provider.modelVersion,
    payload: digest,
    scope: input.entry.path
  });
  const now = Date.now();
  const hit = flowCache.get(key);
  if (hit && now - hit.at < FLOW_CACHE_TTL_MS) {
    flowCache.delete(key);
    flowCache.set(key, { result: hit.result, at: now }); // 命中即续期 + 刷新 LRU 新近度
    input.database?.touchLayerCache(key, now);
    return { ...hit.result, usage: undefined };
  }
  // 内存过期/缺失时先查 SQLite：engine 重启（tsx watch）会清空内存层，持久层让重启不重烧
  const stored = input.database?.getLayerCache<GeneratedFlow>(key);
  if (stored && now - stored.at < FLOW_PERSISTED_TTL_MS) {
    flowCache.set(key, { result: stored.value, at: now });
    trimToNewest(flowCache, FLOW_CACHE_MAX);
    input.database?.touchLayerCache(key, now);
    return { ...stored.value, usage: undefined };
  }
  const result = await generateFromDigest(input, digest);
  if (result.source === "llm" || result.deterministic) {
    // 确定性降级也是可信答案：不缓存的话，每次打开这个入口都重烧一遍钱（实测启动类入口 ~15k tok/次）；
    // 只有瞬时失败（调用异常 / 解析不出）走到 else，下次访问重试。
    flowCache.set(key, { result, at: now });
    trimToNewest(flowCache, FLOW_CACHE_MAX);
    input.database?.putLayerCache(key, result);
  }
  return result;
}

/** Map 的迭代序即插入序，配合「先 delete 再 set」即为新近度，从头裁掉最旧项。 */
function trimToNewest<Key, Value>(map: Map<Key, Value>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** LLM 不可用或预算触顶时的入口：直接给静态调用链，并显式说明原因。 */
export function degradedFlow(analysis: RepositoryAnalysis, entry: SourceAnchor, reason: string): GeneratedFlow {
  return { flow: staticFlow(buildFlowEvidence(analysis, entry), reason), source: "static", reason };
}
