import type { RepositoryAnalysis, RepositoryIndex, TeachingPolicy, TutorMessage } from "@codebase-tutor/shared";
import { callNeighborhoodSection } from "../depgraph/neighbors.js";
import { CONTEXT_SHARE, contextShare, contextShareLines } from "../llm/context-window.js";
import { type ConversationTurn, renderConversation } from "../llm/conversation.js";
import { sliceExcerpt } from "../source/excerpt.js";
import { scopeFiles, type ScopeRef } from "../source/scope-ref.js";
import type { EgressCollector } from "../security/egress-log.js";

const EXCERPT_BEFORE = 7;
const EXCERPT_AFTER = 10;
const MAX_EXCERPTS = 3;
const MAX_SCOPE_FILES = 60;
/** 预算分配留白：避免拼接后正好越界触发尾部截断 */
const BUDGET_MARGIN = 200;
/*
  下面几档都从上下文窗口按份额派生（唯一真源在 `llm/context-window.ts`）：
  窗口是唯一手填的数，这里只声明「哪一类内容占多少」。
*/
const maximumCharactersCap = () => contextShare(CONTEXT_SHARE.teachingContext);
/** 符号边界可信上限（行）：超过即只取符号开头（花括号计数得到的 endLine 可能虚高） */
const symbolLineCap = () => contextShareLines(CONTEXT_SHARE.symbolLines);
const excerptBlockCap = () => contextShare(CONTEXT_SHARE.excerptBlock);
/** 对话历史的份额上限：摘录在这一份里保底，长线程不会把源码正文挤光。 */
const excerptReserve = () => contextShare(CONTEXT_SHARE.anchorExcerpts);

/**
 * 有界教学上下文：作用域（文件/目录）+ 调用邻接 + 文件开头的真实源码摘录 + 对话历史。
 * 作用域只决定“从哪儿开始看”，具体事实由依赖图与 static_fact 提供，不再依赖课程树。
 * 历史怎么进上下文由 `llm/conversation.ts` 判（装得下就整段原文，装不下折成最近几条 + 最早几条 + 占位）。
 */
export interface TeachingContextInput {
  scope: ScopeRef;
  policy: TeachingPolicy;
  history: TutorMessage[];
  /** 本轮提问：历史被折叠时按它从折叠段里词法找回被引用的那几条。 */
  query?: string;
  repositoryPath?: string;
  index?: RepositoryIndex;
  /** 依赖图：提供时注入「调用关系」（跨文件调用方/被调方 + 同文件符号位置）——只给路径清单，不给源码 */
  analysis?: RepositoryAnalysis;
  maximumCharacters?: number;
  /** 出网登记：本函数把哪几段源码放进上下文，就往后推几条；由真要发请求的调用方在发出前计入审计。 */
  egress?: EgressCollector;
  /** 对话历史的折叠读数往这里落一份：回合审计要回答「这条回复是在看过几条历史的前提下写的」。 */
  conversationAudit?: { foldedMessages: number; recalledMessages: number };
}

/** 对话块只吃学习者与导师两类；TutorMessage 还留着 `system` 位，出现了就不进这段历史。 */
function learnerTurns(history: TutorMessage[]): ConversationTurn[] {
  return history.flatMap((message) => (message.role === "system" ? [] : [{ role: message.role, content: message.content }]));
}

export function assembleContext(input: TeachingContextInput): string {
  const maximumCharacters = input.maximumCharacters ?? maximumCharactersCap();
  const { scope, policy } = input;
  const files = input.index ? scopeFiles(scope, input.index) : [];
  const listed = files.slice(0, MAX_SCOPE_FILES).map((file) => file.path);
  const head = [
    `当前作用域: ${scope.kind === "file" ? "文件" : "目录"} ${scope.path}`,
    scope.kind === "dir" ? `目录内已分析文件（${files.length}）：\n${listed.join("\n") || "（空）"}${files.length > MAX_SCOPE_FILES ? `\n…其余 ${files.length - MAX_SCOPE_FILES} 个未列出` : ""}` : "",
    `风格约束: ${policy.constraints.join("；")}`,
    input.analysis && files[0] ? callNeighborhoodSection(input.analysis, files[0].path) : ""
  ].filter(Boolean);
  const headCharacters = head.join("\n\n").length;
  const conversationBudget = Math.max(0, maximumCharacters - headCharacters - excerptReserve() - BUDGET_MARGIN);
  const block = renderConversation({
    turns: learnerTurns(input.history),
    query: input.query ?? "",
    usedCharacters: headCharacters,
    budgetCharacters: conversationBudget,
    labels: { user: "学习者", assistant: "导师" }
  });
  if (input.conversationAudit) {
    input.conversationAudit.foldedMessages = block.foldedMessages;
    input.conversationAudit.recalledMessages = block.recalledMessages;
  }
  const conversation = block.text.trimEnd();
  const excerptBudget = Math.max(0, maximumCharacters - headCharacters - conversation.length - BUDGET_MARGIN);
  const excerpts = input.repositoryPath ? sourceExcerpts(input.repositoryPath, files.map((file) => file.path), excerptBudget, input.egress) : "";
  const joined = [...head, excerpts, conversation].filter(Boolean).join("\n\n");
  return joined.length > maximumCharacters
    ? `${joined.slice(0, maximumCharacters)}\n…（上下文超出 ${maximumCharacters} 字符上限已截断）`
    : joined;
}

function sourceExcerpts(repositoryPath: string, paths: string[], budget: number, egress?: EgressCollector): string {
  const selected = paths.slice(0, MAX_EXCERPTS);
  if (!selected.length) return "";
  if (budget < BUDGET_MARGIN) {
    return `源码摘录：超出上下文预算已省略（${selected.join("、")}），需要时用 read_file 查看。`;
  }
  const perBlock = Math.min(excerptBlockCap(), Math.floor(budget / selected.length));
  const blocks: string[] = [];
  for (const path of selected) {
    const slice = sliceExcerpt(repositoryPath, { path, line: 1 }, { before: EXCERPT_BEFORE, after: EXCERPT_AFTER, maxSymbolLines: symbolLineCap(), maxChars: perBlock });
    if (!slice) continue;
    const numbered = slice.lines.map((item) => `${item.line}: ${item.text}`).join("\n");
    const note = slice.truncated ? `\n…（摘录已截断，符号到第 ${slice.symbolEnd ?? slice.to} 行；需要其余部分用 read_file 查看）` : "";
    egress?.push({ kind: "anchor-excerpt", path: slice.path, from: slice.from, to: slice.to, text: numbered, masked: slice.masked, truncated: slice.truncated || undefined });
    blocks.push(`--- ${slice.path}:${slice.from}-${slice.to} ---\n${numbered}${note}`);
  }
  return blocks.length ? `源码摘录（文件开头的真实代码）:\n${blocks.join("\n")}` : "";
}
