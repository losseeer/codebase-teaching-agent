import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

import { isTestPath } from "../depgraph/roles.js";
import type { LlmTool } from "../llm/provider.js";
import { themeTokens, tokenHits, wordsOf, segmentForLookup } from "../text/lexical.js";

/**
  search_code 工具（宏观设计 map 与教学 teaching 共用，练习答疑不提供）：
  纯词法检索「文件在哪」——路径、符号名、L1 一句话职责三处做词边界命中打分，只回位置与职责，不回正文：
  正文仍必须走 read_file，护栏与 file_read 审计口径不被绕过。

  它不读任何文件、不占 maxCalls 文件额度，单次结果约 2,000 字符（对照 read_file 单窗 12,000）。

  零 LLM、零 I/O：语料全部来自导入期已产出的结构事实（依赖图符号表 + L1 摘要表），
  不进任何缓存层、不改任何对话固定输入——关闭只需不传 corpus，无失效语义。
*/

const MAX_RESULT_CHARS = 2_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 15;
/** 查询词元上限：再多只是给打分灌噪声。 */
const MAX_QUERY_TOKENS = 12;
const MAX_SYMBOLS_SHOWN = 6;
/** 每条结果最多报几个命中的函数：行号是给 read_file 的落点，不是让模型猜的。 */
const MAX_UNITS_SHOWN = 2;
/** 摘要进语料与结果的长度上限：防御脏行——超长摘要会挤掉别的命中条目。 */
const MAX_SUMMARY_CHARS = 160;

function sliceSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary;
}
/** 兜底臂的文档频率闸：词元出现在超过这个比例的语料文件里就当通用词丢掉（下限见 FALLBACK_DF_FLOOR）。 */
const FALLBACK_DF_RATIO = 0.12;
/** 小仓里比例没有意义（3 条语料时任何词都「无处不在」），所以另设绝对下限。 */
const FALLBACK_DF_FLOOR = 3;
/** 兜底臂要求同一文件被几枚不同词元同时命中——单个碎词命中不算答案。 */
const FALLBACK_MIN_HITS = 2;

export const SEARCH_CODE_TOOL: LlmTool = {
  name: "search_code",
  description: "按关键词检索仓库内已分析的文件（匹配文件路径、符号名、文件一句话职责），返回候选文件的位置（含命中的函数与行号）与职责清单——不返回源码正文。不确定实现在哪个文件时先调用它缩小范围，再用 read_file 读命中的路径。禁止用它替代 read_file 获取代码内容。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "空格分隔的检索词（英文标识符或中文职责词均可），如 'seckill voucher listener'" },
      limit: { type: "integer", description: `返回文件数上限，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}` }
    },
    required: ["query"]
  }
};

/** 一次检索的审计记录（由调用方记 journal code_search；不含正文）。 */
export interface CodeSearchRecord {
  query: string;
  hits: number;
  /** 前 5 条命中的路径，用于对照「搜到什么之后去读了什么」。 */
  topPaths: string[];
  /** 结果来自中文切词兜底臂（原样查询零命中才会走）；没有这个字段就分不清命中率出自哪一臂。 */
  segmented?: boolean;
}

interface CorpusEntry {
  path: string;
  /** 预切好的路径词（按 / . - _ 断开 + camelCase），打分用。 */
  pathWords: string;
  lines?: number;
  symbols: string[];
  /** 符号名拼成的检索文本（小写）。 */
  symbolText: string;
  /** 文件内符号连定义行。不参与打分，只用来把「命中的是哪个函数、在第几行」回报给模型。 */
  units: { name: string; line?: number }[];
  summary: string;
}

export interface SearchCorpus {
  entries: CorpusEntry[];
}

/** 用导入期产物拼检索语料：路径=已分析文件全集（与目录全景同源），符号=图符号表，职责=L1 摘要表。 */
export function buildSearchCorpus(index: RepositoryIndex, analysis: RepositoryAnalysis, summaries: Map<string, string>): SearchCorpus {
  const analyzed = new Set(Object.keys(analysis.graph.imports));
  for (const symbol of analysis.graph.symbols) analyzed.add(symbol.path);
  const unitsByPath = new Map<string, { name: string; line?: number }[]>();
  for (const symbol of analysis.graph.symbols) {
    const unit = { name: symbol.name, ...(symbol.line === undefined ? {} : { line: symbol.line }) };
    const list = unitsByPath.get(symbol.path);
    if (list) list.push(unit);
    else unitsByPath.set(symbol.path, [unit]);
  }
  const linesOf = new Map(index.files.map((file) => [file.path, file.lines]));
  const entries: CorpusEntry[] = [];
  for (const path of [...analyzed].sort()) {
    const units = unitsByPath.get(path) ?? [];
    // 同名符号可能有多个（重载、内部类）：打分用的名字去重，定位用的行号逐条留着
    const names = [...new Set(units.map((unit) => unit.name))];
    entries.push({
      path,
      pathWords: path.toLowerCase(),
      lines: linesOf.get(path),
      symbols: names,
      symbolText: names.join(" ").toLowerCase(),
      units,
      // 裁过的摘要要留标记：残句不带记号时，模型把半截职责当成完整描述，据以规划 read_file 落点
      summary: sliceSummary(summaries.get(path) ?? "")
    });
  }
  return { entries };
}

