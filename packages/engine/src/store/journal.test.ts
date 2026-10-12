import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal, isEngineOwnedEventType, isUiJournalEventType, readJournal } from "./journal.js";
import { turnTextPayload, TURN_TEXT_LIMIT } from "../lib.js";
import { runWithTrace } from "../trace/context.js";
import { ENGINE_JOURNAL_EVENTS, UI_JOURNAL_EVENTS, type JournalEventType } from "@codebase-tutor/shared";

/**
  学习日志：append-only、白名单在**运行时**（`eventTypes`），不是只靠编译期类型。
  现在这张白名单由 shared 的两张「写入权表」并起来生成，所以老那条评论担心的事（往 union 加取值却忘了
  同步运行期 Set）已经结构性消失；剩下要守的是**谁有资格写**：
  审计线的引擎侧类型不能从界面接口进来（§46），否则「哪些代码出过门」这条账谁都能填。
  */

describe("学习日志", () => {
  let repository: string;

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-journal-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  it("UI 侧事件（设计文档第 8 章契约）能写入并读回", () => {
    const journal = new Journal(repository, "repo_1");
    // 清单取 shared 那张表，不在测试里另抄一份：以前抄的那份漏了 module_tier_overridden
    for (const type of UI_JOURNAL_EVENTS) journal.append(type, { where: "/api/x" });

    const events = readJournal(repository);
    expect(events.map((event) => event.type)).toEqual([...UI_JOURNAL_EVENTS]);
    expect(events.every((event) => event.repositoryId === "repo_1")).toBe(true);
  });

  it("白名单由两张表并起来；接口只收界面侧那一份，引擎侧类型只能由引擎自己 append", () => {
    const journal = new Journal(repository, "repo_1");
    // 引擎侧类型照旧能写（那是内部路径），但**不在这条接口的受理范围**里
    journal.append("code_egress", { scene: "map.chat", kind: "anchor-excerpt", path: "a.ts", lines: "1-2", chars: 2, hash: "abcdef123456" });
    journal.append("token_usage", { scene: "teach", input_tokens: 10 });
    expect(readJournal(repository)).toHaveLength(2);

    expect(isUiJournalEventType("file_opened")).toBe(true);
    expect(isUiJournalEventType("code_egress")).toBe(false);   // 被审计的一方不能自己填「哪些代码出过门」
    expect(isUiJournalEventType("token_usage")).toBe(false);
    expect(isUiJournalEventType("not_a_real_event")).toBe(false);
    expect(isEngineOwnedEventType("code_egress")).toBe(true);
    expect(isEngineOwnedEventType("not_a_real_event")).toBe(false); // 未知 ≠ 引擎专属，拒绝理由要分得清
    // 两张表并起来就是 append 的全集：漏归表的话这里直接抛
    for (const type of [...ENGINE_JOURNAL_EVENTS, ...UI_JOURNAL_EVENTS]) expect(() => journal.append(type, {})).not.toThrow();
    expect(() => journal.append("not_a_real_event" as JournalEventType, {})).toThrow("Unknown journal event: not_a_real_event");
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
