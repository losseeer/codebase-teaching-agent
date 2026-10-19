import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/shared";
import { createRouteFixture, MAIN_FILE, OK_REPLY, TAIL, sseEvents, deltasOf, doneEvent, waitFor, type RouteFixture } from "./route-test-kit.js";
import { readMessages } from "../../store/chat-store.js";
import { TutorDatabase } from "../../store/database.js";

/**
  宏观设计 / 练习答疑两条作用域的回合收尾，以及喂进回合的外部能力面、跨仓工具面与出网清单。
  要守的顺序是 recheckTurn → 落库 → 回放：谁把顺序换回去，落库正文和学习者看到的正文就会差那行尾注。
  每条路径都断言三件事：不抛错、`turn_invariant` 一定落 journal（合格也记，分母才成立）、
  三处文本同一份（响应/回放正文 == chat_message 正文 == journal 的 `turn_text.answer`）。
  假 provider 与临时仓由 `route-test-kit.ts` 提供，零 token。
 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("外部能力面进回合：技能与 MCP（默认关，装了才给）", () => {
  const skillsDir = join(fx.root, "skills");
  const fixture = fx.echoServerFixture;

  /** 装一份技能 + 一个 stdio 夹具 server（都指临时目录，`~/.codebase-tutor` 一个字都不碰）。 */
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
    // 「没装」指确实空着的目录：不指这个变量时加载器会去家目录那两处，
    // 于是这台机器装过什么就决定了这条用例断言什么
    const empty = join(fx.root, "skills-empty");
    mkdirSync(empty, { recursive: true });
    process.env.TUTOR_SKILLS_DIR = empty;
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "没装外部能力");
    const before = fx.sentTools.length;
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "这仓分几层？", threadId } });
    // 这个夹具仓是手捏出来的产物（没跑过分析），`static_fact` 一行都没有，所以那条只读门也不该出现
    expect(fx.sentTools[before].names).toEqual(["read_file", "search_code", "set_architecture", "set_diagram"]);
  });

  it("盘上有产物时 query_facts 才进清单，那份「在册情况」也真进了请求", async () => {
    const empty = join(fx.root, "skills-empty2");
    mkdirSync(empty, { recursive: true });
    process.env.TUTOR_SKILLS_DIR = empty;
    const database = new TutorDatabase(fx.repoDir);
    try {
      database.saveFileFacts(fx.repositoryId, "cfg", [{ path: "src/main.ts", payload: { path: "src/main.ts", language: "typescript", backend: "ast", version: "test", functions: [] } }]);
    } finally {
      database.close();
    }
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "产物也要能查");
    const before = fx.sentTools.length;
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "这个模块的结构长什么样？", threadId } });
    expect(response.statusCode).toBe(200);
    expect(fx.sentTools[before].names).toContain("query_facts");
    expect(fx.sentTools[before].raw, "有这扇门却没告诉模型里面有什么，等于让它去猜有没有产物").toContain("静态产物在册");
  });

  it("装了之后 read_skill 与 mcp__fixture__echo 真并进请求，清单进上下文，两条审计各落一行", async () => {
    install();
    fx.scripted = ['@@tool read_skill {"name":"tutor-fixture"}', '@@tool mcp__fixture__echo {"text":"读到 nothing"}', `清单上的做法第一步是看日志。${MAIN_FILE}:3 有人问先改哪行？`];
    const threadId = await fx.newThread("map", "装了外部能力");
    const before = fx.sentTools.length;
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "按那份做法看一下", threadId } });
    expect(response.statusCode).toBe(200);

    // ① 清单真的进了请求（模型看得见名字与描述，不是只在界面里挂着）
    expect(fx.sentTools[before].names).toContain("read_skill");
    expect(fx.sentTools[before].names).toContain("mcp__fixture__echo");
    expect(fx.sentTools[before].raw).toContain("tutor-fixture：测试用做法");
    expect(fx.sentTools[before].raw).toContain("别凭名字猜内容");

    // ② 工具真被执行：正文回喂进第二趟、外部正文回喂进第三趟
    expect(fx.sentTools[before + 1].raw).toContain("读 ~/.codebase-tutor/llm.log");
    expect(fx.sentTools[before + 2].raw).toContain("读到 nothing");

    // ③ 两条审计各落一行，且 mcp_call 里只有指针没有正文
    const skill = fx.lastEvent("skill_read");
    expect(skill.payload).toMatchObject({ skill: "tutor-fixture", found: true });
    expect(String(skill.payload.chars)).not.toBe("0");
    const call = fx.lastEvent("mcp_call");
    expect(call.payload).toMatchObject({ server: "fixture", tool: "echo", ok: true });
    expect(JSON.stringify(call.payload)).not.toContain("读到 nothing");

    const loop = fx.lastEvent("loop_round");
    expect(loop.payload).toMatchObject({ tool_external: 1, tool_skills: 1 });
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

