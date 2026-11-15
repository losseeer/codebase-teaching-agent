import { describe, expect, it } from "vitest";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";

import { buildTraceHistory } from "./trace-history.js";

const event = (id: string, type: JournalEventType, payload: Record<string, string | number | boolean | null>, traceId?: string): JournalEvent => ({
  id, type, payload,
  at: "2026-11-15T12:00:00.000Z", repositoryId: "repo_1", sessionId: "s-1",
  ...(traceId ? { traceId } : {})
});

describe("轨迹回放与消息删除", () => {
  it("被删消息对应的那一趟轨迹不再出现", () => {
    const turn = event("e-turn", "turn_text", { scene: "teach", question: "问", answer: "答" }, "trace-1");
    const deleted = event("e-del", "message_deleted", { thread_id: "s-1", message_ids: "m-1", trace_event_id: "e-turn" });
    expect(buildTraceHistory([turn], "repo_1", 20).runs).toHaveLength(1);
    expect(buildTraceHistory([turn, deleted], "repo_1", 20).runs).toHaveLength(0);
  });

  it("删除别趟的消息不影响这一趟", () => {
    const turn = event("e-turn", "turn_text", { scene: "teach", question: "问", answer: "答" }, "trace-1");
    const deleted = event("e-del", "message_deleted", { thread_id: "s-1", message_ids: "m-2", trace_event_id: "e-other" });
    expect(buildTraceHistory([turn, deleted], "repo_1", 20).runs).toHaveLength(1);
  });
});
