/**
  对话历史进上下文的那道压缩（三个对话作用域共用：代码问答、宏观设计、练习答疑）。

  两条折叠触发：占到窗口的 `HISTORY_COMPACT_AT_RATIO`（学习者说的「当前上下文超过 m%」），
  或者这段历史装不进本轮分给它的空间——后者是兜住「长线程把源码摘录挤光」的形状。
  折的时候只完整保留最近 `HISTORY_KEEP_RECENT_MESSAGES` 条与最早 `HISTORY_KEEP_EARLIEST_MESSAGES` 条，
  中间一律换成一句占位。学习者若引用了被折叠的内容（「你前面说的那个事务边界」），
  本轮提问里的词会在这段折叠语料上算 BM25，把最相关的几条原文找回来贴在占位那一行下面——
  找回来的是真原文，不是重新编一段。

  为什么留「最早几条」：开场那一轮说的通常是目标与范围，后面的追问全挂在它上面；
  丢掉它，模型会把对话当成从中间开始的，答到一半去猜「你说的『它』指什么」。
*/
import { CHARS_PER_TOKEN, CONTEXT_SHARE, contextShare, contextWindowTokens } from "./context-window.js";
import { segmentForLookup, wordsOf } from "../text/lexical.js";

export interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** m：占到窗口的这个比例就开始折叠对话。 */
export const HISTORY_COMPACT_AT_RATIO = 0.8;
/** a：折叠后仍完整保留的最近条数。 */
export const HISTORY_KEEP_RECENT_MESSAGES = 6;
/** b：折叠后仍完整保留的最早条数。 */
export const HISTORY_KEEP_EARLIEST_MESSAGES = 2;
/** 找回几条封顶：折叠段再长，本轮用得上的通常就那么两三段。 */
const RECALLED_MAX_MESSAGES = 3;
/** 相关度下限：低于这个分说明本轮没引用折叠内容，别硬塞。 */
const RECALL_MIN_SCORE = 1.2;
const BM25_TERM_FREQUENCY_SATURATION = 1.2;
const BM25_LENGTH_NORMALIZATION = 0.75;

export interface ConversationBlock {
  /** 直接拼进请求的那一段；没有可用历史时为空串。 */
  text: string;
  /** 真被折掉的条数（找回来的不算折掉；0 = 本轮没折）。 */
  foldedMessages: number;
  /** 从折叠段按词法相关度找回来的条数。 */
  recalledMessages: number;
}

/** 词元：ASCII 按 camelCase 与标点切词，中文按二分词窗口——与 `source/search_code` 的兜底档同一份口径。 */
function termsOf(text: string): string[] {
  const terms: string[] = [];
  for (const chunk of segmentForLookup(text).split(/\s+/)) {
    if (!chunk) continue;
    if (/^[\x00-\x7F]+$/.test(chunk)) terms.push(...wordsOf(chunk));
    else if (chunk.length >= 2) terms.push(chunk);
  }
  return terms;
}

/** Okapi BM25：一条消息当一篇文档（一个线程几十条，不必再切片）。 */
function bm25Scores(queryTerms: string[], documents: string[][]): number[] {
  if (!queryTerms.length || !documents.length) return documents.map(() => 0);
  const lengths = documents.map((terms) => terms.length);
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const terms of documents) for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const uniqueQueryTerms = [...new Set(queryTerms)];
  return documents.map((terms, index) => {
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of uniqueQueryTerms) {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const occurrences = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(1 + (documents.length - occurrences + 0.5) / (occurrences + 0.5));
      const normalization = 1 - BM25_LENGTH_NORMALIZATION + BM25_LENGTH_NORMALIZATION * (lengths[index] / averageLength);
      score += inverseDocumentFrequency * ((frequency * (BM25_TERM_FREQUENCY_SATURATION + 1)) / (frequency + BM25_TERM_FREQUENCY_SATURATION * normalization));
    }
    return score;
  });
}

function rendered(turns: readonly ConversationTurn[], labels: { user: string; assistant: string }): string[] {
  return turns.flatMap((turn) => {
    const text = turn.content.replaceAll(/\s+/g, " ").trim();
    return text ? [`${turn.role === "user" ? labels.user : labels.assistant}: ${text}`] : [];
  });
}

const HEADER = "最近对话（此前轮次，按时间序，用于理解追问的指代；当时的聚焦范围可能与当前不同）";

