import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/domain";

import { createRouteFixture, MAIN_FILE, OK_REPLY, TAIL, sseEvents, deltasOf, doneEvent, waitFor, type RouteFixture } from "../controller-test-kit.js";
import { readMessages } from "../../../outbound/persistence/chat-store.js";
import { TutorDatabase } from "../../../outbound/persistence/database.js";

/**
  宏观设计与练习答疑的回合收尾，含外部能力面、跨仓工具面与出网清单。
  顺序是 recheckTurn → 落库 → 回放；每条路径断言三处文本同一份（响应 == chat_message == journal 的 `turn_text.answer`）。
*/
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

/** map 对话只有 SSE 一条路径：整段回复从 done 帧取。 */
async function mapChat(payload: Record<string, unknown>) {
  const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload });
  if (response.statusCode !== 200) return { statusCode: response.statusCode, payload: response.payload, json: () => response.json() };
  return { statusCode: response.statusCode, payload: response.payload, json: () => doneEvent(sseEvents(response.payload)) };
}

describe("外部能力面进回合：技能与 MCP（默认关，装了才给）", () => {
  const skillsDir = join(fx.root, "skills");
  const fixture = fx.echoServerFixture;

  /** 装一份技能 + 一个 stdio 夹具 server，都指临时目录。 */
  function install(): void {
    mkdirSync(join(skillsDir, "tutor-fixture"), { recursive: true });
    writeFileSync(join(skillsDir, "tutor-fixture", "SKILL.md"), `---
name: tutor-fixture
description: 测试用做法：先看 llm.log 再决定要不要花钱。
---

# 做法

第一步：读 ~/.codebase-tutor/llm.log。
`, "utf8");
    const config = join(fx.root, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], allowedTools: ["echo"] } } }, null, 2), "utf8");
    process.env.TUTOR_SKILLS_DIR = skillsDir;
    process.env.TUTOR_MCP_SETTINGS_FILE = config;
  }

  afterEach(() => {
    delete process.env.TUTOR_SKILLS_DIR;
    delete process.env.TUTOR_MCP_SETTINGS_FILE;
  });

  it("没装时工具清单逐字不变——默认关是靠不加，不是靠开关", async () => {
    // 「没装」= 指向一个空目录，不含家目录技能
    const empty = join(fx.root, "skills-empty");
    mkdirSync(empty, { recursive: true });
    process.env.TUTOR_SKILLS_DIR = empty;
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "没装外部能力");
    const before = fx.sentTools.length;
    await mapChat({ content: "这仓分几层？", threadId });
    expect(fx.sentTools[before].names).toEqual(["read_file", "search_code", "ask_user", "set_diagram", "query_facts"]);
    expect(fx.sentTools[before].raw, "一行产物都没有时，上下文要直接说没有，别让模型自己试出来").toContain("本仓还没有静态产物");
  });

  it("盘上有产物时，那份「在册情况」也真进了请求", async () => {
    const empty = join(fx.root, "skills-empty2");
    mkdirSync(empty, { recursive: true });
    process.env.TUTOR_SKILLS_DIR = empty;
    const database = new TutorDatabase(fx.repoDir);
    try {
      database.facts.save(fx.repositoryId, "cfg", [{ path: "src/main.ts", payload: { path: "src/main.ts", language: "typescript", backend: "ast", version: "test", functions: [] } }]);
    } finally {
      database.close();
    }
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "产物也要能查");
    const before = fx.sentTools.length;
    const response = await mapChat({ content: "这个模块的结构长什么样？", threadId });
    expect(response.statusCode).toBe(200);
    expect(fx.sentTools[before].names).toContain("query_facts");
    expect(fx.sentTools[before].raw, "有这扇门却没告诉模型里面有什么，等于让它去猜有没有产物").toContain("静态产物在册");
  });

  it("装了之后 read_skill 与 mcp__fixture__echo 真并进请求，清单进上下文，两条审计各落一行", async () => {
    install();
    fx.scripted = ['@@tool read_skill {"name":"tutor-fixture"}', '@@tool mcp__fixture__echo {"text":"读到 nothing"}', `清单上的做法第一步是看日志。${MAIN_FILE}:3 有人问先改哪行？`];
    const threadId = await fx.newThread("map", "装了外部能力");
    const before = fx.sentTools.length;
    const response = await mapChat({ content: "按那份做法看一下", threadId });
    expect(response.statusCode).toBe(200);

    expect(fx.sentTools[before].names).toContain("read_skill");
    expect(fx.sentTools[before].names).toContain("mcp__fixture__echo");
    expect(fx.sentTools[before].raw).toContain("tutor-fixture：测试用做法");
    expect(fx.sentTools[before].raw).toContain("别凭名字猜内容");

    expect(fx.sentTools[before + 1].raw).toContain("读 ~/.codebase-tutor/llm.log");
    expect(fx.sentTools[before + 2].raw).toContain("读到 nothing");

    const skill = fx.lastEvent("skill_read");
    expect(skill.payload).toMatchObject({ skill: "tutor-fixture", found: true });
    expect(String(skill.payload.chars)).not.toBe("0");
    const call = fx.lastEvent("mcp_call");
    expect(call.payload).toMatchObject({ server: "fixture", tool: "echo", ok: true });
    expect(JSON.stringify(call.payload)).not.toContain("读到 nothing");

    const loop = fx.lastEvent("loop_round");
    expect(loop.payload).toMatchObject({ tool_external: 1, tool_skills: 1 });
    // 上下文折叠记在 turn_context，不在 loop_round
    expect(fx.lastEvent("turn_context").payload).toMatchObject({ scene: "map_chat", conversation_folded: 0, conversation_recalled: 0 });
  });

  it("练习答疑装了技能：文件面与技能面一起给，取正文后作答并落 skill_read", async () => {
    install();
    fx.scripted = ['@@tool read_skill {"name":"tutor-fixture"}', `按那份做法：${MAIN_FILE}:3 先改这一行。`];
    const threadId = await fx.newThread("practice", "练习带技能", fx.exerciseId);
    const before = fx.sentTools.length;
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/practice-chat`, payload: { content: "这题怎么想？", exerciseId: fx.exerciseId, threadId } });
    expect(response.statusCode).toBe(200);
    expect(fx.sentTools[before].names).toEqual(["read_file", "read_skill"]);
    expect(fx.sentTools[before].raw).toContain("tutor-fixture：测试用做法");
    expect(fx.sentTools[before + 1].raw).toContain("读 ~/.codebase-tutor/llm.log");
    expect(fx.lastEvent("skill_read").payload).toMatchObject({ skill: "tutor-fixture", found: true });
    const frames = sseEvents(response.payload).map((event) => event.type);
    expect(frames, "loading_skill 要在正文之前到").toContain("loading_skill");
  });

  it("练习答疑没装技能：只有文件面，模型不调工具就还是那一趟", async () => {
    const empty = join(fx.root, "skills-empty-practice");
    mkdirSync(empty, { recursive: true });
    process.env.TUTOR_SKILLS_DIR = empty;
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("practice", "练习不装技能", fx.exerciseId);
    const before = fx.sentTools.length;
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/practice-chat`, payload: { content: "这题怎么想？", exerciseId: fx.exerciseId, threadId } });
    expect(response.statusCode).toBe(200);
    expect(fx.sentTools.length, "没有技能就不该多出第二趟").toBe(before + 1);
    expect(fx.sentTools[before].names).toEqual(["read_file"]);
    expect(fx.sentTools[before].raw).not.toContain("可用技能");
  });

  it("GET /api/external 把装了什么、连不上的原因交出来（零 token，读侧不发模型）", async () => {
    install();
    const response = await fx.app.inject({ method: "GET", url: "/api/external" });
    expect(response.statusCode).toBe(200);
    const readout = response.json() as { skills: { name: string }[]; tools: string[]; errors: unknown[]; skillDirectories: string[] };
    expect(readout.skills.map((entry) => entry.name)).toEqual(["tutor-fixture"]);
    expect(readout.tools).toEqual(["mcp__fixture__echo"]);
    expect(readout.errors).toEqual([]);
    expect(readout.skillDirectories).toEqual([skillsDir]);
  });
});

