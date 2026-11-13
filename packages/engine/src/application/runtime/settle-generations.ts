/** 没有终态事件的出题记录按「已中断」收口；仍在跑的任务跳过。 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { JournalEvent } from "@codebase-tutor/domain";

import type { AuditLine } from "../port/audit-sink.js";
import { isGenerationActive } from "./generation-registry.js";

const TERMINALS = new Set(["exercise_generated", "exercise_declined", "exercise_aborted"]);
/** 无开始事件的历史记录：最后一趟模型回复后静默这么久才收口，避免误伤正在跑的任务。 */
const LEGACY_QUIET_MS = 30 * 60 * 1000;

interface LoggedUsage { input: number; output: number; model: string }

/** 工作日志按轨迹汇总已发生的用量；日志缺失时返回空，不伪造零用量。 */
function usageFromEngineLog(traceId: string, logPath: string | undefined = join(homedir(), ".codebase-tutor", "llm.log")): LoggedUsage | undefined {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return undefined;
  }
  const usage: LoggedUsage = { input: 0, output: 0, model: "" };
  for (const line of text.split("\n")) {
    if (!line || !line.includes(traceId)) continue;
    try {
      const row = JSON.parse(line) as { traceId?: string; scene?: string; inputTokens?: number; outputTokens?: number; model?: string };
      if (row.traceId !== traceId || !(row.scene ?? "").startsWith("practice.generate")) continue;
      usage.input += row.inputTokens ?? 0;
      usage.output += row.outputTokens ?? 0;
      if (!usage.model && row.model) usage.model = row.model;
    } catch {
      continue;
    }
  }
  return usage.input || usage.output ? usage : undefined;
}

function appendTerminal(
  audit: AuditLine,
  group: readonly JournalEvent[],
  startedAt: string,
  traceId: string | null,
  jobId: string | null,
  tag: string,
  logPath?: string
): void {
  audit.append("exercise_aborted", {
    scene: "practice.generate",
    reason: "interrupted",
    job_id: jobId,
    tag,
    started_at: startedAt
  }, undefined, traceId);
  if (!traceId || group.some((event) => event.type === "token_usage")) return;
  const usage = usageFromEngineLog(traceId, logPath);
  if (!usage) return;
  audit.append("token_usage", {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_hit_tokens: null,
    provider: usage.model,
    scene: "exercise_generate_code",
    outcome: "interrupted"
  }, undefined, traceId);
}

export function settleOrphanedGenerations(audit: AuditLine, repositoryId: string, logPath?: string): number {
  const events = [...audit.read()].sort((left, right) => left.at.localeCompare(right.at));
  const starts = events.flatMap((event, index) => event.type === "exercise_started" ? [index] : []);
  let settled = 0;
  for (const [position, index] of starts.entries()) {
    const started = events[index];
    const next = starts[position + 1] ?? events.length;
    const group = events.slice(index, next);
    if (group.some((event) => TERMINALS.has(event.type))) continue;
    const jobId = started.payload.job_id;
    if (typeof jobId === "string" && isGenerationActive(repositoryId, jobId)) continue;
    appendTerminal(audit, group, started.at, started.traceId ?? null,
      typeof jobId === "string" ? jobId : null,
      typeof started.payload.tag === "string" ? started.payload.tag : "", logPath);
    settled += 1;
  }

  // 修复前的出题没有开始事件：按轨迹里出现过模型回复、但整组没有任何终态来收口。
  const byTrace = new Map<string, JournalEvent[]>();
  const firstReply = new Map<string, JournalEvent>();
  for (const event of events) {
    if (!event.traceId) continue;
    const list = byTrace.get(event.traceId) ?? [];
    list.push(event);
    byTrace.set(event.traceId, list);
    if (event.type !== "exercise_model_reply") continue;
    const first = firstReply.get(event.traceId);
    if (!first || event.at < first.at) firstReply.set(event.traceId, event);
  }
  for (const [traceId, first] of firstReply) {
    const group = byTrace.get(traceId) ?? [];
    if (group.some((event) => TERMINALS.has(event.type) || event.type === "exercise_started")) continue;
    if (Date.now() - Date.parse(first.at) < LEGACY_QUIET_MS) continue;
    appendTerminal(audit, group, first.at, traceId, null, "", logPath);
    settled += 1;
  }
  return settled;
}
