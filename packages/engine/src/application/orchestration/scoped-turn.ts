import type { ChatScope } from "@codebase-tutor/contract";

import { externalToolSurface } from "../../adapter/outbound/integrations/clients.js";
import { listSkills, readSkill, skillsBriefing } from "../../adapter/outbound/integrations/skills.js";
import { checkTurnInvariants, invariantTailNotice, screenReply } from "../runtime/turn-invariants.js";
import { dedupeFileReads } from "../../source/read-file.js";
import type { ExternalToolContext, SkillsToolContext } from "../../source/tool-loop.js";
import { traceEngine } from "@codebase-tutor/platform";
import type { ScopedChatResult, ScopedChatTurn } from "../../turn/run-turn.js";
import type { LlmProvider } from "../port/llm-provider.js";
import { turnTextPayload } from "@codebase-tutor/domain";
import { screenNotice } from "../runtime/turn-invariants.js";
import type { ImportedRepository } from "../../importer/importer.js";
import type { AuditSink } from "../port/audit-sink.js";
import type { ChatStore } from "../port/chat-store.js";
import { mcpCallPayload } from "../runtime/turn-audit.js";
import { CHECKPOINT_TTL_MS } from "../runtime/turn-checkpoint.js";

/** 一次作用域回合的收尾：线程上下文取数、正文落库、不变量复检、审计线记账。 */

/** 作用域回合的线程上下文：核归属后从库里取历史；`threadId` 缺席即单次提问。 */
export function scopedThreadTurn(repository: ImportedRepository, threadId: string | undefined, scope: ChatScope): { threadId: string | undefined; history: ScopedChatTurn[] } | undefined {
  if (!threadId) return { threadId: undefined, history: [] };
  const thread = scopedThread(repository, threadId, scope);
  if (!thread) return undefined;
  return { threadId: thread.id, ...threadScopedHistory(repository.chatStore, thread.id) };
}

/** 回合正文落库（用户问 + 助手答，全文不截断）；与 journal 的 `turn_text` 是双写。 */
export function persistScopedTurn(store: ChatStore, scene: "map_chat" | "practice_chat", threadId: string | undefined, question: string, answer: string): void {
  if (!threadId) return;
  if (store.appendMessages(threadId, [{ role: "user", content: question }, { role: "assistant", content: answer }])) return;
  traceEngine("degrade", { what: "turn_body_dropped", scene, thread_id: threadId });
  console.warn(`[engine] ${scene} 这一轮的正文没能写进线程 ${threadId}（线程已被删除或库写不动）；journal 的 turn_text 仍在，产品线缺这一行`);
}

/** 运行期不变量复检：合格也记一条 `turn_invariant`；引用核不上时在正文尾部补一行明示。 */
export function recheckTurn(input: {
  repository: ImportedRepository;
  journal: AuditSink;
  sessionId?: string;
  scene: "teach" | "map_chat" | "practice_chat";
  /** 本回合引擎给出的对端路径（裸路径 → 总行数）；核验只认登记过的。 */
  crossFiles?: Map<string, number>;
  question: string;
  answer: string;
  style?: number;
}): { answer: string; failed: string[] } {
  const screened = screenReply(input.answer);
  const verdict = checkTurnInvariants({
    sessionId: input.sessionId ?? "unscoped",
    at: new Date().toISOString(),
    question: input.question,
    answer: screened.text,
    style: input.style ?? 0,
    answerTruncated: false,
    scene: input.scene
  }, new Map<string, number>([...input.repository.index.files.map((file) => [file.path, file.lines] as [string, number]), ...(input.crossFiles ?? [])]));
  input.journal.append("turn_invariant", {
    scene: input.scene,
    applicable: verdict.applicable.join("、") || null,
    failed: verdict.failed.join("、") || null,
    evidence: Object.entries(verdict.evidence).map(([id, text]) => `${id}=${text}`).join(" ｜ ") || null,
    // 过筛只记数量与样例，不记原文。
    masked_secrets: screened.secrets || null,
    masked_paths: screened.paths || null,
    masked_samples: screened.samples.join("、") || null
  }, input.sessionId);
  const notice = `${screenNotice(screened) ?? ""}${invariantTailNotice(verdict) ?? ""}`;
  return { answer: notice ? `${screened.text}${notice}` : screened.text, failed: verdict.failed };
}