/** 这段历史原样进上下文要占多少字符（折叠判据看的是它，不是渲染后的长度）。 */
export function conversationCharacters(turns: readonly ConversationTurn[]): number {
  return turns.reduce((sum, turn) => sum + turn.content.length, 0);
}

export function renderConversation(input: {
  turns: readonly ConversationTurn[];
  /** 本轮提问：在折叠段里找回被引用内容靠它。 */
  query: string;
  /** 除对话以外本轮已经占用的字符数（系统提示词 + 代码上下文）。 */
  usedCharacters: number;
  /** 本轮分给这段对话的空间；省略 = 按窗口的对话份额算。装不下就折，不等窗口告急。 */
  budgetCharacters?: number;
  labels?: { user: string; assistant: string };
}): ConversationBlock {
  const labels = input.labels ?? { user: "学习者", assistant: "助手" };
  const turns = input.turns.filter((turn) => turn.content.trim());
  if (!turns.length) return { text: "", foldedMessages: 0, recalledMessages: 0 };
  const budget = Math.max(0, input.budgetCharacters ?? contextShare(CONTEXT_SHARE.conversation));
  const history = conversationCharacters(turns);
  const occupancy = (input.usedCharacters + history) / (contextWindowTokens() * CHARS_PER_TOKEN);
  const keepRecent = Math.max(0, HISTORY_KEEP_RECENT_MESSAGES);
  const keepEarliest = Math.max(0, HISTORY_KEEP_EARLIEST_MESSAGES);
  const enoughToFold = turns.length > keepRecent + keepEarliest;
  if (!enoughToFold || (occupancy < HISTORY_COMPACT_AT_RATIO && history <= budget)) {
    return { text: assemble({ front: [], note: [], recalled: [], back: rendered(turns, labels) }, budget), foldedMessages: 0, recalledMessages: 0 };
  }
  const earliest = turns.slice(0, keepEarliest);
  const recent = turns.slice(turns.length - keepRecent);
  const middle = turns.slice(keepEarliest, turns.length - keepRecent);
  const scores = bm25Scores(termsOf(input.query), middle.map((turn) => termsOf(turn.content)));
  const recalled = recalledIndexes(scores).map((index) => middle[index]);
  return {
    text: assemble({
      front: rendered(earliest, labels),
      note: [`…（中间 ${middle.length} 条对话已折叠：需要其中某段原文请直接说明，本轮会按关键词找回。）`],
      recalled: recalled.length
        ? [`折叠段里与本轮提问最相关的 ${recalled.length} 条（词法匹配，未必就是你说的那一条）：`, ...rendered(recalled, labels)]
        : [],
      back: rendered(recent, labels)
    }, budget),
    foldedMessages: middle.length - recalled.length,
    recalledMessages: recalled.length
  };
}

/**
  按「最早几条 → 折叠说明 → 找回的几条 → 最近几条」拼成一段，再按本轮给的空间收口。
  装不下时从最可有可无的那端撤起：先撤开场的最早几条，再撤「最近」里靠前的，
  折叠说明与刚问过的那一条不撤——它们分别是「这段历史少了什么」和「本轮真正要接的话」。
  全撤完还装不下才按字符切尾，并把「是切的」写在明处。
*/
function assemble(lines: { front: string[]; note: string[]; recalled: string[]; back: string[] }, budget: number): string {
  const entries = [
    ...lines.front.map((text) => ({ text, droppable: true })),
    ...lines.note.map((text) => ({ text, droppable: false })),
    ...lines.recalled.map((text) => ({ text, droppable: true })),
    ...lines.back.map((text, index) => ({ text, droppable: index < lines.back.length - 1 }))
  ];
  const kept = entries.filter((entry) => entry.text);
  const block = () => `${HEADER}:\n${kept.map((entry) => entry.text).join("\n")}\n\n`;
  while (kept.length && block().length > budget) {
    const candidate = kept.findIndex((entry) => entry.droppable);
    if (candidate < 0) break;
    kept.splice(candidate, 1);
  }
  if (!kept.length) return "";
  const text = block();
  if (text.length > budget) return `${text.slice(0, budget)}\n…（本轮只装得下 ${budget} 字符的对话，这一段是被切了尾的）`;
  return text;
}

function recalledIndexes(scores: number[]): number[] {
  return scores
    .map((score, index) => ({ index, score }))
    .filter((item) => item.score >= RECALL_MIN_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, RECALLED_MAX_MESSAGES)
    .map((item) => item.index)
    .sort((left, right) => left - right);
}
