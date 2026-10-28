import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMessages, countMessagesRaw, createThread, getThread, listThreads, readMessages, readThreadState, renameThread, saveThreadState, softDeleteThread } from "./chat-store.js";
import { isChatScope } from "@codebase-tutor/contract";

/** 会话持久化出入口的口径用例：软删后读侧看不见，消息行仍在库里。 */

describe("会话持久化", () => {
  let repository: string;

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-chat-store-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  const openThread = (input?: { scope?: "teach" | "map" | "practice"; title?: string; scopeRef?: string }) =>
    createThread({ repositoryPath: repository, repositoryId: "repo_1", scope: input?.scope ?? "map", ...(input?.title ? { title: input.title } : {}), ...(input?.scopeRef ? { scopeRef: input.scopeRef } : {}) });

  it("创建的线程可读回，未给标题时落作用域占位名", () => {
    const thread = openThread({ title: "  秒杀链路怎么走  " });
    expect(getThread(repository, thread.id)?.title).toBe("秒杀链路怎么走");
    expect(openThread({ scope: "practice" }).title).toBe("新的练习对话");
    expect(getThread(repository, "nope")).toBeUndefined();
  });

  it("正文不截断：长回复逐字存回", () => {
    const thread = openThread();
    const long = "结".repeat(5_000);
    expect(appendMessages(repository, thread.id, [{ role: "assistant", content: long }])).toBe(true);
    expect(readMessages(repository, thread.id)[0].content).toHaveLength(5_000);
  });

  it("读侧只给未删线程，且同一回合内 user 在 assistant 前", () => {
    const thread = openThread();
    appendMessages(repository, thread.id, [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答", error: "上游超时" }
    ]);
    const messages = readMessages(repository, thread.id);
    expect(messages.map((message) => message.content)).toEqual(["第一问", "第一答", "第二问", "第二答"]);
    expect(messages[1]).not.toHaveProperty("stage");
    expect(messages[3].error).toBe("上游超时");
  });

  it("尾窗取最近若干条但仍按时间正序返回", () => {
    const thread = openThread();
    appendMessages(repository, thread.id, [1, 2, 3, 4].map((n) => ({ role: "user" as const, content: `问${n}` })));
    appendMessages(repository, thread.id, [{ role: "user", content: "问5" }]);
    expect(readMessages(repository, thread.id, 2).map((message) => message.content)).toEqual(["问4", "问5"]);
    expect(readMessages(repository, thread.id, 99)).toHaveLength(5);
  });

  it("清单只收谈过的会话：新建后没发言的那条不进列表，行留在库里", () => {
    const unsent = openThread({ title: "刚点新建" });
    expect(listThreads(repository, "repo_1", "map").map((thread) => thread.id)).toEqual([]);
    expect(getThread(repository, unsent.id)?.title).toBe("刚点新建");
    appendMessages(repository, unsent.id, [{ role: "user", content: "第一问" }]);
    expect(listThreads(repository, "repo_1", "map").map((thread) => thread.id)).toEqual([unsent.id]);
  });

  it("软删：列表与正文都看不见，但消息行仍在库里", () => {
    const thread = openThread();
    appendMessages(repository, thread.id, [{ role: "user", content: "会被删掉的问题" }]);
    expect(softDeleteThread(repository, thread.id)).toBe(true);

    expect(listThreads(repository, "repo_1", "map")).toEqual([]);
    expect(getThread(repository, thread.id)).toBeUndefined();
    expect(readMessages(repository, thread.id)).toEqual([]);
    expect(countMessagesRaw(repository, thread.id)).toBe(1);
    expect(softDeleteThread(repository, thread.id)).toBe(false);
  });

  it("软删后向该线程写入会被拒绝（不静默丢消息）", () => {
    const thread = openThread();
    softDeleteThread(repository, thread.id);
    expect(appendMessages(repository, thread.id, [{ role: "user", content: "僵尸写入" }])).toBe(false);
    expect(countMessagesRaw(repository, thread.id)).toBe(0);
  });

  it("列表按最近更新在前；改名与按作用域找回", async () => {
    const a = openThread({ title: "A" });
    const b = openThread({ title: "B" });
    appendMessages(repository, a.id, [{ role: "user", content: "a1" }]);
    // updated_at 是毫秒时间戳：同毫秒写入会让排序并列
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendMessages(repository, b.id, [{ role: "user", content: "b1" }]);
    expect(listThreads(repository, "repo_1", "map").map((thread) => thread.title)).toEqual(["B", "A"]);

    const renamed = renameThread(repository, a.id, "  改名后的标题  ");
    expect(renamed?.title).toBe("改名后的标题");
    expect(renameThread(repository, a.id, "   ")).toBeUndefined();

    const teach = createThread({ repositoryPath: repository, repositoryId: "repo_1", scope: "teach", scopeRef: "file:src/main.ts" });
    appendMessages(repository, teach.id, [{ role: "user", content: "教学第一问" }]);
    expect(listThreads(repository, "repo_1", "map").some((thread) => thread.id === teach.id)).toBe(false);
  });

  it("设置快照读写：settings 在场才认，缺它读回 undefined 而不是默认值", () => {
    const thread = openThread({ scope: "teach" });
    const state = { settings: { style: 50, pedagogy: "socratic" as const, depth: "macro" as const } };
    expect(readThreadState(repository, thread.id)).toBeUndefined();
    expect(saveThreadState(repository, thread.id, state)).toBe(true);
    expect(readThreadState(repository, thread.id)).toEqual(state);

    // settings 缺失时读回 undefined，不给默认值
    expect(saveThreadState(repository, thread.id, {} as unknown as typeof state)).toBe(true);
    expect(readThreadState(repository, thread.id)).toBeUndefined();

    // 快照里的多余键读侧忽略，只取 settings
    const legacy = { stage: "verify", fallbackCount: 2, settings: state.settings };
    expect(saveThreadState(repository, thread.id, legacy as unknown as typeof state)).toBe(true);
    expect(readThreadState(repository, thread.id)).toEqual(state);

    softDeleteThread(repository, thread.id);
    // 软删后拒写新快照；已存的那份留在行里
    expect(saveThreadState(repository, thread.id, state)).toBe(false);
    expect(readThreadState(repository, thread.id)).toEqual(state);
  });

  it("scope 守卫只认三个取值", () => {
    expect(["teach", "map", "practice"].every(isChatScope)).toBe(true);
    expect(isChatScope("companion")).toBe(false);
    expect(isChatScope(undefined)).toBe(false);
  });
});
