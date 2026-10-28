import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal, journalFootprint, readJournal } from "./journal.js";
import { runWithTrace } from "@codebase-tutor/platform";
import { ENGINE_JOURNAL_EVENTS, UI_JOURNAL_EVENTS, isEngineOwnedEventType, isUiJournalEventType, turnTextPayload, TURN_TEXT_LIMIT, type JournalEventType } from "@codebase-tutor/domain";

/** 学习日志：append-only，写入白名单在运行时由 domain 的两张表判定。 */

describe("学习日志", () => {
  let repository: string;

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-journal-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  it("UI 侧事件（契约取自 shared 那张事件表）能写入并读回", () => {
    const journal = new Journal(repository, "repo_1");
    for (const type of UI_JOURNAL_EVENTS) journal.append(type, { where: "/api/x" });

    const events = readJournal(repository);
    expect(events.map((event) => event.type)).toEqual([...UI_JOURNAL_EVENTS]);
    expect(events.every((event) => event.repositoryId === "repo_1")).toBe(true);
  });

  it("白名单由两张表并起来；接口只收界面侧那一份，引擎侧类型只能由引擎自己 append", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("code_egress", { scene: "map.chat", kind: "anchor-excerpt", path: "a.ts", lines: "1-2", chars: 2, hash: "abcdef123456" });
    journal.append("token_usage", { scene: "teach", input_tokens: 10 });
    expect(readJournal(repository)).toHaveLength(2);

    expect(isUiJournalEventType("file_opened")).toBe(true);
    expect(isUiJournalEventType("code_egress")).toBe(false);
    expect(isUiJournalEventType("token_usage")).toBe(false);
    expect(isUiJournalEventType("not_a_real_event")).toBe(false);
    expect(isEngineOwnedEventType("code_egress")).toBe(true);
    expect(isEngineOwnedEventType("not_a_real_event")).toBe(false);
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

  it("practice_chat 场景标签原样落盘（读侧按场景分列要用它）", () => {
    new Journal(repository, "repo_1").append("turn_text", turnTextPayload("practice_chat", "这题我这么写对吗", "思路对，边界再想想。"));
    expect(readJournal(repository)[0]?.payload.scene).toBe("practice_chat");
  });
});

/** 增量读缓存：追加、半行、等长改写、截断四种形态各自钉住。 */
describe("增量读缓存：只在文件真的变了时才多读", () => {
  let repository: string;
  const file = () => join(repository, ".tutor", "journal.jsonl");

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-journal-read-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  it("读过后又追加的行，下一次读得到（水位往前推，旧行不重复）", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { scene: "teach", input_tokens: 1 });
    journal.append("token_usage", { scene: "teach", input_tokens: 2 });
    expect(readJournal(repository).map((event) => event.payload.input_tokens)).toEqual([1, 2]);
    journal.append("token_usage", { scene: "teach", input_tokens: 3 });
    expect(readJournal(repository).map((event) => event.payload.input_tokens)).toEqual([1, 2, 3]);
  });

  it("最后半行（没写完）不算事件；补完那一行才出现，且只出现一次", () => {
    new Journal(repository, "repo_1").append("token_usage", { scene: "teach", input_tokens: 7 });
    mkdirSync(join(repository, ".tutor"), { recursive: true });
    const half = JSON.stringify({ id: "x", type: "token_usage", at: "2026-10-18T00:00:00.000Z", repositoryId: "repo_1", payload: { scene: "teach", input_tokens: 8 } });
    appendFileSync(file(), half.slice(0, 40), "utf8");
    expect(readJournal(repository)).toHaveLength(1);
    // 补完剩余字节并加换行收尾
    appendFileSync(file(), `${half.slice(40)}\n`, "utf8");
    const events = readJournal(repository);
    expect(events.map((event) => event.payload.input_tokens)).toEqual([7, 8]);
  });

  it("长度一格没变但内容被原地改写：靠 mtime 认出来，不拿旧事件做账", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("turn_text", turnTextPayload("teach", "甲", "回复一"));
    journal.append("turn_text", turnTextPayload("teach", "乙", "回复二"));
    expect(readJournal(repository).map((event) => event.payload.question)).toEqual(["甲", "乙"]);
    // 等长改写：「丙」与「甲」同为 3 字节，文件长度不变
    const rewritten = readFileSync(file(), "utf8").replace("甲", "丙");
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(readFileSync(file(), "utf8")));
    writeFileSync(file(), rewritten, "utf8");
    // 显式推后 mtime
    const stamp = new Date(Date.now() + 1_000);
    utimesSync(file(), stamp, stamp);
    expect(readJournal(repository).map((event) => event.payload.question)).toEqual(["丙", "乙"]);
  });

  it("文件被截短（换仓、手工清账）：整份重读，不拿旧前缀续新尾巴", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { scene: "teach", input_tokens: 1 });
    journal.append("token_usage", { scene: "teach", input_tokens: 2 });
    journal.append("token_usage", { scene: "teach", input_tokens: 3 });
    expect(readJournal(repository)).toHaveLength(3);
    writeFileSync(file(), `${JSON.stringify({ id: "k", type: "token_usage", at: "2026-10-18T00:00:00.000Z", repositoryId: "repo_1", payload: { scene: "teach", input_tokens: 9 } })}\n`, "utf8");
    expect(readJournal(repository).map((event) => event.payload.input_tokens)).toEqual([9]);
  });

  it("坏行跳过也算读过：不会每次重读同一行，也不会卡住后面的好行", () => {
    mkdirSync(join(repository, ".tutor"), { recursive: true });
    appendFileSync(file(), '{"this is not json}\n', "utf8");
    new Journal(repository, "repo_1").append("token_usage", { scene: "teach", input_tokens: 1 });
    expect(readJournal(repository).map((event) => event.payload.input_tokens)).toEqual([1]);
    expect(readJournal(repository).map((event) => event.payload.input_tokens)).toEqual([1]);
  });

  it("给调用方的是数组拷贝：谁 sort/splice 一下不会弄坏缓存", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { scene: "teach", input_tokens: 1 });
    journal.append("token_usage", { scene: "teach", input_tokens: 2 });
    const first = readJournal(repository);
    first.reverse();
    first.splice(0, 1);
    expect(readJournal(repository).map((event) => event.payload.input_tokens)).toEqual([1, 2]);
  });

  it("journal 体量读数：行数与解析出的事件数一致，字节数取文件的实际长度", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { scene: "teach", input_tokens: 1 });
    journal.append("token_usage", { scene: "teach", input_tokens: 2 });
    const footprint = journalFootprint(repository);
    expect(footprint.lines).toBe(2);
    expect(footprint.bytes).toBe(statSync(file()).size);
    expect(journalFootprint(join(repository, "没有这个目录"))).toEqual({ lines: 0, bytes: 0 });
  });
});