/** 宏观设计作用域：JSON 与 SSE 两条出口共用同一次收尾，两边的文本一致性各验一遍。 */

describe("宏观设计作用域（JSON + SSE）", () => {
  it("map-chat JSON：合格回合也写 turn_invariant，响应正文＝库里正文＝turn_text", async () => {
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "合格线程");
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "这一节先看哪里？", threadId } });
    expect(response.statusCode).toBe(200);
    const reply = (response.json() as { reply: string }).reply;

    const invariant = fx.lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("map_chat");
    expect(invariant.payload.applicable).toBe("reference-grounding");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(threadId);
    // 非 teach 作用域只跑引用这一条不变量
    expect(String(invariant.payload.applicable)).not.toContain("socratic-question");

    expect(reply).toBe(OK_REPLY);
    expect(fx.assistantMessage(threadId).content).toBe(reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("map-chat JSON：引用核不上时尾注进正文，落库与审计读的是同一份被补过的文本", async () => {
    fx.scripted = ["见 src/ghost.ts:88，这一步为什么放锁？"];
    const threadId = await fx.newThread("map", "假引用线程");
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "假引用问题", threadId } });
    const reply = (response.json() as { reply: string }).reply;

    const invariant = fx.lastEvent("turn_invariant");
    expect(invariant.payload.failed).toBe("reference-grounding");
    expect(String(invariant.payload.evidence)).toContain("src/ghost.ts");

    expect(reply).toContain(TAIL);
    expect(fx.assistantMessage(threadId).content).toBe(reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("map-chat 没绑定模块也带写工具，并把「架构现场＋现存修正」送进上下文", async () => {
    fx.scripted = [OK_REPLY];
    const threadId = await fx.newThread("map", "画布上直接说话");
    fx.sentTools.length = 0;
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "把刚才那条修正撤掉", threadId } });
    expect(response.statusCode).toBe(200);
    const call = fx.sentTools[0];
    expect(call?.names, "画布是只读的，改图只有 agent 这一条路——不能要求先在左栏点进某个模块").toContain("set_architecture");
    expect(call?.names, "结构改动同样只有 agent 这一条路：界面上没有第二个写入口").toContain("set_diagram");
    expect(call?.raw, "用户说「撤掉那条」时，模型手上得有那份清单和节点 id id，不然只能反问或编 id").toContain("架构现场");
    expect(call?.raw).toContain("现存人工修正");
    expect(call?.raw, "一条修正也没有时也得这么写，否则模型会以为有东西可撤").toContain("一条也没有");
    expect(call?.raw, "改图工具必须先看得见现状（§71）：有哪几张图、正打开那张的图元 id").toContain("画布现场");

    // 反面对照：练习答疑没有画布，也就没有写能力——放宽不能顺着作用域漏出去
    fx.scripted = [OK_REPLY];
    const practiceThread = await fx.newThread("practice", "对照线程", fx.exerciseId);
    fx.sentTools.length = 0;
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/practice-chat`, payload: { content: "这题怎么想？", exerciseId: fx.exerciseId, threadId: practiceThread } });
    expect(fx.sentTools[0]?.names, "practice_chat 永远不给有副作用的工具").not.toContain("set_architecture");
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

  it("停止生成：aborted 帧取代 done、正文不落库，journal 只留一行 turn_aborted", async () => {
    // 让 LLM 在途 300ms，好赶在它回来之前打「停止」；这一条测的是路由收尾的分诊，不是 registry 的中止本身
    fx.scripted = [OK_REPLY];
    fx.holdMs = 300;
    const threadId = await fx.newThread("map", "中止线程");
    const turnId = "abort-test-turn"; // 8~64 位 URL-safe，与 GUI 的 crypto.randomUUID 同一档
    const pending = fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: "这句话会被中止", threadId, turnId } });
    await new Promise((resolve) => setTimeout(resolve, 60)); // 让回合登记上再打停止
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
    // 作废的回合没有成品：库里既没有助手正文，也不该有这一轮的 turn_text（否则 GUI 回来会看到一条自己中止的回复）
    expect(readMessages(fx.repoDir, threadId).some((message) => message.role === "assistant")).toBe(false);
    expect(fx.eventsOf("turn_text").some((event) => event.sessionId === threadId)).toBe(false);
  });

  /**
    作废的回合不落正文，但已发生的事实要照落：这一轮真读过 src/main.ts、真发过两趟 LLM，
    跟着正文一起丢掉，journal 上这一轮就成了「什么都没干」的假账。
    中止有两种落法，带的审计数组在两个不同地方，所以各测一条：
    ① 落在最后一趟 LLM 在途 → 异常一路抛上来，数组挂在异常上；
    ② 落在最后一趟回来之后 → 循环已正常返回，数组在返回值里。
    */
  function expectAbortedAudit(threadId: string, events: Record<string, unknown>[], marker: string): void {
    // 失败信息自带现场：本回合发了几趟、脚本还剩几段、帧序列、file_read 行数，
    // 否则分不清是「工具没执行」「没落账」还是「落了但线程号不对」
    const reads = fx.eventsOf("file_read").filter((event) => event.sessionId === threadId);
    const allReads = fx.eventsOf("file_read");
    /** 每一趟请求里工具到底回了什么：读到了正文、还是「未知工具 / 未知仓库 / 额度用尽」这类不落账的分支。 */
    const toolReplies = fx.sentTools.filter((entry) => entry.raw.includes(marker)).map((entry) => ["未知工具", "未知仓库", "读文件上限", "跨仓读取最多"].find((word) => entry.raw.includes(word)) ?? (entry.raw.includes("// line 1") ? "读到正文" : "没读到")).join(" | ");
    const scene = `本回合请求 ${fx.requestsOf(marker)} 趟（工具回话：${toolReplies}）/ 脚本剩余 ${fx.scripted.length} 段 / 帧 ${events.map((event) => event.type).join("→")} / journal 里 file_read 共 ${allReads.length} 行（本线程 ${reads.length} 行，线程号 ${[...new Set(allReads.map((event) => String(event.sessionId)))].join(" ") || "无"}）`;
    /**
      先问「工具到底执行了没有」：第二趟请求里必须带着 `read_file` 回填的正文（`// line 1` 是那 20 行注释的第一行）。
      带着 ⇒ 真读过，问题在落账；没带 ⇒ 问题在工具循环，此时「账上该有一行」这个期待本身就不成立。
      */
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
    // 补账不等于放行成品
    expect(fx.eventsOf("turn_text").some((event) => event.sessionId === threadId)).toBe(false);
    expect(readMessages(fx.repoDir, threadId).some((message) => message.role === "assistant")).toBe(false);
    expect(fx.eventsOf("turn_aborted").filter((event) => event.sessionId === threadId)).toHaveLength(1);
  }

  it("① 停止落在最后一趟在途：异常带着本轮读过的文件上来，收尾照样落账", async () => {
    const question = "这句会被中止但要记账·在途";
    fx.scripted = [`@@tool read_file {"path":"${MAIN_FILE}"}`, OK_REPLY];
    fx.holdMs = 1_200; // 第二趟留足在途窗口，停止一定撞在请求还活着的时候
    const threadId = await fx.newThread("map", "中止补账·在途");
    const turnId = "abort-audit-inflight";
    const pending = fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: question, threadId, turnId } });
    // 等的是「第一趟已回来、read_file 真执行过、第二趟已经发出」这个事件（判据=本回合第二发请求登记上），
    // 不是墙上时间：固定 sleep 会抢在 fx.holdMs 之前打完停止，中止于是落在第一轮工具之前，账上本来就没东西
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
    // 第二趟请求返回之前把停止打进去：signal 已置位但这一趟照样回正文，路由收尾时才判作废
    fx.stopInside = { turnId, marker: question, atCall: 2, seen: 0 };
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: question, threadId, turnId } });
    fx.stopInside = undefined;
    expectAbortedAudit(threadId, sseEvents(response.payload), question);
  });
});