/** 查询切词：theme 分词（含中文标点断开）+ camelCase 整词，去重截上限。 */
function queryTokens(query: string, cap = MAX_QUERY_TOKENS): string[] {
  const lowered = query.toLowerCase();
  return [...new Set([...themeTokens(lowered), ...wordsOf(lowered)])].filter((token) => token.length >= 2).slice(0, cap);
}

/** 一条语料里可能被命中的全部文本（兜底臂数文档频率用，口径与打分的三个命中面一致）。 */
const haystackOf = (entry: CorpusEntry): string => `${entry.pathWords} ${entry.symbolText} ${entry.summary.toLowerCase()}`;

interface Scored {
  entry: CorpusEntry;
  score: number;
  pathHit: boolean;
  symbolHit: boolean;
  summaryHit: boolean;
  /** 被符号名词元命中的具体符号：不改排名，只多给一个落点。 */
  hitUnits: { name: string; line?: number }[];
}

/** 一枚词元在某个命中面里的首个出现区间（`tokenHits` 认可命中 ⇒ `indexOf` 必然找得到一处出现）。 */
const spanOf = (text: string, token: string): [number, number] => {
  const at = Math.max(0, text.indexOf(token));
  return [at, at + token.length];
};

/**
  同一命中面里互相重叠的词元只算一份证据。

  兜底臂的一致性闸要求「≥2 枚不同词元命中同一文件」，而 `segmentForLookup` 是滑动窗口切词：
  「一对一」会同时产出 `一对` 与 `对一`，两者都命中摘要里的同一处 ⇒ 一个短语骗过两票闸。
  相邻但不重叠的词元（`支付` + `回调`）仍算两票——闸要挡的是同一处文字被数了两次，不是词元挨着。
  */
function distinctEvidence(faces: { text: string; tokens: string[] }[]): number {
  let evidence = 0;
  for (const face of faces) {
    let cursor = -1;
    for (const [start, end] of face.tokens.map((token) => spanOf(face.text, token)).sort((left, right) => left[0] - right[0])) {
      if (start < cursor) continue;
      evidence += 1;
      cursor = end;
    }
  }
  return evidence;
}

/** 打一轮分；`minHits` = 一个文件要有几枚互不重叠的词元同时命中才算候选。 */
function scoreCorpus(corpus: SearchCorpus, tokens: string[], minHits: number): Scored[] {
  const scored: Scored[] = [];
  for (const entry of corpus.entries) {
    let score = 0;
    const pathTokens: string[] = [];
    const symbolTokens: string[] = [];
    const summary = entry.summary.toLowerCase();
    const summaryTokens: string[] = [];
    for (const token of tokens) {
      // 与推荐入口排序同一命中面（路径/职责词边界），符号名顶替「候选摘要」的位置成为最强代码信号
      if (tokenHits(token, entry.pathWords)) { score += 3; pathTokens.push(token); }
      if (tokenHits(token, entry.symbolText)) { score += 3; symbolTokens.push(token); }
      if (tokenHits(token, summary)) { score += 2; summaryTokens.push(token); }
    }
    const matchedTokens = distinctEvidence([{ text: entry.pathWords, tokens: pathTokens }, { text: entry.symbolText, tokens: symbolTokens }, { text: summary, tokens: summaryTokens }]);
    if (matchedTokens >= minHits) {
      // 测试文件重罚垫底但不剔除：封顶 1 分压在一切真实命中之下（非测试最低 2 分）；
      // 硬剔除会把「仓里有」答成「没有」，那是事实性错误，比排名瑕疵严重。
      scored.push({
        entry,
        score: isTestPath(entry.path) ? Math.min(score, 1) : score,
        pathHit: pathTokens.length > 0,
        symbolHit: symbolTokens.length > 0,
        summaryHit: summaryTokens.length > 0,
        hitUnits: entry.units.filter((unit) => symbolTokens.some((token) => tokenHits(token, unit.name.toLowerCase()))).slice(0, MAX_UNITS_SHOWN)
      });
    }
  }
  // 分数降序；同分按路径字典序——结果顺序必须与构建顺序无关（可复现）
  return scored.sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path));
}

/**
  兜底臂的文档频率闸：某个词元出现在超过 `FALLBACK_DF_RATIO`（且不少于 `FALLBACK_DF_FLOOR` 个）文件里就当通用词丢掉。
  切词后的双字片段（「文件」「数据」「如何」）在满是中文注释的仓里满地都是；
  没有这道闸，本该零命中的负例会被切成误命中。
*/
function gateFallbackTokens(corpus: SearchCorpus, tokens: string[]): string[] {
  const ceiling = Math.max(FALLBACK_DF_FLOOR, Math.floor(corpus.entries.length * FALLBACK_DF_RATIO));
  return tokens
    .filter((token) => corpus.entries.filter((entry) => tokenHits(token, haystackOf(entry))).length <= ceiling)
    .slice(0, MAX_QUERY_TOKENS);
}

