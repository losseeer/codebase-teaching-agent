import type { AgentScope, TraceHistory } from "@codebase-tutor/contract";

import { repositoryOr404 } from "../../infrastructure/composition-root.js";
import { settleOrphanedGenerations } from "../runtime/settle-generations.js";
import { buildTraceHistory } from "../runtime/trace-history.js";

const SCOPES = new Set<AgentScope>(["teaching", "map", "practice"]);

/** 读取仓库的回合历史：按 traceId 汇总 journal；不发模型。 */
export function traceHistoryUseCase(repositoryId: string, rawLimit: unknown, rawThreadId: unknown, rawScope?: unknown): TraceHistory | undefined {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return undefined;
  const limit = Math.min(100, Math.max(1, Math.floor(Number(rawLimit) || 20)));
  const threadId = typeof rawThreadId === "string" && rawThreadId.trim() ? rawThreadId.trim() : undefined;
  const scope = typeof rawScope === "string" && SCOPES.has(rawScope as AgentScope) ? rawScope as AgentScope : undefined;
  settleOrphanedGenerations(repository.audit, repositoryId);
  return buildTraceHistory(repository.audit.read(), repository.index.repositoryId, limit, threadId, scope);
}
