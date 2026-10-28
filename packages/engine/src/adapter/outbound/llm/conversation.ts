/** 对话历史进上下文前的压缩：占用达 `HISTORY_COMPACT_AT_RATIO` 或超出本轮空间时，只留最早与最近若干条，中间换成占位行。
    本轮提问在折叠段上算 BM25，命中的原文追在占位行后面。 */
import { CHARS_PER_TOKEN, CONTEXT_SHARE, contextShare, contextWindowTokens } from "./context-window.js";
import { segmentForLookup, wordsOf } from "@codebase-tutor/platform";

export interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** 窗口占用达到这个比例就开始折叠对话。 */
export const HISTORY_COMPACT_AT_RATIO = 0.8;
/** 折叠后完整保留的最近条数。 */
export const HISTORY_KEEP_RECENT_MESSAGES = 6;
/** 折叠后完整保留的最早条数。 */
export const HISTORY_KEEP_EARLIEST_MESSAGES = 2;
/** 找回条数上限。 */
const RECALLED_MAX_MESSAGES = 3;
/** 找回的 BM25 相关度下限。 */
const RECALL_MIN_SCORE = 1.2;
const BM25_TERM_FREQUENCY_SATURATION = 1.2;
const BM25_LENGTH_NORMALIZATION = 0.75;

export interface ConversationBlock {
  /** 直接拼进请求的那一段；没有可用历史时为空串。 */
  text: string;
  /** 被折掉的条数，不含找回的。 */
  foldedMessages: number;
  /** 从折叠段按词法相关度找回的条数。 */
  recalledMessages: number;
}

/** 词元：ASCII 按 camelCase 与标点切词，中文按二分词窗口。 */
function termsOf(text: string): string[] {
  const terms: string[] = [];
  for (const chunk of segmentForLookup(text).split(/\s+/)) {
    if (!chunk) continue;
    if (/^[\x00-\x7F]+$/.test(chunk)) terms.push(...wordsOf(chunk));
    else if (chunk.length >= 2) terms.push(chunk);
  }
  return terms;
}

/** Okapi BM25：一条消息当一篇文档。 */
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

/** 这段历史原样进上下文占的字符数。 */
export function conversationCharacters(turns: readonly ConversationTurn[]): number {
  return turns.reduce((sum, turn) => sum + turn.content.length, 0);
}

export function renderConversation(input: {
  turns: readonly ConversationTurn[];
  /** 本轮提问，用于折叠段的关键词找回。 */
  query: string;
  /** 除对话以外本轮已占用的字符数。 */
  usedCharacters: number;
  /** 本轮分给这段对话的空间；省略 = 按窗口的对话份额算。 */
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

/** 按「最早 → 折叠说明 → 找回 → 最近」拼成一段；超预算时先撤可撤的行，再按字符切尾。 */
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