describe("宏观设计作用域（SSE）", () => {
  it("map-chat：合格回合也写 turn_invariant，响应正文＝库里正文＝turn_text", async () => {
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "合格线程");
    const response = await mapChat({ content: "这一节先看哪里？", threadId });
    expect(response.statusCode).toBe(200);
    const reply = (response.json() as { reply: string }).reply;

    const invariant = fx.lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("map_chat");
    expect(invariant.payload.applicable).toBe("reference-grounding");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(threadId);
    // map_chat 只跑引用这一条不变量
    expect(String(invariant.payload.applicable)).not.toContain("socratic-question");

    expect(reply).toBe(OK_REPLY);
    expect(fx.assistantMessage(threadId).content).toBe(reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("map-chat：引用核不上时尾注进正文，落库与审计读的是同一份被补过的文本", async () => {
    fx.scripted = ["见 src/ghost.ts:88，这一步为什么放锁？"];
    const threadId = await fx.newThread("map", "假引用线程");
    const response = await mapChat({ content: "假引用问题", threadId });
    const reply = (response.json() as { reply: string }).reply;

    const invariant = fx.lastEvent("turn_invariant");
    expect(invariant.payload.failed).toBe("reference-grounding");
    expect(String(invariant.payload.evidence)).toContain("src/ghost.ts");

    expect(reply).toContain(TAIL);
    expect(fx.assistantMessage(threadId).content).toBe(reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("map-chat 没绑定模块也带画布写工具，并把画布现场送进上下文", async () => {
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "画布上直接说话");
    fx.sentTools.length = 0;
    const response = await mapChat({ content: "把刚才那条修正撤掉", threadId });
    expect(response.statusCode).toBe(200);
    const call = fx.sentTools[0];
    expect(call?.names, "画布是只读的，结构改动只有 agent 这一条路——不能要求先在左栏点进某个模块").toContain("set_diagram");
    expect(call?.raw, "改图工具必须先看得见现状：有哪几张图、正打开那张的图元 id").toContain("画布现场");

    fx.scripted = [OK_REPLY];
    const practiceThread = await fx.newThread("practice", "对照线程", fx.exerciseId);
    fx.sentTools.length = 0;
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/practice-chat`, payload: { content: "这题怎么想？", exerciseId: fx.exerciseId, threadId: practiceThread } });
    expect(fx.sentTools[0]?.names, "它也不该拿到改这张图的权力：练习那张脸上没有画布，给了就是让用户改自己看不见的东西").not.toContain("set_diagram");
  });

  it("map-chat SSE：delta 拼起来＝done.reply＝库里正文", async () => {
    fx.scripted = [`看 ${MAIN_FILE}:5 的上游，谁先把请求交给它？`];
    const threadId = await fx.newThread("map", "流式线程");
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: "流式问题", threadId } });
    const events = sseEvents(response.payload);
    const reply = String(doneEvent(events).reply);

    expect(deltasOf(events)).toBe(reply);
    expect(fx.assistantMessage(threadId).content).toBe(reply);
    expect(fx.lastEvent("turn_invariant").payload.scene).toBe("map_chat");
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("map-chat SSE：读文件与检索各上一帧，不被下一轮 thinking 吃掉", async () => {
    fx.scripted = ['@@tool search_code {"query":"register"}', '@@tool read_file {"path":"src/main.ts"}', `看 ${MAIN_FILE}:5 的上游。`];
    const threadId = await fx.newThread("map", "过程帧线程");
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: "哪里是入口？", threadId } });
    const frames = sseEvents(response.payload).filter((event) => event.type !== "delta").map((event) => event.type);
    expect(frames).toEqual(["thinking", "searching", "thinking", "reading", "thinking", "done"]);
  });

  it("停止生成：aborted 帧取代 done、正文不落库，journal 只留一行 turn_aborted", async () => {
    fx.scripted = [OK_REPLY];
    fx.holdMs = 300;
    const threadId = await fx.newThread("map", "中止线程");
    // turnId 需为 8~64 位 URL-safe 字符
    const turnId = "abort-test-turn";
    const pending = fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: "这句话会被中止", threadId, turnId } });
    // 等回合登记上再打停止
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stopped = await fx.app.inject({ method: "POST", url: "/api/turns/stop", payload: { turnId } });
    expect(stopped.json()).toMatchObject({ stopped: true, scene: "map_chat" });

    const events = sseEvents((await pending).payload);
    expect(events.some((event) => event.type === "done"), "中止的回合不该回放 done").toBe(false);
    expect(events.some((event) => event.type === "error"), "中止不是错误").toBe(false);
    expect(events.filter((event) => event.type === "delta"), "中止后一帧正文都不该回放").toHaveLength(0);
    const abortedFrame = events.find((event) => event.type === "aborted");
    expect(abortedFrame, "没收到 aborted 帧").toBeDefined();
    expect(abortedFrame).toMatchObject({ type: "aborted", scene: "map_chat" });

    const aborted = fx.lastEvent("turn_aborted");
    expect(aborted.payload).toMatchObject({ scene: "map_chat", turn_id: turnId, aborted_by: "user_stop" });
    expect(aborted.sessionId).toBe(threadId);
    expect(readMessages(fx.repoDir, threadId).some((message) => message.role === "assistant")).toBe(false);
    expect(fx.eventsOf("turn_text").some((event) => event.sessionId === threadId)).toBe(false);
  });

  /** 中止的回合仍要落已发生的工具与调用审计；两种中止落点各测一条。 */
  function expectAbortedAudit(threadId: string, events: Record<string, unknown>[], marker: string): void {
    const reads = fx.eventsOf("file_read").filter((event) => event.sessionId === threadId);
    const allReads = fx.eventsOf("file_read");
    /** 每趟请求里出现的工具返回内容。 */
    const toolReplies = fx.sentTools.filter((entry) => entry.raw.includes(marker)).map((entry) => ["未知工具", "未知仓库", "读文件上限", "跨仓读取最多"].find((word) => entry.raw.includes(word)) ?? (entry.raw.includes("// line 1") ? "读到正文" : "没读到")).join(" | ");
    const scene = `本回合请求 ${fx.requestsOf(marker)} 趟（工具回话：${toolReplies}）/ 脚本剩余 ${fx.scripted.length} 段 / 帧 ${events.map((event) => event.type).join("→")} / journal 里 file_read 共 ${allReads.length} 行（本线程 ${reads.length} 行，线程号 ${[...new Set(allReads.map((event) => String(event.sessionId)))].join(" ") || "无"}）`;
    expect(fx.sentTools.some((entry) => entry.raw.includes(marker) && entry.raw.includes("// line 1")), `第二趟请求里没有 read_file 的回填正文 ⇒ 工具没执行，不是落账问题（${scene}）`).toBe(true);
    expect(events.some((event) => event.type === "aborted"), `没收到 aborted 帧（${scene}）`).toBe(true);
    expect(events.some((event) => event.type === "done"), `中止的回合不该回放 done（${scene}）`).toBe(false);
    expect(events.some((event) => event.type === "error"), `中止不是错误（${scene}）`).toBe(false);
    expect(events.filter((event) => event.type === "delta"), `中止后一帧正文都不该回放（${scene}）`).toHaveLength(0);
    expect(reads.map((event) => event.payload.path), `中止前读过的文件必须留痕（${scene}）`).toEqual([MAIN_FILE]);
    expect(reads[0].payload.denied).toBe(false);
    const loop = fx.eventsOf("loop_round").filter((event) => event.sessionId === threadId);
    expect(loop, `loop_round 应该正好一行（${scene}）`).toHaveLength(1);
    expect(loop[0].payload).toMatchObject({ scene: "map_chat", aborted: true, tool_rounds: 1, tool_reads: 1 });
    expect(fx.eventsOf("turn_text").some((event) => event.sessionId === threadId)).toBe(false);
    expect(readMessages(fx.repoDir, threadId).some((message) => message.role === "assistant")).toBe(false);
    expect(fx.eventsOf("turn_aborted").filter((event) => event.sessionId === threadId)).toHaveLength(1);
  }

  it("① 停止落在最后一趟在途：异常带着本轮读过的文件上来，收尾照样落账", async () => {
    const question = "这句会被中止但要记账·在途";
    fx.scripted = [`@@tool read_file {"path":"${MAIN_FILE}"}`, OK_REPLY];
    // 第二趟留足在途窗口
    fx.holdMs = 1_200;
    const threadId = await fx.newThread("map", "中止补账·在途");
    const turnId = "abort-audit-inflight";
    const pending = fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: question, threadId, turnId } });
    await waitFor(() => fx.requestsOf(question) >= 2, "第一趟回来、read_file 执行完、第二趟请求发出");
    const stopped = await fx.app.inject({ method: "POST", url: "/api/turns/stop", payload: { turnId } });
    expect(stopped.json()).toMatchObject({ stopped: true, scene: "map_chat" });
    expectAbortedAudit(threadId, sseEvents((await pending).payload), question);
  });

  it("② 停止落在最后一趟之后：数组在返回值里，收尾同样落账", async () => {
    const question = "这句答完才发现已经点了停止·收尾";
    fx.scripted = [`@@tool read_file {"path":"${MAIN_FILE}"}`, OK_REPLY];
    const threadId = await fx.newThread("map", "中止补账·收尾");
    const turnId = "abort-audit-late";
    // 停止落在第二趟返回之前
    fx.stopInside = { turnId, marker: question, atCall: 2, seen: 0 };
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: question, threadId, turnId } });
    fx.stopInside = undefined;
    expectAbortedAudit(threadId, sseEvents(response.payload), question);
  });
});

/** 练习答疑：与 map-chat 同款 SSE 收尾，线程绑题、作用域记 practice_chat。 */

describe("练习答疑作用域（SSE）", () => {
  it("practice-chat：复检先于落库与回放，正文三处一致", async () => {
    fx.scripted = [`先跑 ${MAIN_FILE}:3 这条路，你觉得断点打在哪一行？`];
    const threadId = await fx.newThread("practice", "练习线程", fx.exerciseId);
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/practice-chat`, payload: { content: "这题怎么想？", exerciseId: fx.exerciseId, threadId } });
    const events = sseEvents(response.payload);
    const reply = String(doneEvent(events).reply);

    const invariant = fx.lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("practice_chat");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(threadId);

    expect(deltasOf(events)).toBe(reply);
    expect(fx.assistantMessage(threadId).content).toBe(reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("practice-chat：假引用同样吃到尾注，回放与落库都不缺这一行", async () => {
    fx.scripted = ["见 src/nowhere.ts:9，先说结论再解释。"];
    const threadId = await fx.newThread("practice", "练习假引用", fx.exerciseId);
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/practice-chat`, payload: { content: "换个问法", exerciseId: fx.exerciseId, threadId } });
    const events = sseEvents(response.payload);
    const reply = String(doneEvent(events).reply);

    expect(reply).toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(fx.assistantMessage(threadId).content).toBe(reply);
    expect(fx.lastEvent("turn_invariant").payload.failed).toBe("reference-grounding");
  });
});

describe("出字前的本地过筛", () => {
  it("疑似密钥与仓库外路径在 reply、chat_message、turn_text 三处都已隐去", async () => {
    fx.scripted = ["凭据写在 sk-abcdefghijklmnop1234 这里，本机路径 /Users/someone/.ssh/id_rsa 也提一下。你觉得该先看哪一处？"];
    const threadId = await fx.newThread("map", "过筛线程");
    const response = await mapChat({ content: "这段配置安全吗？", threadId });
    expect(response.statusCode).toBe(200);
    const reply = (response.json() as { reply: string }).reply;
    expect(reply).toContain("[疑似密钥，已隐去]");
    expect(reply).toContain("[仓库外路径，已隐去]");
    // 改写过的正文要显式标注
    expect(reply).toContain("已被隐去");
    expect(reply).not.toContain("sk-abcdefghijklmnop");
    expect(reply).not.toContain("someone");
    expect(fx.assistantMessage(threadId).content).toContain("[疑似密钥，已隐去]");
    const text = fx.lastEvent("turn_text");
    expect(text.payload.answer).not.toContain("sk-abcdefghijklmnop");
    const invariant = fx.lastEvent("turn_invariant");
    expect(invariant.payload.masked_secrets).toBe(1);
    expect(invariant.payload.masked_paths).toBe(1);
  });
});

describe("回合内向用户提问（问句即成品，点选项才接着算）", () => {
  it("问句就是本轮成品：一次调用、done 带候选与认领句柄、三处文本同一份、审计记 asked", async () => {
    fx.scripted = ['@@tool ask_user {"facet":"range","question":"这张图画哪一块？","options":["整仓","下单那条"]}'];
    const threadId = await fx.newThread("map", "提问线程");
    const before = fx.sentTools.length;
    const response = await mapChat({ content: "画张架构图", threadId });
    const done = response.json() as { reply: string; asked?: { facet: string; question: string; options: string[]; toolCallId: string } };
    expect(fx.sentTools.length - before, "提问即收尾：不该再发第二次调用").toBe(1);
    expect(done.reply).toBe("这张图画哪一块？\n可选项：整仓 / 下单那条");
    expect(done.asked).toEqual({ facet: "range", question: "这张图画哪一块？", options: ["整仓", "下单那条"], toolCallId: expect.any(String) });
    expect(fx.assistantMessage(threadId).content).toBe(done.reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(done.reply);
    expect(fx.lastEvent("turn_asked").payload).toMatchObject({ scene: "map_chat", facet: "range", outcome: "asked", options: "整仓 / 下单那条", tool_call_id: done.asked?.toolCallId });
  });

  it("点了选项就是认领：答句回灌成那条调用的回执，只发这一趟，审计记 claimed", async () => {
    fx.scripted = ['@@tool ask_user {"facet":"range","question":"这张图画哪一块？","options":["整仓","下单那条"]}', "整仓三层：接口层、服务层、存储层。"];
    const threadId = await fx.newThread("map", "认领线程");
    const first = (await mapChat({ content: "画张架构图", threadId })).json() as { asked?: { toolCallId: string } };
    const askId = first.asked?.toolCallId ?? "";
    const before = fx.sentTools.length;
    const done = (await mapChat({ content: "整仓", threadId, resumeAsk: askId })).json() as { reply: string };
    expect(fx.sentTools.length - before, "接上那一轮就只发这一趟：已读过的上下文从快照里回来，不重付一遍").toBe(1);
    const messages = JSON.parse(fx.sentTools[before].raw).messages as { role: string; tool_call_id?: string; content?: string }[];
    expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: askId, content: "整仓" });
    expect(messages.find((message) => message.role === "user")?.content, "首轮那条装了代码上下文的 user 消息不能因认领而丢").toContain("学习者的问题：画张架构图");
    expect(done.reply).toBe("整仓三层：接口层、服务层、存储层。");
    expect(fx.lastEvent("turn_asked").payload).toMatchObject({ outcome: "claimed", tool_call_id: askId, facet: null, options: null });
    expect(fx.lastEvent("loop_round").payload).toMatchObject({ resumed_from_round: 1 });
    expect(fx.assistantMessage(threadId).content).toBe(done.reply);
  });

  it("换了问题就是另一回合：等回答的快照不参与哈希续跑，那句提问记一条 discarded", async () => {
    fx.scripted = ['@@tool ask_user {"facet":"range","question":"这张图画哪一块？","options":["整仓","下单那条"]}', "先看 src/main.ts:3 的 registerOrder。"];
    const threadId = await fx.newThread("map", "改问线程");
    const first = (await mapChat({ content: "画张架构图", threadId })).json() as { asked?: { toolCallId: string } };
    const before = fx.sentTools.length;
    await mapChat({ content: "那这个函数是入口吗", threadId });
    expect(JSON.parse(fx.sentTools[before].raw).messages.filter((message: { role: string }) => message.role === "user")[0].content).toContain("那这个函数是入口吗");
    const discarded = fx.eventsOf("turn_asked").filter((event) => event.payload.outcome === "discarded");
    expect(discarded.map((event) => event.payload)).toEqual([{ scene: "map_chat", facet: null, outcome: "discarded", options: null, reason: "new_question", tool_call_id: first.asked?.toolCallId }]);
  });

  it("认不上就当新回合答：记 discarded(claim_missed)，不报错也不空转（换模型与过期都走这一档）", async () => {
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "认不上线程");
    const done = (await mapChat({ content: "画张图", threadId, resumeAsk: "call_这条线程上没有这句" })).json() as { reply: string };
    expect(done.reply).toContain("registerOrder");
    expect(fx.lastEvent("turn_asked").payload).toMatchObject({ outcome: "discarded", reason: "claim_missed", tool_call_id: "call_这条线程上没有这句" });
    expect(fx.lastEvent("loop_round").payload, "没认领上就没有「续自第几轮」这回事").not.toHaveProperty("resumed_from_round");
  });

  it("范围已知就不给这个通道：画布绑定了文件，清单里没有 ask_user", async () => {
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "已选范围");
    fx.sentTools.length = 0;
    const response = await mapChat({ content: "这个模块分几层？", threadId, path: MAIN_FILE });
    expect(response.statusCode).toBe(200);
    expect(fx.sentTools[0].names, "范围已经在请求体里了，再问一次就是把用户已经答过的话重问一遍").not.toContain("ask_user");
  });

  it("候选太长就挡下：回合照旧答完，审计记 refused 与因由", async () => {
    fx.scripted = ['@@tool ask_user {"facet":"range","question":"画哪一块？","options":["把整条下单链路和它的异步任务都画上"]}', "那就先画整仓三层。"];
    const threadId = await fx.newThread("map", "挡下线程");
    const response = await mapChat({ content: "画张图", threadId });
    expect((response.json() as { reply: string }).reply).toBe("那就先画整仓三层。");
    const refused = fx.lastEvent("turn_asked");
    expect(refused.payload.outcome).toBe("refused");
    expect(String(refused.payload.reason)).toContain("按钮放不下");
    expect(refused.payload.facet ?? null, "没问成的尝试不该报出一格 facet").toBe(null);
  });

  it("问句里的疑似密钥在正文与候选两处都隐去：按钮不是第二条通路", async () => {
    fx.scripted = ['@@tool ask_user {"facet":"goal","question":"凭据写在 sk-abcdefghijklmnop1234，先看哪层？","options":["接口层","服务层"]}'];
    const threadId = await fx.newThread("map", "过筛提问");
    const done = (await mapChat({ content: "这仓的凭据在哪？", threadId })).json() as { reply: string; asked?: { question: string; options: string[] } };
    expect(done.reply).toContain("[疑似密钥，已隐去]");
    expect(done.reply).not.toContain("sk-abcdefghijklmnop");
    expect(done.asked?.question).toContain("[疑似密钥，已隐去]");
    expect(done.asked?.question).not.toContain("sk-abcdefghijklmnop");
    expect(fx.lastEvent("turn_asked").payload.options).toBe("接口层 / 服务层");
  });
});

describe("到限中断（只有宏观设计这一档会走到）", () => {
  it("到限中断：没有成品就不落正文，done 只带原因，轮数读数照记", async () => {
    // 夹具脚本用完后重复最后一条，因此每轮都有工具调用
    fx.scripted = ['@@tool search_code {"query":"zzz-不存在"}'];
    const threadId = await fx.newThread("map", "中断线程");
    const response = await mapChat({ content: "画张整仓的架构图", threadId });
    const done = response.json() as { reply?: string; interrupted?: { reason: string; detail: string } };
    expect(done.interrupted?.reason).toBe("rounds");
    expect("reply" in done, "空回复与「这一轮没有回复」是两件事：后者不能让界面落一条空气泡").toBe(false);
    expect(fx.eventsOf("turn_text").filter((event) => event.sessionId === threadId), "中断的一轮没有成品可落").toHaveLength(0);
    expect(fx.lastEvent("loop_round").payload.stopped_by).toBe("rounds");
    await fx.verifyLlmLog({ expectAborted: false, scenes: ["map.chat"] });
  });
});

/** 跨仓能力只在工具面上出现：挂了第二个仓才给 `cross_repo_link` 与仓名。 */

describe("跨仓工具面随地址簿变", () => {
  it("有第二个仓才给 cross_repo_link 与 repo 参数；没有时清单不变", async () => {
    const registryFile = process.env.TUTOR_REGISTRY_FILE;
    expect(registryFile).toBeTruthy();
    const original = readFileSync(registryFile!, "utf8");
    const peerDir = join(fx.root, "peer-repo");
    mkdirSync(peerDir, { recursive: true });
    const threadId = await fx.newThread("map", "跨仓工具面");
    const ask = () => mapChat({ content: "这个请求打到哪个仓去了？", threadId });

    try {
      fx.sentTools.length = 0;
      expect((await ask()).statusCode).toBe(200);
      const alone = fx.sentTools[fx.sentTools.length - 1];
      expect(alone.names).toContain("search_code");
      expect(alone.names).not.toContain("cross_repo_link");
      expect(alone.raw).not.toContain("peer-repo");

      writeFileSync(registryFile!, `${JSON.stringify({ repositories: [fx.repoDir, peerDir] }, null, 2)}\n`, "utf8");
      fx.sentTools.length = 0;
      expect((await ask()).statusCode).toBe(200);
      const withPeer = fx.sentTools[fx.sentTools.length - 1];
      expect(withPeer.names).toContain("cross_repo_link");
      // 仓名要出现在 read_file/search_code 的参数说明里
      expect(withPeer.raw).toContain("peer-repo");
    } finally {
      writeFileSync(registryFile!, original, "utf8");
      rmSync(peerDir, { recursive: true, force: true });
    }
  });
});
/**
  源码出网清单（`code_egress`）：装配里真放了源码的那次调用才计入。
  行里只有指纹，没有源码正文。
*/

describe("源码出网清单", () => {
  const egress = () => fx.eventsOf("code_egress");
  const sentFields = (row: JournalEvent) => Object.keys(row.payload).sort();

  it("宏观设计回合：锚点摘录逐段计入审计，带线程 id，且不含源码正文", async () => {
    const before = egress().length;
    const threadId = await fx.newThread("map", "出网线程");
    const response = await mapChat({ content: "这一节先看哪里？", threadId, path: MAIN_FILE });
    expect(response.statusCode).toBe(200);

    const rows = egress().slice(before);
    expect(rows.length, "锚点附近的源码摘录应逐段记入审计").toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payload).toMatchObject({ scene: "map.chat", kind: "anchor-excerpt", path: MAIN_FILE });
      expect(String(row.payload.hash)).toMatch(/^[0-9a-f]{12}$/);
      expect(Number(row.payload.chars)).toBeGreaterThan(0);
      expect(row.sessionId).toBe(threadId);
      // 锚点第 3 行的源码正文就是 "// line 3"，审计行里不能出现它
      expect(JSON.stringify(row)).not.toContain("// line 3");
    }
    expect(sentFields(rows[0])).toEqual(["chars", "hash", "kind", "lines", "path", "scene"]);
  });

  it("装配里没有源码时一行都不落（文件清单是派生产物，不算源码出网）", async () => {
    const before = egress().length;
    const threadId = await fx.newThread("map", "无源码出网线程");
    const response = await mapChat({ content: "这个项目整体是做什么的？", threadId });
    expect(response.statusCode).toBe(200);
    expect(egress().slice(before)).toEqual([]);
  });

  it("教学回合：只剩措辞那一趟调用，同一段摘录就只记一次（撤掉动作提议前的两次出网已成历史）", async () => {
    const created = await fx.app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId: fx.repositoryId, scopeRef: `file:${MAIN_FILE}` } });
    const sessionId = (created.json() as { session: { id: string } }).session.id;
    fx.usedThreads.add(sessionId);
    const before = egress().length;
    fx.scripted = [`registerOrder 在 ${MAIN_FILE}:3 先跑，你觉得少了哪一步会先炸？`];
    const response = await fx.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    expect(response.statusCode).toBe(200);

    const rows = egress().slice(before);
    const scenes = new Set(rows.map((row) => row.payload.scene));
    expect([...scenes].sort()).toEqual(["teaching.turn"]);
    for (const scene of scenes) expect(rows.filter((row) => row.payload.scene === scene).map((row) => row.payload.path)).toContain(MAIN_FILE);
    expect(rows.every((row) => row.sessionId === sessionId)).toBe(true);
    expect(rows.some((row) => JSON.stringify(row).includes("// line 3"))).toBe(false);
  });
});

/** llm.log 逐行核对，前提是挂载中的产物没被 `.env` 写入换掉。 */
describe("LLM 工作日志的账面一致性", () => {
  it("每次 provider 调用追加一行，threadId 与本文件用过的线程全等，失败只允许是中止", async () => {
    await fx.verifyLlmLog({ expectAborted: true, scenes: ["map.chat", "practice.chat"] });
  });
});
