/** 没有终态事件的出题记录按「已中断」收口；仍在跑的任务跳过。 */
import type { JournalEvent } from "@codebase-tutor/domain";

import type { AuditLine } from "../port/audit-sink.js";
import { isGenerationActive } from "./generation-registry.js";

const TERMINALS = new Set(["exercise_generated", "exercise_declined", "exercise_aborted"]);
/** 无开始事件的历史记录：最后一趟模型回复后静默这么久才收口，避免误伤正在跑的任务。 */
const LEGACY_QUIET_MS = 30 * 60 * 1000;

export function settleOrphanedGenerations(audit: AuditLine, repositoryId: string): number {
  const events = [...audit.read()].sort((left, right) => left.at.localeCompare(right.at));
  const starts = events.flatMap((event, index) => event.type === "exercise_started" ? [index] : []);
  let settled = 0;
  for (const [position, index] of starts.entries()) {
    const started = events[index];
    const next = starts[position + 1] ?? events.length;
    if (events.slice(index + 1, next).some((event) => TERMINALS.has(event.type))) continue;
    const jobId = started.payload.job_id;
    if (typeof jobId === "string" && isGenerationActive(repositoryId, jobId)) continue;
    audit.append("exercise_aborted", {
      scene: "practice.generate",
      reason: "interrupted",
      job_id: typeof jobId === "string" ? jobId : null,
      tag: typeof started.payload.tag === "string" ? started.payload.tag : "",
      started_at: started.at
    }, undefined, started.traceId);
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
    audit.append("exercise_aborted", {
      scene: "practice.generate",
      reason: "interrupted",
      job_id: null,
      tag: "",
      started_at: first.at
    }, undefined, traceId);
    settled += 1;
  }
  return settled;
}
