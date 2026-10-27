import type { TurnScene } from "@codebase-tutor/contract";

import { importer } from "../infrastructure/composition-root.js";
import { dedupeFileReads, type FileReadRecord } from "../source/read-file.js";
import type { LlmUsage } from "./port/llm-provider.js";
import type { AuditSink } from "./port/audit-sink.js";
import type { CodeSearchRecord } from "../source/search-code.js";
import { toolLoopAuditsOf, type ToolLoopAudits } from "../source/tool-loop.js";
import type { McpCallAudit } from "../adapter/outbound/integrations/clients.js";

/**
  回合的审计线写法（谁看过什么、调过哪些外部工具）。放在应用层而不是 HTTP 层：
  中止的回合也要记账，这条判据与传输无关，三作用域的 SSE 收尾与 `failScopedTurn` 共用同一份实现。
*/

/** 没走完的回合（用户停止或端点报错）也要落的那一发账：钱已经花了，账上不能没有。 */
function appendUsage(journal: AuditSink, input: { provider: string; scene: TurnScene; threadId?: string; outcome: "aborted" | "failed"; usage?: LlmUsage }): void {
  const usage = input.usage;
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return;
  journal.append("token_usage", {
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    cache_hit_tokens: usage.promptCacheHitTokens ?? null, provider: input.provider, scene: input.scene, outcome: input.outcome
  }, input.threadId);
}

/** `mcp_call` 一行的形状（三作用域与讲评共用）。 */
export function mcpCallPayload(call: McpCallAudit): Record<string, string | number | boolean | null> {
  return { server: call.server, tool: call.tool, args_chars: call.argsChars, args_hash: call.argsHash, result_chars: call.resultChars, masked: call.masked, ok: call.ok, ms: call.ms, ...(call.error ? { error: call.error } : {}) };
}

/** 回合返回值里那几组审计的形状（三作用域共用；字段缺失时补空数组）。 */
export function auditsFromResult(result: { fileReads?: FileReadRecord[]; codeSearches?: CodeSearchRecord[]; skillReads?: { skill: string; chars: number; found: boolean }[]; mcpCalls?: McpCallAudit[]; toolRounds?: number; usage?: LlmUsage }): ToolLoopAudits {
  return { fileReads: result.fileReads ?? [], codeSearches: result.codeSearches ?? [], skillReads: result.skillReads ?? [], mcpCalls: result.mcpCalls ?? [], rounds: result.toolRounds ?? 0, usage: result.usage };
}

/**
  没走完的回合（用户停止或端点报错）的旁证：成品作废，但「读过哪些文件、搜过什么、调过哪些外部工具」
  与「已经花掉的 token」都是已发生的事实，照旧落审计线并标来源。
*/
export function recordUnfinishedTurn(input: { repositoryPath: string; repositoryId: string; scene: TurnScene; provider: string; outcome: "aborted" | "failed"; threadId?: string; audits?: ToolLoopAudits }): void {
  const audits = input.audits;
  const journal = importer.audit(input.repositoryPath, input.repositoryId);
  appendUsage(journal, { ...input, usage: audits?.usage });
  if (!audits || (!audits.fileReads.length && !audits.codeSearches.length && !audits.skillReads.length && !audits.mcpCalls.length)) return;
  for (const read of dedupeFileReads(audits.fileReads)) {
    journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, masked: read.masked ?? 0, error: read.error ?? null }, input.threadId);
  }
  for (const search of audits.codeSearches) {
    journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、"), segmented: search.segmented === true }, input.threadId);
  }
  for (const call of audits.mcpCalls) journal.append("mcp_call", mcpCallPayload(call), input.threadId);
  for (const skill of audits.skillReads) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, input.threadId);
  journal.append("loop_round", { scene: input.scene, aborted: input.outcome === "aborted", outcome: input.outcome, tool_rounds: audits.rounds, tool_reads: audits.fileReads.length, tool_searches: audits.codeSearches.length, tool_external: audits.mcpCalls.length, tool_skills: audits.skillReads.length }, input.threadId);
}

export { toolLoopAuditsOf, type ToolLoopAudits };
