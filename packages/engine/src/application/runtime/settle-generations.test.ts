import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";
import { describe, expect, it } from "vitest";

import type { AuditLine } from "../port/audit-sink.js";
import { beginGeneration } from "./generation-registry.js";
import { settleOrphanedGenerations } from "./settle-generations.js";

let seq = 0;
function event(type: JournalEventType, payload: JournalEvent["payload"], traceId: string | null = "trace-1"): JournalEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    type,
    at: `2026-11-13T11:00:${String(seq).padStart(2, "0")}.000Z`,
    repositoryId: "repo-1",
    sessionId: undefined,
    traceId,
    payload
  };
}

function audit(initial: JournalEvent[]): AuditLine & { events: JournalEvent[] } {
  const events = [...initial];
  return {
    events,
    read: () => [...events],
    append: (type, payload, sessionId, traceId) => {
      const written = event(type, payload, traceId ?? null);
      written.sessionId = sessionId;
      events.push(written);
      return written;
    }
  };
}

describe("出题终态收口", () => {
  it("开始后没有终态：补一条中断记录并沿用原 traceId", () => {
    const line = audit([event("exercise_started", { scene: "practice.generate", job_id: "job-1", tag: "消息队列" }, "trace-a")]);
    expect(settleOrphanedGenerations(line, "repo-1")).toBe(1);
    const written = line.events.at(-1)!;
    expect(written.type).toBe("exercise_aborted");
    expect(written.payload).toMatchObject({ reason: "interrupted", job_id: "job-1", tag: "消息队列" });
    expect(written.traceId).toBe("trace-a");
  });

  it("重复收口不再补写；已有终态的不补", () => {
    const line = audit([
      event("exercise_started", { scene: "practice.generate", job_id: "job-1", tag: "A" }),
      event("exercise_generated", { source: "code", title: "A" })
    ]);
    expect(settleOrphanedGenerations(line, "repo-1")).toBe(0);
    expect(settleOrphanedGenerations(line, "repo-1")).toBe(0);
    expect(line.events.filter((item) => item.type === "exercise_aborted")).toHaveLength(0);
  });

  it("修复前没有开始事件的旧出题：静默期后按中断收口", () => {
    const old = event("exercise_model_reply", { scene: "practice.generate", attempt: 0 }, "trace-old");
    old.at = "2026-11-13T10:00:00.000Z";
    const line = audit([old]);
    expect(settleOrphanedGenerations(line, "repo-1")).toBe(1);
    expect(line.events.at(-1)).toMatchObject({ type: "exercise_aborted", traceId: "trace-old" });
    expect(settleOrphanedGenerations(line, "repo-1")).toBe(0);
  });

  it("仍在跑的任务不补；两趟里只补后一趟", () => {
    const running = beginGeneration("repo-1", "job-live");
    try {
      const line = audit([
        event("exercise_started", { scene: "practice.generate", job_id: "job-done", tag: "A" }),
        event("exercise_declined", { stage: "no_theme_hits", reason: "x" }),
        event("exercise_started", { scene: "practice.generate", job_id: "job-live", tag: "B" }),
        event("exercise_started", { scene: "practice.generate", job_id: "job-orphan", tag: "C" })
      ]);
      expect(settleOrphanedGenerations(line, "repo-1")).toBe(1);
      expect(line.events.at(-1)?.payload).toMatchObject({ reason: "interrupted", job_id: "job-orphan" });
    } finally {
      running.dispose();
    }
  });
});
