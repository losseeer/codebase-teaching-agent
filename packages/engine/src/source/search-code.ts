import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

import { isTestPath } from "@codebase-tutor/analysis";
import type { LlmTool } from "../application/port/llm-provider.js";
import { themeTokens, tokenHits, wordsOf, segmentForLookup } from "@codebase-tutor/platform";

/**
  search_code：对路径、符号名与摘要做词法检索，只回位置与职责，正文仍走 read_file。
  检索不占读文件额度，语料来自导入期产物。
*/

const MAX_RESULT_CHARS = 2_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 15;
/** 查询词元上限。 */
const MAX_QUERY_TOKENS = 12;
const MAX_SYMBOLS_SHOWN = 6;
/** 每条结果最多报几个命中的函数。 */
const MAX_UNITS_SHOWN = 2;
/** 摘要进语料与结果的长度上限，单位字符。 */
const MAX_SUMMARY_CHARS = 160;

function sliceSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary;
}
/** 回退检索的文档频率上限，超过它当通用词丢掉。 */
const FALLBACK_DF_RATIO = 0.12;
/** 文档频率上限的文件数下界。 */
const FALLBACK_DF_FLOOR = 3;
/** 回退检索要求同一文件被几枚不同词元同时命中。 */
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

/** 一次检索的审计记录，不含正文。 */
export interface CodeSearchRecord {
  query: string;
  hits: number;
  /** 前 5 条命中的路径。 */
  topPaths: string[];
  /** 结果来自中文切词回退。 */
  segmented?: boolean;
}

interface CorpusEntry {
  path: string;
  /** 小写路径，打分用。 */
  pathWords: string;
  lines?: number;
  symbols: string[];
  /** 符号名拼成的小写检索文本。 */
  symbolText: string;
  /** 文件内符号与定义行，不参与打分。 */
  units: { name: string; line?: number }[];
  summary: string;
}

export interface SearchCorpus {
  entries: CorpusEntry[];
}

/** 用导入期产物拼检索语料。 */
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
    // 同名符号去重后打分，行号逐条保留
    const names = [...new Set(units.map((unit) => unit.name))];
    entries.push({
      path,
      pathWords: path.toLowerCase(),
      lines: linesOf.get(path),
      symbols: names,
      symbolText: names.join(" ").toLowerCase(),
      units,
      summary: sliceSummary(summaries.get(path) ?? "")
    });
  }
  return { entries };
}

/** 查询切词：主题分词加 camelCase 整词，去重并截上限。 */
function queryTokens(query: string, cap = MAX_QUERY_TOKENS): string[] {
  const lowered = query.toLowerCase();
  return [...new Set([...themeTokens(lowered), ...wordsOf(lowered)])].filter((token) => token.length >= 2).slice(0, cap);
}

/** 一条语料里参与命中的全部文本。 */
const haystackOf = (entry: CorpusEntry): string => `${entry.pathWords} ${entry.symbolText} ${entry.summary.toLowerCase()}`;

interface Scored {
  entry: CorpusEntry;
  score: number;
  pathHit: boolean;
  symbolHit: boolean;
  summaryHit: boolean;
  /** 被词元命中的具体符号，不参与排名。 */
  hitUnits: { name: string; line?: number }[];
}

/** 一枚词元在某个命中面里的首个出现区间。 */
const spanOf = (text: string, token: string): [number, number] => {
  const at = Math.max(0, text.indexOf(token));
  return [at, at + token.length];
};

/** 同一命中面里重叠的词元只算一份证据。 */
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

/** 打一轮分，minHits 是一个文件需要的不重叠命中数。 */
function scoreCorpus(corpus: SearchCorpus, tokens: string[], minHits: number): Scored[] {
  const scored: Scored[] = [];
  for (const entry of corpus.entries) {
    let score = 0;
    const pathTokens: string[] = [];
    const symbolTokens: string[] = [];
    const summary = entry.summary.toLowerCase();
    const summaryTokens: string[] = [];
    for (const token of tokens) {

      if (tokenHits(token, entry.pathWords)) { score += 3; pathTokens.push(token); }
      if (tokenHits(token, entry.symbolText)) { score += 3; symbolTokens.push(token); }
      if (tokenHits(token, summary)) { score += 2; summaryTokens.push(token); }
    }
    const matchedTokens = distinctEvidence([{ text: entry.pathWords, tokens: pathTokens }, { text: entry.symbolText, tokens: symbolTokens }, { text: summary, tokens: summaryTokens }]);
    if (matchedTokens >= minHits) {
      // 测试文件得分封顶 1 分，不剔除
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
  return scored.sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path));
}

/** 按文档频率丢掉通用词。 */
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
  let segmented = false;
  // 回退跑过与回退命中是两个独立状态
  let fallbackTried = false;
  if (!scored.length) {
    // 原样查询零命中时才重试中文切词
    const loose = gateFallbackTokens(corpus, queryTokens(segmentForLookup(query), MAX_QUERY_TOKENS * 3));
    fallbackTried = loose.length >= FALLBACK_MIN_HITS;
    if (fallbackTried) {
      scored = scoreCorpus(corpus, loose, FALLBACK_MIN_HITS);
      segmented = scored.length > 0;
    }
  }
  const hits = scored.slice(0, limit);
  const audit: CodeSearchRecord = { query, hits: scored.length, topPaths: hits.map((item) => item.entry.path).slice(0, 5), ...(segmented ? { segmented: true } : {}) };
  if (!hits.length) {
    // 词元全被过滤与被过滤后仍无命中是两种情况
    const why = fallbackTried ? "（中文切词兜底的词元过了文档频率闸，但没有文件同时命中两枚）" : "（中文切词兜底出来的词元没过文档频率闸）";
    return { content: `search_code "${query}" 没有命中任何已分析文件${why}。可换更短/更通用的检索词，或直接基于已有上下文回答。`, audit };
  }
  const blocks: string[] = [];
  // shown 只数结果条目，省略提示行不算
  let shown = 0;
  let used = 0;
  for (const item of hits) {
    const symbolNames = item.entry.symbols.slice(0, MAX_SYMBOLS_SHOWN).join(", ") || "（无符号）";
    const more = item.entry.symbols.length > MAX_SYMBOLS_SHOWN ? `…共 ${item.entry.symbols.length} 个符号` : "";
    const lines = item.entry.lines === undefined ? "" : `，${item.entry.lines} 行`;
    const matched = [item.pathHit && "路径", item.symbolHit && "符号", item.summaryHit && "职责"].filter(Boolean).join("/");
    const testTag = isTestPath(item.entry.path) ? "，测试文件" : "";
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