/** 练习答疑：与 map-chat 同款 SSE 收尾，但线程绑题、作用域记 practice_chat。 */

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
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "这段配置安全吗？", threadId } });
    expect(response.statusCode).toBe(200);
    const reply = (response.json() as { reply: string }).reply;
    expect(reply).toContain("[疑似密钥，已隐去]");
    expect(reply).toContain("[仓库外路径，已隐去]");
    expect(reply).toContain("本地过筛"); // 改过字要说明，不能暗改
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

/**
  跨仓能力只在工具面上发生。要钉的是两件事：地址簿里有第二个仓时模型才看得见 `cross_repo_link` 与仓名，
  只剩一个仓时工具清单不变——多给一个用不上的 schema 字段就是每轮多付 token，
  还会诱使模型去猜一个不存在的对端仓。全程零 token（fetch 被 stub 到 127.0.0.1:9）。
  */

describe("跨仓工具面随地址簿变", () => {
  it("有第二个仓才给 cross_repo_link 与 repo 参数；没有时清单不变", async () => {
    const registryFile = process.env.TUTOR_REGISTRY_FILE;
    expect(registryFile).toBeTruthy();
    const original = readFileSync(registryFile!, "utf8");
    const peerDir = join(fx.root, "peer-repo");
    mkdirSync(peerDir, { recursive: true });
    const threadId = await fx.newThread("map", "跨仓工具面");
    const ask = () => fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "这个请求打到哪个仓去了？", threadId } });

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
      expect(withPeer.raw).toContain("peer-repo"); // 仓名进了 read_file/search_code 的 schema，模型才知道该填什么
    } finally {
      writeFileSync(registryFile!, original, "utf8");
      rmSync(peerDir, { recursive: true, force: true });
    }
  });
});
/**
  源码出网清单（`code_egress`）。这条线只有打真路由才算验过，要同时证明三件事：
  1. 装配里真放了源码的那次调用才计入审计，且一一对得上形态（锚点摘录 / 整文件切片 / 流程窗口 / 出题摘录）；
  2. 行里有指纹而没有正文——审计线自己不能变成第二个泄露面（`.tutor/` 是随仓可带走的东西）；
  3. 同一段代码在两次调用里各出一次门，就记两条，不合并成一条好看的数。
  零 token：fetch 仍被 stub 到 127.0.0.1:9。
  */

