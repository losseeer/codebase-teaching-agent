import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal, isJournalEventType, readJournal } from "./journal.js";
import { turnTextPayload, TURN_TEXT_LIMIT } from "../lib.js";
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
      "flow_node_selected", "file_anchored", "file_opened", "line_located", "module_switched", "exercise_submitted", "repository_switched",
      "entry_adopted", "entry_overridden"
    ];
    for (const type of uiTypes) journal.append(type, { where: "/api/x" });

    const events = readJournal(repository);
    expect(events.map((event) => event.type)).toEqual(uiTypes);
    expect(events.every((event) => event.repositoryId === "repo_1")).toBe(true);
  });

  it("白名单外的类型直接抛错（不静默丢弃，也不写坏日志）", () => {
    const journal = new Journal(repository, "repo_1");
    expect(isJournalEventType("flow_node_selected")).toBe(true);
    expect(isJournalEventType("scope_degraded")).toBe(true); // 引擎侧新事件同样吃这条同步——漏了就只会运行期抛
    expect(isJournalEventType("exercise_generated")).toBe(true);
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

describe("回合文本落盘（turn_text）", () => {
  let repository: string;
  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-journal-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  it("turn_text 在运行时白名单内，能写入并读回", () => {
    expect(isJournalEventType("turn_text")).toBe(true);
    const journal = new Journal(repository, "repo_1");
    journal.append("turn_text", turnTextPayload("map_chat", "这门工程的分层是怎样的？", "分三层：接口、服务、存储。"), "s-1");
    const [event] = readJournal(repository);
    expect(event?.type).toBe("turn_text");
    expect(event?.payload.scene).toBe("map_chat");
    expect(event?.payload.question).toBe("这门工程的分层是怎样的？");
    expect(event?.payload.answer).toBe("分三层：接口、服务、存储。");
    expect(event?.payload.question_truncated).toBe(false);
    expect(event?.payload.answer_truncated).toBe(false);
  });

  it("双边各自截到 2000 字并留痕，未超限侧不误标", () => {
    const long = "长".repeat(TURN_TEXT_LIMIT + 5);
    const payload = turnTextPayload("teach", long, "短回复");
    expect(payload.question).toHaveLength(TURN_TEXT_LIMIT);
    expect(payload.question_truncated).toBe(true);
    expect(payload.answer).toBe("短回复");
    expect(payload.answer_truncated).toBe(false);
  });

  it("practice_chat 场景标签原样落盘（B 档按场景分列的读侧依赖）", () => {
    new Journal(repository, "repo_1").append("turn_text", turnTextPayload("practice_chat", "这题我这么写对吗", "思路对，边界再想想。"));
    expect(readJournal(repository)[0]?.payload.scene).toBe("practice_chat");
  });
});
