import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { isTestPath } from "../depgraph/roles.js";
import type { LlmTool } from "../llm/provider.js";
import { themeTokens, tokenHits, wordsOf } from "../text/lexical.js";

/**
  search_code 工具（宏观设计 map 与教学 teaching 共用，练习答疑不提供）：
  纯词法检索「文件在哪」——路径、符号名、L1 一句话职责三处做词边界命中打分，
  **只回位置与职责，不回正文**：正文仍必须走 read_file，护栏与 file_read 审计口径不被绕过。

  动机：对话 agent 此前的世界清单只有目录全景（每目录截 20 个文件名）+ 邻接 + 锚点，
  清单外的文件模型连存在都不知道，只能盲猜路径试 read_file。检索不读任何文件、
  不占 maxCalls 文件额度，单次结果约 2,000 字符（对照 read_file 单窗 12,000），是省 token 的探路手段。

  零 LLM、零 I/O：语料全部来自导入期已产出的结构事实（依赖图符号表 + L1 摘要表），
  不进任何缓存层、不改任何对话固定输入——关闭只需不传 corpus，无失效语义。
*/

const MAX_RESULT_CHARS = 2_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 15;
/** 查询词元上限：再多也只是给打分灌噪声（同 entry-suggest 的翻译词元纪律）。 */
const MAX_QUERY_TOKENS = 12;
/** 每条结果最多列几个命中符号。 */
const MAX_SYMBOLS_SHOWN = 6;
/** 摘要进语料/结果的长度上限：L1 承诺 ≤60 字，这里防御脏行——超长摘要会挤掉别的命中条目。 */
const MAX_SUMMARY_CHARS = 160;

export const SEARCH_CODE_TOOL: LlmTool = {
  name: "search_code",
  description: "按关键词检索仓库内已分析的文件（匹配文件路径、符号名、文件一句话职责），返回候选文件的位置与职责清单——**不返回源码正文**。不确定实现在哪个文件时先调用它缩小范围，再用 read_file 读命中的路径。禁止用它替代 read_file 获取代码内容。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "空格分隔的检索词（英文标识符或中文职责词均可），如 'seckill voucher listener'" },
      limit: { type: "integer", description: `返回文件数上限，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}` }
    },
    required: ["query"]
  }
};

/** 一次检索的审计记录（由调用方记 journal code_search；无正文，符合 §1.1 口径）。 */
export interface CodeSearchRecord {
  query: string;
  hits: number;
  /** 前 5 条命中的路径（漏斗读数：搜到什么之后去读了什么）。 */
  topPaths: string[];
}

interface CorpusEntry {
  path: string;
  /** 预切好的路径词（按 / . - _ 断开 + camelCase），打分用。 */
  pathWords: string;
  lines?: number;
  symbols: string[];
  /** 符号名拼成的检索文本（小写）。 */
  symbolText: string;
  summary: string;
}

export interface SearchCorpus {
  entries: CorpusEntry[];
}

/** 用导入期产物拼检索语料：路径=已分析文件全集（与目录全景同源），符号=图符号表，职责=L1 摘要表。 */
export function buildSearchCorpus(index: RepositoryIndex, analysis: RepositoryAnalysis, summaries: Map<string, string>): SearchCorpus {
  const analyzed = new Set(Object.keys(analysis.graph.imports));
  for (const symbol of analysis.graph.symbols) analyzed.add(symbol.path);
  const symbolsByPath = new Map<string, string[]>();
  for (const symbol of analysis.graph.symbols) {
    const list = symbolsByPath.get(symbol.path);
    if (list) list.push(symbol.name);
    else symbolsByPath.set(symbol.path, [symbol.name]);
  }
  const linesOf = new Map(index.files.map((file) => [file.path, file.lines]));
  const entries: CorpusEntry[] = [];
  for (const path of [...analyzed].sort()) {
    const names = [...new Set(symbolsByPath.get(path) ?? [])];
    entries.push({
      path,
      pathWords: path.toLowerCase(),
      lines: linesOf.get(path),
      symbols: names,
      symbolText: names.join(" ").toLowerCase(),
      summary: (summaries.get(path) ?? "").slice(0, MAX_SUMMARY_CHARS)
    });
  }
  return { entries };
}

