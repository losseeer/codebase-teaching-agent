import { describe, expect, it } from "vitest";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/shared";
import { findLatestSessionForNode, restoreSessionFromJournal } from "./restore.js";

/**
  会话续命的读侧重放：输入是 journal 里同一 sessionId 的事件序列，输出是可直接续聊的 TutorSession。
  这组用例盯三件事：转录重建的顺序、状态快照取「最后一个」、缺证据时的拒恢复（宁可 404 不编半截状态）。
  */

const event = (type: JournalEventType, payload: JournalEvent["payload"], sessionId: string | undefined, at: string, repositoryId = "repo_a"): JournalEvent =>
  ({ id: `${type}-${at}`, type, at, repositoryId, sessionId, traceId: null, payload });

const teachTurn = (at: string, question: string, answer: string, stage: string, fallbackCount = 0) => [
  event("turn_text", { scene: "teach", question, answer, question_truncated: false, answer_truncated: false }, "s-1", at),
  event("hint_depth", { unit_id: "workflow:src/A.java", depth: 2, stage, fallback_count: fallbackCount, resolved_by: "learner_attempt" }, "s-1", at)
];

describe("restoreSessionFromJournal", () => {
  it("双边转录按时间序重建，状态取最后一回合的快照", () => {
    const events: JournalEvent[] = [
      event("style_shift", { style: 30, pedagogy: "explanatory", depth: "micro", trigger: "session_created" }, "s-1", "2026-09-22T10:00:00.000Z"),
      ...teachTurn("2026-09-22T10:01:00.000Z", "第一问", "第一答", "orient"),
      ...teachTurn("2026-09-22T10:02:00.000Z", "第二问", "第二答", "procedure", 1),
      // 无关噪音：别的会话、别的场景，都不能混进转录
      event("turn_text", { scene: "map_chat", question: "宏观问题", answer: "宏观回答", question_truncated: false, answer_truncated: false }, undefined, "2026-09-22T10:03:00.000Z"),
      event("style_shift", { style: 50, pedagogy: "socratic", depth: "macro", trigger: "session_created" }, "s-2", "2026-09-22T10:04:00.000Z")
    ];
    const session = restoreSessionFromJournal(events, "s-1");
    expect(session).toBeDefined();
    expect(session?.id).toBe("s-1");
    expect(session?.repositoryId).toBe("repo_a");
    expect(session?.courseNodeId).toBe("workflow:src/A.java");
    expect(session?.stage).toBe("procedure");
    expect(session?.fallbackCount).toBe(1);
    expect(session?.settings).toEqual({ style: 30, pedagogy: "explanatory", depth: "micro" });
    expect(session?.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "第一问"], ["assistant", "第一答"], ["user", "第二问"], ["assistant", "第二答"]
    ]);
    expect(session?.createdAt).toBe("2026-09-22T10:00:00.000Z");
  });

  it("缺最低证据（无 unit_id 的 hint_depth）→ 拒恢复：turn_text 再全也不挂半截会话", () => {
    const orphan = event("turn_text", { scene: "teach", question: "问", answer: "答", question_truncated: false, answer_truncated: false }, "s-9", "2026-09-22T10:00:00.000Z");
    expect(restoreSessionFromJournal([orphan], "s-9")).toBeUndefined();
    expect(restoreSessionFromJournal([], "s-9")).toBeUndefined();
  });

  it("turn_text 上线前的旧会话（只有 hint_depth）仍恢复状态、转录为空", () => {
    const legacy = event("hint_depth", { unit_id: "workflow:src/A.java", depth: 1, stage: "concept", resolved_by: "learner_attempt" }, "s-3", "2026-09-21T08:00:00.000Z");
    const session = restoreSessionFromJournal([legacy], "s-3");
    expect(session?.messages).toEqual([]);
    expect(session?.stage).toBe("concept");
    expect(session?.fallbackCount).toBe(0); // 旧行没有 fallback_count 字段，保守回 0
  });

  it("脏值不炸：未知 stage 回落 orient，越界取值经 validateSettings 归型", () => {
    const events: JournalEvent[] = [
      event("style_shift", { style: 999, pedagogy: "chaos", depth: "nano", trigger: "manual" }, "s-4", "2026-09-22T10:00:00.000Z"),
      event("hint_depth", { unit_id: "u", depth: 1, stage: "不存在的阶段", fallback_count: -5, resolved_by: "learner_attempt" }, "s-4", "2026-09-22T10:01:00.000Z")
    ];
    const session = restoreSessionFromJournal(events, "s-4");
    expect(session?.stage).toBe("orient");
    expect(session?.fallbackCount).toBe(0);
    expect(session?.style).toBe(100); // validateStyle 夹到 0-100
    expect(session?.settings.pedagogy).toBe("socratic");
    expect(session?.settings.depth).toBe("macro");
  });
});

describe("findLatestSessionForNode", () => {
  it("倒扫 journal 取该节点最近一次教学的 sessionId；别的节点/无 id 的行不算", () => {
    const events: JournalEvent[] = [
      event("hint_depth", { unit_id: "workflow:src/A.java", depth: 1, stage: "orient", resolved_by: "learner_attempt" }, "s-old", "2026-09-22T10:00:00.000Z"),
      event("hint_depth", { unit_id: "workflow:src/B.java", depth: 1, stage: "orient", resolved_by: "learner_attempt" }, "s-other", "2026-09-22T10:01:00.000Z"),
      event("hint_depth", { unit_id: "workflow:src/A.java", depth: 2, stage: "procedure", resolved_by: "learner_attempt" }, "s-new", "2026-09-22T10:02:00.000Z"),
      // 无 sessionId 的 hint_depth（引擎自写但会话外的边角）不能成为找回目标
      event("hint_depth", { unit_id: "workflow:src/A.java", depth: 1, stage: "orient", resolved_by: "learner_attempt" }, undefined, "2026-09-22T10:03:00.000Z")
    ];
    expect(findLatestSessionForNode(events, "workflow:src/A.java")).toBe("s-new");
    expect(findLatestSessionForNode(events, "workflow:src/B.java")).toBe("s-other");
    expect(findLatestSessionForNode(events, "workflow:src/C.java")).toBeUndefined();
    expect(findLatestSessionForNode(events, "")).toBeUndefined();
  });
});
