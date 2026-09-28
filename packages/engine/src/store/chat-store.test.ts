import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMessages, countMessagesRaw, createThread, getThread, isChatScope, latestThreadForNode, listThreads, readMessages, readThreadState, renameThread, saveThreadState, softDeleteThread } from "./chat-store.js";

/**
  会话持久化出入口（产品数据线）的口径用例。

  核心不变量：**产品删除是软的**——软删后列表与正文读侧都看不见，但消息行必须还在库里。
  这条如果破了，「删除会话」就会连带吃掉审计与裁判的输入源（journal 那条线本就不该被动，
  而 chat_message 是 B 档评测将来可能的真源）。其余用例守的是读侧过滤、尾窗方向与顺序。
  */

describe("会话持久化", () => {
  let repository: string;

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-chat-store-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  const openThread = (input?: { scope?: "teach" | "map" | "practice"; title?: string; courseNodeId?: string }) =>
    createThread({ repositoryPath: repository, repositoryId: "repo_1", scope: input?.scope ?? "map", ...(input?.title ? { title: input.title } : {}), ...(input?.courseNodeId ? { courseNodeId: input.courseNodeId } : {}) });

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
      { role: "assistant", content: "第一答", stage: "procedure" },
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答", error: "上游超时" }
    ]);
    const messages = readMessages(repository, thread.id);
    expect(messages.map((message) => message.content)).toEqual(["第一问", "第一答", "第二问", "第二答"]);
    expect(messages[1].stage).toBe("procedure");
    expect(messages[3].error).toBe("上游超时");
  });

  it("尾窗取最近若干条但仍按时间正序返回", () => {
    const thread = openThread();
    appendMessages(repository, thread.id, [1, 2, 3, 4].map((n) => ({ role: "user" as const, content: `问${n}` })));
    appendMessages(repository, thread.id, [{ role: "user", content: "问5" }]);
    expect(readMessages(repository, thread.id, 2).map((message) => message.content)).toEqual(["问4", "问5"]);
    expect(readMessages(repository, thread.id, 99)).toHaveLength(5);
  });

  it("软删：列表与正文都看不见，但消息行仍在库里", () => {
    const thread = openThread();
    appendMessages(repository, thread.id, [{ role: "user", content: "会被删掉的问题" }]);
    expect(softDeleteThread(repository, thread.id)).toBe(true);

    expect(listThreads(repository, "repo_1", "map")).toEqual([]);
    expect(getThread(repository, thread.id)).toBeUndefined();
    expect(readMessages(repository, thread.id)).toEqual([]);
    // 原文没被产品删除动过——这条是本轮的核心判据
    expect(countMessagesRaw(repository, thread.id)).toBe(1);
    // 第二次删同一条：没有未删线程可改，路由据此回 404
    expect(softDeleteThread(repository, thread.id)).toBe(false);
  });

  it("软删后向该线程写入会被拒绝（不静默丢消息）", () => {
    const thread = openThread();
    softDeleteThread(repository, thread.id);
    expect(appendMessages(repository, thread.id, [{ role: "user", content: "僵尸写入" }])).toBe(false);
    expect(countMessagesRaw(repository, thread.id)).toBe(0);
  });

  it("列表按最近更新在前；改名与按节点找回", async () => {
    const a = openThread({ title: "A" });
    const b = openThread({ title: "B" });
    appendMessages(repository, a.id, [{ role: "user", content: "a1" }]);
    // updated_at 是毫秒时间戳：不留间隔的话两次写入同毫秒，排序并列就成了掷硬币
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendMessages(repository, b.id, [{ role: "user", content: "b1" }]);
    expect(listThreads(repository, "repo_1", "map").map((thread) => thread.title)).toEqual(["B", "A"]);

    const renamed = renameThread(repository, a.id, "  改名后的标题  ");
    expect(renamed?.title).toBe("改名后的标题");
    expect(renameThread(repository, a.id, "   ")).toBeUndefined();

    const teach = createThread({ repositoryPath: repository, repositoryId: "repo_1", scope: "teach", courseNodeId: "node_x" });
    appendMessages(repository, teach.id, [{ role: "user", content: "教学第一问" }]);
    expect(latestThreadForNode(repository, "repo_1", "node_x")?.id).toBe(teach.id);
    expect(latestThreadForNode(repository, "repo_1", "node_missing")).toBeUndefined();
    // 作用域隔离：map 的列表里不会混进教学会话
    expect(listThreads(repository, "repo_1", "map").some((thread) => thread.id === teach.id)).toBe(false);
  });

  it("状态快照读写：字段齐才认，缺字段读回 undefined 而不是默认值", () => {
    const thread = openThread({ scope: "teach" });
    const state = { stage: "verify" as const, fallbackCount: 2, settings: { style: 50, pedagogy: "socratic" as const, depth: "macro" as const } };
    expect(readThreadState(repository, thread.id)).toBeUndefined();
    expect(saveThreadState(repository, thread.id, state)).toBe(true);
    expect(readThreadState(repository, thread.id)).toEqual(state);

    // 「没记」不能伪装成默认值：调用方要靠 undefined 判定这轮没有可续的状态
    expect(saveThreadState(repository, thread.id, { stage: "not_a_stage", fallbackCount: 0, settings: state.settings } as unknown as typeof state)).toBe(true);
    expect(readThreadState(repository, thread.id)).toBeUndefined();
    expect(saveThreadState(repository, thread.id, { stage: "orient", fallbackCount: -1, settings: state.settings })).toBe(true);
    expect(readThreadState(repository, thread.id)).toBeUndefined();

    softDeleteThread(repository, thread.id);
    expect(saveThreadState(repository, thread.id, state)).toBe(false);
    expect(readThreadState(repository, thread.id)).toBeUndefined();
  });

  it("scope 守卫只认三个取值", () => {
    expect(["teach", "map", "practice"].every(isChatScope)).toBe(true);
    expect(isChatScope("companion")).toBe(false);
    expect(isChatScope(undefined)).toBe(false);
  });
});