/** 查询切词：theme 分词（含中文标点断开）+ camelCase 整词，去重截上限。 */
function queryTokens(query: string): string[] {
  const lowered = query.toLowerCase();
  return [...new Set([...themeTokens(lowered), ...wordsOf(lowered)])].filter((token) => token.length >= 2).slice(0, MAX_QUERY_TOKENS);
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
  const tokens = queryTokens(query);
  type Scored = { entry: CorpusEntry; score: number; pathHit: boolean; symbolHit: boolean; summaryHit: boolean };
  const scored: Scored[] = [];
  for (const entry of corpus.entries) {
    let score = 0;
    let pathHit = false;
    let symbolHit = false;
    let summaryHit = false;
    const summary = entry.summary.toLowerCase();
    for (const token of tokens) {
      // 与推荐入口排序同一命中面（路径/职责词边界），符号名顶替「候选摘要」的位置成为最强代码信号
      if (tokenHits(token, entry.pathWords)) { score += 3; pathHit = true; }
      if (tokenHits(token, entry.symbolText)) { score += 3; symbolHit = true; }
      if (tokenHits(token, summary)) { score += 2; summaryHit = true; }
    }
    if (score > 0) {
      // 09-22：测试文件重罚垫底但**不剔除**——真仓 B 档实测 CacheClientTest 这类顶着同名类前缀的
      // 文件抢 top1；封顶 1 分压在一切真实命中之下（非测试最低 2 分），概念只有测试演示时仍能兜底
      // 出现——硬剔除会把「仓里有」答成「没有」，那是事实性错误，比排名瑕疵严重。
      scored.push({ entry, score: isTestPath(entry.path) ? Math.min(score, 1) : score, pathHit, symbolHit, summaryHit });
    }
  }
  // 分数降序；同分按路径字典序——结果顺序必须与构建顺序无关（可复现）
  scored.sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path));
  const hits = scored.slice(0, limit);
  const audit: CodeSearchRecord = { query, hits: scored.length, topPaths: hits.map((item) => item.entry.path).slice(0, 5) };
  if (!hits.length) {
    return { content: `search_code "${query}" 没有命中任何已分析文件。可换更短/更通用的检索词，或直接基于已有上下文回答。`, audit };
  }
  const blocks: string[] = [];
  let used = 0;
  for (const item of hits) {
    const symbolNames = item.entry.symbols.slice(0, MAX_SYMBOLS_SHOWN).join(", ") || "（无符号）";
    const more = item.entry.symbols.length > MAX_SYMBOLS_SHOWN ? `…共 ${item.entry.symbols.length} 个符号` : "";
    const lines = item.entry.lines === undefined ? "" : `，${item.entry.lines} 行`;
    const matched = [item.pathHit && "路径", item.symbolHit && "符号", item.summaryHit && "职责"].filter(Boolean).join("/");
    // 兜底进结果时明说是测试文件——模型拿着这个上下文自己决定要不要读，而不是被排名悄悄误导
    const testTag = isTestPath(item.entry.path) ? "，测试文件" : "";
    const block = `- ${item.entry.path}（${lines.slice(1) || "行数未知"}${testTag}）【命中 ${item.score}：${matched || "-"}】\n  符号: ${symbolNames}${more}${item.entry.summary ? `\n  职责: ${item.entry.summary}` : ""}`;
    if (used + block.length > MAX_RESULT_CHARS) {
      blocks.push(`…（其余 ${hits.length - blocks.length} 条超出结果预算已省略，可收窄 query 或调低 limit。）`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  const head = `search_code "${query}"：共 ${scored.length} 个文件命中，返回前 ${blocks.length} 条（本工具只给位置与职责，正文请用 read_file 读取）：`;
  return { content: `${head}\n${blocks.join("\n")}`, audit };
}
