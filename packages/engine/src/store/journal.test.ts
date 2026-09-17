import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal, isJournalEventType, readJournal } from "./journal.js";
import { runWithTrace } from "../trace/context.js";
import type { JournalEventType } from "@codebase-tutor/shared";

/**
  学习日志：append-only、白名单在**运行时**（`eventTypes`），不是只靠编译期类型。
  这组用例守的就是「往 shared 的 JournalEventType 加取值却忘了同步运行时 Set」——
  那种漏同步在编译期看不出来，只会在用户点下按钮时抛 `Unknown journal event`。
  */

describe("学习日志", () => {
  let repository: string;

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-journal-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  it("UI 侧事件（设计文档第 8 章契约）能写入并读回", () => {
    const journal = new Journal(repository, "repo_1");
    const uiTypes: JournalEventType[] = [
      "flow_node_selected", "file_anchored", "file_opened", "line_located", "module_switched", "exercise_submitted", "repository_switched"
    ];
    for (const type of uiTypes) journal.append(type, { where: "/api/x" });

    const events = readJournal(repository);
    expect(events.map((event) => event.type)).toEqual(uiTypes);
    expect(events.every((event) => event.repositoryId === "repo_1")).toBe(true);
  });

  it("白名单外的类型直接抛错（不静默丢弃，也不写坏日志）", () => {
    const journal = new Journal(repository, "repo_1");
    expect(isJournalEventType("flow_node_selected")).toBe(true);
    expect(isJournalEventType("not_a_real_event")).toBe(false);
    expect(() => journal.append("not_a_real_event" as JournalEventType, {})).toThrow("Unknown journal event: not_a_real_event");
    expect(readJournal(repository)).toHaveLength(0);
  });

  it("traceId 默认取请求上下文；后台任务与显式传 null 都记 null", () => {
    const journal = new Journal(repository, "repo_1");
    runWithTrace("req-5", () => journal.append("file_opened", { path: "a.ts" }));
    journal.append("file_opened", { path: "b.ts" });
    journal.append("file_opened", { path: "c.ts" }, "session-1", null);

    const events = readJournal(repository);
    expect(events.map((event) => [event.traceId, event.payload.path])).toEqual([
      ["req-5", "a.ts"],
      [null, "b.ts"],
      [null, "c.ts"]
    ]);
    expect(events[2]?.sessionId).toBe("session-1");
  });

  it("append-only：既有事件不因新事件而改写", () => {
    const journal = new Journal(repository, "repo_1");
    const first = journal.append("file_opened", { path: "a.ts" });
    journal.append("file_opened", { path: "b.ts" });
    const lines = readFileSync(join(repository, ".tutor", "journal.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual(first);
  });
});