/** map_chat 回合的统一收尾：复检 → 正文落库 → 审计线，三处读同一份文本。 */
export function finishMapChatTurn(repository: ImportedRepository, provider: LlmProvider, threadId: string | undefined, question: string, result: ScopedChatResult, crossFiles: Map<string, number>): void {
  const journal = repository.audit;
  // 中断的回合没有成品：不复检、不落正文，但已经发生的账照记。
  const interrupted = Boolean(result.interrupted);
  if (!interrupted) {
    result.reply = recheckTurn({ repository, journal, sessionId: threadId, scene: "map_chat", question, answer: result.reply, crossFiles }).answer;
    if (result.asked) result.asked = { ...result.asked, question: screenReply(result.asked.question).text, options: result.asked.options.map((option) => screenReply(option).text) };
    persistScopedTurn(repository.chatStore, "map_chat", threadId, question, result.reply);
  }

  if (result.asked) journal.append("turn_asked", turnAskedPayload({ facet: result.asked.facet, outcome: "asked", options: result.asked.options.join(" / "), toolCallId: result.asked.toolCallId }), threadId);
  else if (result.askRefused) journal.append("turn_asked", turnAskedPayload({ outcome: "refused", reason: result.askRefused }), threadId);
  if (result.askClaimed) journal.append("turn_asked", turnAskedPayload({ outcome: result.askClaimed.outcome === "claimed" ? "claimed" : "discarded", reason: result.askClaimed.outcome === "claimed" ? null : "claim_missed", toolCallId: result.askClaimed.toolCallId }), threadId);
  if (result.usage) journal.append("token_usage", {
    input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
    cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map_chat"
  }, threadId);
  for (const read of dedupeFileReads(result.fileReads ?? [])) {
    journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, masked: read.masked ?? 0, error: read.error ?? null }, threadId);
  }

  for (const search of result.codeSearches ?? []) {
    journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、"), segmented: search.segmented === true }, threadId);
  }
  // 失败的外部调用也要入账。
  for (const call of result.mcpCalls ?? []) journal.append("mcp_call", mcpCallPayload(call), threadId);
  for (const skill of result.skillReads ?? []) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, threadId);
  journal.append("loop_round", {
    scene: "map_chat",
    tool_rounds: result.toolRounds,
    tool_reads: (result.fileReads ?? []).length,
    tool_searches: (result.codeSearches ?? []).length,
    tool_external: (result.mcpCalls ?? []).length,
    tool_skills: (result.skillReads ?? []).length,
    ...(result.resumedFromRound === undefined ? {} : { resumed_from_round: result.resumedFromRound }),
    ...(result.stoppedBy === undefined ? {} : { stopped_by: result.stoppedBy })
  }, threadId);
  journal.append("turn_context", { scene: "map_chat", conversation_folded: result.conversation.foldedMessages, conversation_recalled: result.conversation.recalledMessages }, threadId);
  if (!interrupted) journal.append("turn_text", turnTextPayload("map_chat", question, result.reply), threadId);
}

/** `turn_asked` 的一份形状；只许加 outcome 取值，不许各调用点自拼字段。 */
export function turnAskedPayload(input: {
  facet?: string | null;
  outcome: "asked" | "refused" | "claimed" | "discarded";
  options?: string | null;
  reason?: string | null;
  toolCallId?: string | null;
}): Record<string, string | null> {
  return {
    scene: "map_chat",
    facet: input.facet ?? null,
    outcome: input.outcome,
    options: input.options ?? null,
    reason: input.reason ?? null,
    tool_call_id: input.toolCallId ?? null
  };
}

/** 这条线程尾部连续提问的回合数；只数有成品的回合。 */
export function consecutiveAskedTurns(events: readonly { type: string; payload: Record<string, unknown> }[]): number {
  let streak = 0;
  let askedInTurn = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "turn_asked" && event.payload.outcome === "asked") askedInTurn = true;
    else if (event.type === "turn_text") {
      if (!askedInTurn) break;
      streak += 1;
      askedInTurn = false;
    }
  }
  return streak;
}

/** 结算不会再被回答的提问：各记一条 `discarded` 并删行。 */
export function settleStaleAsks(repository: ImportedRepository, journal: AuditSink, threadId: string | undefined, resumingToolCallId?: string): void {
  if (!threadId) return;
  const database = repository.handle.pin();
  let settled: { pendingToolCallId: string; cause: "expired" | "new_question" }[];
  try {
    settled = database.checkpoints.settleAsks(threadId, "map.chat", Date.now() - CHECKPOINT_TTL_MS, resumingToolCallId);
  } finally {
    repository.handle.unpin();
  }
  for (const ask of settled) journal.append("turn_asked", turnAskedPayload({ outcome: "discarded", reason: ask.cause, toolCallId: ask.pendingToolCallId }), threadId);
}

/** 本轮的技能通道；没装技能时回 `undefined`，不加占位说明。 */
export function skillsForTurn(): SkillsToolContext | undefined {
  const load = listSkills();
  const brief = skillsBriefing(load.skills);
  if (!brief) return undefined;
  if (load.skipped.length) traceEngine("degrade", { what: "skill_skipped", skipped: load.skipped.map((item) => `${item.dir}：${item.reason}`).join("、") });
  return { brief, bodyOf: (name, file) => readSkill(name, file) };
}

/** 本轮的外部 MCP 工具面；默认关，连不上时不给工具而不是报错。 */
export async function externalForTurn(): Promise<ExternalToolContext | undefined> {
  const surface = await externalToolSurface();
  if (!surface?.tools.length) return undefined;
  return { tools: surface.tools, call: surface.call };
}

/** 技能与外部工具面一次取齐；都缺省时回空对象。 */
export async function externalAndSkills(): Promise<{ skills?: SkillsToolContext; external?: ExternalToolContext }> {
  const skills = skillsForTurn();
  const external = await externalForTurn();
  return { ...(skills ? { skills } : {}), ...(external ? { external } : {}) };
}

/** 线程正文 → 本轮历史：整段返回，取多少条由 `llm/conversation.ts` 按窗口占用决定。 */
export function threadScopedHistory(store: ChatStore, threadId: string | undefined): { history: ScopedChatTurn[] } {
  const messages = threadId ? store.readMessages(threadId) : [];
  return { history: messages.map((message) => ({ role: message.role, content: message.content })) };
}

/** 取线程并核归属：不在库里、已软删、属于别的仓或别的作用域一律 `undefined`。 */
export function scopedThread(repository: ImportedRepository, threadId: string | undefined, scope: ChatScope) {
  if (!threadId) return undefined;
  const thread = repository.chatStore.getThread(threadId);
  if (!thread || thread.repositoryId !== repository.index.repositoryId || thread.scope !== scope) return undefined;
  return thread;
}