describe("源码出网清单", () => {
  const egress = () => fx.eventsOf("code_egress");
  const sentFields = (row: JournalEvent) => Object.keys(row.payload).sort();

  it("宏观设计回合：锚点摘录逐段计入审计，带线程 id，且不含源码正文", async () => {
    const before = egress().length;
    const threadId = await fx.newThread("map", "出网线程");
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "这一节先看哪里？", threadId, nodeId: "unit-1" } });
    expect(response.statusCode).toBe(200);

    const rows = egress().slice(before);
    expect(rows.length, "锚点附近的源码摘录应逐段记入审计").toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payload).toMatchObject({ scene: "map.chat", kind: "anchor-excerpt", path: MAIN_FILE });
      expect(String(row.payload.hash)).toMatch(/^[0-9a-f]{12}$/);
      expect(Number(row.payload.chars)).toBeGreaterThan(0);
      expect(row.sessionId).toBe(threadId);
      // fixture 里锚点第 3 行的真实内容是 `// line 3`：出现在任何一行里都说明正文被抄进了审计线
      expect(JSON.stringify(row)).not.toContain("// line 3");
    }
    expect(sentFields(rows[0])).toEqual(["chars", "hash", "kind", "lines", "path", "scene"]);
  });

  it("装配里没有源码时一行都不落（文件清单是派生产物，不算源码出网）", async () => {
    const before = egress().length;
    const threadId = await fx.newThread("map", "无源码出网线程");
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat`, payload: { content: "这个项目整体是做什么的？", threadId } });
    expect(response.statusCode).toBe(200);
    expect(egress().slice(before)).toEqual([]);
  });

  it("教学回合：只剩措辞那一趟调用，同一段摘录就只记一次（撤掉动作提议前的两次出网已成历史）", async () => {
    const created = await fx.app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId: fx.repositoryId, courseNodeId: "unit-1" } });
    const sessionId = (created.json() as { session: { id: string } }).session.id;
    fx.usedThreads.add(sessionId);
    const before = egress().length;
    fx.scripted = [`registerOrder 在 ${MAIN_FILE}:3 先跑，你觉得少了哪一步会先炸？`];
    const response = await fx.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    expect(response.statusCode).toBe(200);

    const rows = egress().slice(before);
    const scenes = new Set(rows.map((row) => row.payload.scene));
    // 教学回合只剩措辞那一趟调用
    expect([...scenes].sort()).toEqual(["teaching.turn"]);
    // 真的带着那段摘录出门：不是只记了一条「本轮看过 src/main.ts」
    for (const scene of scenes) expect(rows.filter((row) => row.payload.scene === scene).map((row) => row.payload.path)).toContain(MAIN_FILE);
    expect(rows.every((row) => row.sessionId === sessionId)).toBe(true);
    expect(rows.some((row) => JSON.stringify(row).includes("// line 3"))).toBe(false);
  });
});

/**
  上面那两条出网用例依赖挂载中的产物不被换掉：本文件的密钥用例往仓里写过 `.env` 与 `credentials.json`，
  这类写入若触发全量重分析，产物里的 `unit-1` 锚点会被真实扫描结果取代，出网装配就读不到摘录了。
  口径：只有「可能改变收录集」的改动才触发重分析（收录判据见 indexer 的 isIngestedPath）。
*/
describe("LLM 工作日志的账面一致性", () => {
  it("每次 provider 调用追加一行，threadId 与本文件用过的线程全等，失败只允许是中止", async () => {
    await fx.verifyLlmLog({ expectAborted: true, scenes: ["map.chat", "practice.chat"] });
  });
});