export function executeSearchCode(corpus: SearchCorpus, argumentsJson: string): { content: string; audit: CodeSearchRecord } {
  let args: { query?: unknown; limit?: unknown };
  try {
    args = JSON.parse(argumentsJson || "{}") as typeof args;
  } catch {
    const audit = { query: "", hits: 0, topPaths: [] };
    return { content: "search_code 参数不是合法 JSON，请重新调用。", audit };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { content: "search_code 缺少 query 参数。", audit: { query: "", hits: 0, topPaths: [] } };
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT));
  let scored = scoreCorpus(corpus, queryTokens(query), 1);
  // 兜底最后一级：只有原样查询零命中才重试中文二分切词；关键词式查询本来就有命中，走不到这里。
  // 两道闸（DF 闸 + 同一文件至少 2 枚词元）是它敢进产品的前提：裸切词会把负例切成误命中。
  let segmented = false;
  // 兜底跑过没有（词元活过文档频率闸）与兜底有没有命中是两条读数；`scored` 为空时兜底分支必进
  let fallbackTried = false;
  if (!scored.length) {
    const loose = gateFallbackTokens(corpus, queryTokens(segmentForLookup(query), MAX_QUERY_TOKENS * 3));
    fallbackTried = loose.length >= FALLBACK_MIN_HITS;
    if (fallbackTried) {
      scored = scoreCorpus(corpus, loose, FALLBACK_MIN_HITS);
      segmented = scored.length > 0;
    }
  }
  const hits = scored.slice(0, limit);
  // topPaths 跟着 limit 走（审计口径是「模型这一轮真看到了哪几条」，不是「仓里哪几条最好」）
  const audit: CodeSearchRecord = { query, hits: scored.length, topPaths: hits.map((item) => item.entry.path).slice(0, 5), ...(segmented ? { segmented: true } : {}) };
  if (!hits.length) {
    // 两句是真的两个读数：词元全被文档频率闸丢掉 ≠ 词元活下来了但没有文件同时命中两枚（前者换词，后者拆成两次查）
    const why = fallbackTried ? "（中文切词兜底的词元过了文档频率闸，但没有文件同时命中两枚）" : "（中文切词兜底出来的词元没过文档频率闸）";
    return { content: `search_code "${query}" 没有命中任何已分析文件${why}。可换更短/更通用的检索词，或直接基于已有上下文回答。`, audit };
  }
  const blocks: string[] = [];
  // 抬头那句「返回前 N 条」数的是结果条目，省略提示那一行不算一条（截断时会多报 1 条，且与「其余 X 条」对不上）
  let shown = 0;
  let used = 0;
  for (const item of hits) {
    const symbolNames = item.entry.symbols.slice(0, MAX_SYMBOLS_SHOWN).join(", ") || "（无符号）";
    const more = item.entry.symbols.length > MAX_SYMBOLS_SHOWN ? `…共 ${item.entry.symbols.length} 个符号` : "";
    const lines = item.entry.lines === undefined ? "" : `，${item.entry.lines} 行`;
    const matched = [item.pathHit && "路径", item.symbolHit && "符号", item.summaryHit && "职责"].filter(Boolean).join("/");
    // 兜底进结果时明说是测试文件——模型拿着这个上下文自己决定要不要读，而不是被排名悄悄误导
    const testTag = isTestPath(item.entry.path) ? "，测试文件" : "";
    // 「就近」= 这条查询命中在哪个函数、第几行；把符号级位置交给模型，省一次「搜到文件再猜位置」的读取
    const nearest = item.hitUnits.map((unit) => (unit.line === undefined ? unit.name : `${unit.name}:${unit.line}`)).join("、");
    const block = `- ${item.entry.path}（${lines.slice(1) || "行数未知"}${testTag}）【命中 ${item.score}：${matched || "-"}】\n  符号: ${symbolNames}${more}${nearest ? `\n  就近: ${nearest}` : ""}${item.entry.summary ? `\n  职责: ${item.entry.summary}` : ""}`;
    if (used + block.length > MAX_RESULT_CHARS) {
      blocks.push(`…（其余 ${hits.length - shown} 条超出结果预算已省略，可收窄 query 或调低 limit。）`);
      break;
    }
    blocks.push(block);
    shown += 1;
    used += block.length;
  }
  const head = `search_code "${query}"：共 ${scored.length} 个文件命中${segmented ? "（原查询零命中，这里来自中文切词兜底，相关性弱于直接命中——请把它当候选而不是答案）" : ""}，返回前 ${shown} 条（本工具只给位置与职责，正文请用 read_file 读取）：`;
  return { content: `${head}\n${blocks.join("\n")}`, audit };
}
