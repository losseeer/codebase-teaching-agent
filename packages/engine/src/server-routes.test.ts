import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ChatThreadMessage, CourseTree, ImportEstimate, JournalEvent, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { UI_JOURNAL_EVENTS } from "@codebase-tutor/shared";
import { repositoryId as deriveRepositoryId } from "./lib.js";
import { defaultMonthlyBudgetUsd } from "./cost/cost.js";
import { isolationBackend } from "./sandbox/profile.js";
import { flushLlmLog } from "./llm/call-log.js";
import { TutorDatabase } from "./store/database.js";
import { readJournal } from "./store/journal.js";
import { appendMessages, createThread, readMessages } from "./store/chat-store.js";

/**
  路由级回归。两块内容共用这套临时仓库与地址簿：

  一、四条「回合收尾」路径（宏观设计 JSON / 宏观设计 SSE / 练习答疑 SSE / 教学 SSE）。
  要拦的事故：复检改成「先 recheckTurn → 再落库 → 再回放」之后，谁把顺序换回去，
  落库正文和学习者看到的正文就会差那行尾注——`recheckTurn` 的单测查不出来，只有打路由才看得见。

  每条路径断言三件事：
  1. 不抛错：HTTP 200，且 SSE 流里没有 `error` 事件；
  2. `turn_invariant` 一定落 journal（合格也记，分母才运行时内成立）；
  3. 三处文本同一份：响应/回放正文 == chat_message 正文 == journal 的 `turn_text.answer`。

  二、`GET /source` 的取文件边界与 `POST /journal` 的入参守卫：这两件事的判据都跨在**挂载态**上
  （索引里有没有这个文件、事件能不能落进这条审计线），单测只能凭想象，只有带着真库打路由才算验过。

  零 token：LLM 走 stub 掉的 `fetch`（服务商指向 127.0.0.1:9，真端点打不到），
  仓库、地址簿、llm.log、llm-settings 全在临时目录——`~/.codebase-tutor` 里的产品数据一条都不碰。
  */

const root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-routes-")));
const repoDir = join(root, "repo");
/** 仓 id 要等目录真建出来才算得出来（`repositoryId` 内部走 realpath），故留到 beforeAll 赋值。 */
let repositoryId = "";
const MAIN_FILE = "src/main.ts";
/** 引用核得上时的默认正文：带问句、带真引用、带长标识符，三条不变量都能过。 */
const OK_REPLY = `先看 ${MAIN_FILE}:3 的 registerOrder，你觉得哪一步会先执行？`;
/** 尾注里独有的词（文案全文住在 eval/scorers.ts，这里只判「有没有出现」） */
const TAIL = "自动复检";

/**
  假 provider。两个约束是被实测教出来的：
  - **绝不回空正文**：外层重试层把空 content 当失败并重发，一次调用变两次，脚本会整体串位；
  - **决策调用（动作提议 / 意图分类）单独回**：它的正文只被解析成动作标签，
    喂对话正文进去会被解析成一个真动作、把状态机推进，后续断言就跟着阶段漂了。
  */
let scripted: string[] = [];
let spoken = OK_REPLY;
let fetchCalls = 0;
/** 让假 provider 在途一会儿：「停止生成」的路由级测试得赶在 LLM 返回之前打进 `/api/turns/stop`。 */
let holdMs = 0;
/**
  在**本回合第 N 趟请求返回之前**替用户点停止：中止于是精确落在「最后一趟已发出、还没回来」或「已回来、路由还没收尾」，
  取决于 `holdMs`。计数只认带 `marker`（这一回合的问题原文）的请求——`fetchCalls` 是全文件累加的，
  任何别处多发一发就会把序号挪走（CI 上实测被这条坑过一次）。
*/
let stopInside: { turnId: string; marker: string; atCall: number; seen: number } | undefined;

function decisionCall(raw: string): boolean {
  return raw.includes("动作决策器") || raw.includes("意图分类");
}

function replyFor(raw: string): string {
  if (decisionCall(raw)) return "（测试：本轮不给动作提议）";
  const next = scripted.shift();
  if (next) spoken = next;
  return spoken;
}

/** 每次请求实际带上的工具清单（跨仓那档要验的就是它随不随地址簿变长）。 */
const sentTools: { names: string[]; raw: string }[] = [];

/** 这一回合（按问题原文认）已经**发出**了几趟请求。用来等「第一轮工具真跑完」，不靠 sleep 猜。 */
const requestsOf = (marker: string): number => sentTools.filter((entry) => entry.raw.includes(marker)).length;

/** 轮询到条件成立；到点不成就带着「在等什么」失败，而不是悄悄跳过。 */
async function waitFor(predicate: () => boolean, why: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等不到「${why}」（${timeoutMs}ms 超时）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fakeFetch(_url: unknown, init?: { body?: string; signal?: AbortSignal }): Promise<Response> {
  fetchCalls += 1;
  const raw = String(init?.body ?? "{}");
  // 先登记再在途：这一行代表「请求已经发出去了」，用例靠它判断自己该在什么时刻打停止
  try {
    const parsed = JSON.parse(raw) as { tools?: { function?: { name?: string } }[] };
    sentTools.push({ names: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "").filter(Boolean), raw });
  } catch { /* 非 JSON 的请求体不进这份清单 */ }
  if (holdMs) {
    // 真在途、真被 signal 打断：provider 会把它归因成 LlmAbortedError，于是测得到「异常携带」那半条补账路径
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, holdMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      }, { once: true });
    });
  }
  if (stopInside && raw.includes(stopInside.marker) && ++stopInside.seen === stopInside.atCall) {
    const stopped = await app.inject({ method: "POST", url: "/api/turns/stop", payload: { turnId: stopInside.turnId } });
    expect(stopped.json()).toMatchObject({ stopped: true });
  }
  const text = replyFor(raw);
  // `@@tool 工具名 {json}` 这种脚本前缀让假 provider 回一次工具调用：副作用工具**实际被拒的是什么**从此能被端到端验，
  // 不用只停在「清单里有这一项」
  const call = /^@@tool (\S+) (.*)$/s.exec(text);
  const payload = {
    choices: [{ message: call ? { content: "", tool_calls: [{ id: `call_${fetchCalls}`, type: "function", function: { name: call[1], arguments: call[2] } }] } : { content: text }, finish_reason: call ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 40 }
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function sseEvents(payload: string): Record<string, unknown>[] {
  return payload.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function deltasOf(events: Record<string, unknown>[]): string {
  return events.filter((event) => event.type === "delta").map((event) => String(event.delta ?? "")).join("");
}

function doneEvent(events: Record<string, unknown>[]): Record<string, unknown> {
  const done = events.find((event) => event.type === "done");
  expect(done, "SSE 流缺少 done 事件（回合没走完）").toBeDefined();
  expect(events.some((event) => event.type === "error" || event.type === "aborted")).toBe(false);
  return done as Record<string, unknown>;
}

function eventsOf(type: string): JournalEvent[] {
  return readJournal(repoDir).filter((event) => event.type === type);
}

function lastEvent(type: string): JournalEvent {
  const list = eventsOf(type);
  expect(list.length, `journal 里没有 ${type} 事件`).toBeGreaterThan(0);
  return list[list.length - 1];
}

function assistantMessage(threadId: string): ChatThreadMessage {
  const messages = readMessages(repoDir, threadId).filter((message) => message.role === "assistant");
  expect(messages.length, "chat_message 里没有助手正文").toBeGreaterThan(0);
  return messages[messages.length - 1];
}

/** 本文件真正用过的线程 id（teach 的 sessionId 也算线程）：与 llm.log 里的 threadId 集合做全等比对，
    哪条路径漏了 markThread 就会在这里露出来。 */
const usedThreads = new Set<string>();

async function newThread(scope: "map" | "practice", title: string, linkedExerciseId?: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/repositories/${repositoryId}/threads`,
    payload: { scope, title, ...(linkedExerciseId ? { exerciseId: linkedExerciseId } : {}) }
  });
  const threadId = (response.json() as { thread: { id: string } }).thread.id;
  usedThreads.add(threadId);
  return threadId;
}

let app: FastifyInstance;
let exerciseId = "";

beforeAll(async () => {
  // 临时仓：一个文件、一行一条注释，行号可预期（src/main.ts:3 判「在范围内」）
  mkdirSync(join(repoDir, "src"), { recursive: true });
  repositoryId = deriveRepositoryId(repoDir);
  const source = Array.from({ length: 20 }, (_unused, index) => `// line ${index + 1}`).join("\n");
  writeFileSync(join(repoDir, MAIN_FILE), `${source}\n`, "utf8");

  const now = new Date().toISOString();
  const index: RepositoryIndex = {
    repositoryId, repositoryPath: repoDir, scannedAt: now, totalFiles: 1, totalLines: 20,
    files: [{ path: MAIN_FILE, extension: ".ts", bytes: source.length, lines: 20 }],
    fileTree: [], hotspots: []
  };
  const course: CourseTree = {
    repositoryId, modelVersion: "fixture-v1", generatedAt: now,
    root: {
      id: "root", title: "测试课程", summary: "路由级测试用课程树", kind: "overview", anchors: [],
      children: [
        { id: "unit-1", title: "注册顺序", summary: "builder 先注册再分发。", kind: "implementation", anchors: [{ path: MAIN_FILE, line: 3, label: "入口" }], children: [] },
        // 真仓的文档节点确实挂在课程树上（dianping 的 README 与 backend-design.md 都是树里的模块），
        // 推荐入口这条路由要把它们挡在候选之外，所以 fixture 得先有它，否则下面的断言是空的。
        { id: "unit-doc", title: "设计文档", summary: "秒杀方案记录。", kind: "module", anchors: [{ path: "docs/design.md", line: 1, label: "文档" }], children: [] },
        // 架构视图这路的 fixture：`modules` 分支是它的模块清单来源（与 GUI 的模块地图同一个 id）
        {
          id: "modules", title: "模块地图", kind: "overview", summary: "两个模块，一个有代码、一个只有文档。", anchors: [],
          children: [
            { id: "module:src", title: "注册实现", kind: "module", summary: "builder 先注册再分发。", anchors: [{ path: MAIN_FILE, line: 3, label: "实现" }], children: [] },
            { id: "module:docs", title: "设计说明", kind: "module", summary: "秒杀方案记录。", anchors: [{ path: "docs/design.md", line: 1, label: "文档" }], children: [] }
          ]
        }
      ]
    }
  };
  const analysis: RepositoryAnalysis = {
    repositoryId, generatedAt: now, versionStamp: "content:fixture",
    graph: {
      imports: { [MAIN_FILE]: [] }, calls: [],
      symbols: [{ id: "sym-1", name: "registerOrder", kind: "function", path: MAIN_FILE, line: 3, endLine: 6, parameters: ["builder"], language: "typescript" }],
      entrypoints: [{ path: MAIN_FILE, line: 3, label: "registerOrder" }],
      semanticBackend: "static", lspStatus: []
    },
    implementations: [], quality: { generatedAt: now, micro: [], macro: [] }
  };
  const estimate: ImportEstimate = { cachedFiles: 0, summarizedFiles: 1, estimatedInputTokens: 0, estimatedCostUsd: 0, provider: "none", modelVersion: "fixture-v1" };
  const database = new TutorDatabase(repoDir);
  database.saveIndex(index);
  database.saveCourse(course, estimate);
  database.saveAnalysis(analysis);
  // 练习答疑要求题目在缓存里（题面由 fixture 给定，不走出题路径）
  exerciseId = "ex-fixture";
  database.putExerciseCache(repositoryId, "content:fixture", "impact_analysis", "unit-1", {
    exercise: {
      id: exerciseId, repositoryId, contentVersion: "content:fixture", kind: "impact_analysis",
      targetUnitId: "unit-1", targetTitle: "注册顺序", difficulty: 1, title: "影响分析", prompt: "改这一行会先影响谁？",
      anchors: [{ path: MAIN_FILE, line: 3, label: "入口" }], inputMode: "multi_select", gradingMode: "set_match", createdAt: now
    }
  });
  database.close();

  // 引擎的四条产品数据落点全部改指临时目录（各自的 env 注释见对应模块）
  process.env.TUTOR_REGISTRY_FILE = join(root, "registry.json");
  writeFileSync(process.env.TUTOR_REGISTRY_FILE, `${JSON.stringify({ repositories: [repoDir] }, null, 2)}\n`, "utf8");
  process.env.TUTOR_LLM_SETTINGS_FILE = join(root, "llm-settings.json");
  writeFileSync(process.env.TUTOR_LLM_SETTINGS_FILE, `${JSON.stringify({ provider: "openai-compatible", model: "fixture-model", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-key", thinking: "auto" }, null, 2)}\n`, "utf8");
  process.env.TUTOR_LLM_LOG = join(root, "llm.log");
  process.env.TUTOR_ENGINE_LOG = "off";

  // 必须早于 import server：provider 在构造时就把 fetch 绑成了实例字段
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  ({ app } = await import("./server.js"));
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
  for (const key of ["TUTOR_REGISTRY_FILE", "TUTOR_LLM_SETTINGS_FILE", "TUTOR_LLM_LOG", "TUTOR_ENGINE_LOG"]) delete process.env[key];
});

beforeEach(() => {
  scripted = [];
  spoken = OK_REPLY;
  holdMs = 0;
  stopInside = undefined;
});

describe("外部能力面进回合：技能与 MCP（默认关，装了才给）", () => {
  const skillsDir = join(root, "skills");
  const fixture = join(import.meta.dirname, "mcp", "fixtures", "echo-server.mjs");

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
    const config = join(root, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], allowedTools: ["echo"] } } }, null, 2), "utf8");
    process.env.TUTOR_SKILLS_DIR = skillsDir;
    process.env.TUTOR_MCP_SETTINGS_FILE = config;
  }

  afterEach(() => {
    delete process.env.TUTOR_SKILLS_DIR;
    delete process.env.TUTOR_MCP_SETTINGS_FILE;
  });

  it("没装时工具清单逐字不变——默认关是靠不加，不是靠开关", async () => {
    scripted = [OK_REPLY];
    const threadId = await newThread("map", "没装外部能力");
    const before = sentTools.length;
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "这仓分几层？", threadId } });
    expect(sentTools[before].names).toEqual(["read_file", "search_code", "set_architecture", "redraw_diagram"]);
  });

  it("装了之后 read_skill 与 mcp__fixture__echo 真并进请求，清单进上下文，两条审计各落一行", async () => {
    install();
    scripted = ['@@tool read_skill {"name":"tutor-fixture"}', '@@tool mcp__fixture__echo {"text":"读到 nothing"}', `清单上的做法第一步是看日志。${MAIN_FILE}:3 有人问先改哪行？`];
    const threadId = await newThread("map", "装了外部能力");
    const before = sentTools.length;
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "按那份做法看一下", threadId } });
    expect(response.statusCode).toBe(200);

    // ① 清单真的进了请求（模型看得见名字与描述，不是只在界面里挂着）
    expect(sentTools[before].names).toContain("read_skill");
    expect(sentTools[before].names).toContain("mcp__fixture__echo");
    expect(sentTools[before].raw).toContain("tutor-fixture：测试用做法");
    expect(sentTools[before].raw).toContain("别凭名字猜内容");

    // ② 工具真被执行：正文回喂进第二趟、外部正文回喂进第三趟
    expect(sentTools[before + 1].raw).toContain("读 ~/.codebase-tutor/llm.log");
    expect(sentTools[before + 2].raw).toContain("读到 nothing");

    // ③ 两条审计各落一行，且 mcp_call 里只有指针没有正文
    const skill = lastEvent("skill_read");
    expect(skill.payload).toMatchObject({ skill: "tutor-fixture", found: true });
    expect(String(skill.payload.chars)).not.toBe("0");
    const call = lastEvent("mcp_call");
    expect(call.payload).toMatchObject({ server: "fixture", tool: "echo", ok: true });
    expect(JSON.stringify(call.payload)).not.toContain("读到 nothing");

    const loop = lastEvent("loop_round");
    expect(loop.payload).toMatchObject({ tool_external: 1, tool_skills: 1 });
  });

  it("GET /api/external 把装了什么、连不上的原因交出来（零 token，读侧不发模型）", async () => {
    install();
    const response = await app.inject({ method: "GET", url: "/api/external" });
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
    scripted = [OK_REPLY];
    const threadId = await newThread("map", "合格线程");
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "这一节先看哪里？", threadId } });
    expect(response.statusCode).toBe(200);
    const reply = (response.json() as { reply: string }).reply;

    const invariant = lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("map_chat");
    expect(invariant.payload.applicable).toBe("reference-grounding");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(threadId);
    // 非 teach 作用域只跑引用这一条：没问句也不该被苏格拉底规则判分
    expect(String(invariant.payload.applicable)).not.toContain("socratic-question");

    expect(reply).toBe(OK_REPLY);
    expect(assistantMessage(threadId).content).toBe(reply);
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("map-chat JSON：引用核不上时尾注进正文，落库与审计读的是同一份被补过的文本", async () => {
    scripted = ["见 src/ghost.ts:88，这一步为什么放锁？"];
    const threadId = await newThread("map", "假引用线程");
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "假引用问题", threadId } });
    const reply = (response.json() as { reply: string }).reply;

    const invariant = lastEvent("turn_invariant");
    expect(invariant.payload.failed).toBe("reference-grounding");
    expect(String(invariant.payload.evidence)).toContain("src/ghost.ts");

    expect(reply).toContain(TAIL);
    expect(assistantMessage(threadId).content).toBe(reply);
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("map-chat 没绑定模块也带写工具，并把「架构现场＋现存修正」送进上下文", async () => {
    scripted = [OK_REPLY];
    const threadId = await newThread("map", "画布上直接说话");
    sentTools.length = 0;
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "把刚才那条修正撤掉", threadId } });
    expect(response.statusCode).toBe(200);
    const call = sentTools[0];
    expect(call?.names, "画布是只读的，改图只有 agent 这一条路——不能要求先在左栏点进某个模块").toContain("set_architecture");
    expect(call?.raw, "用户说「撤掉那条」时，模型手上得有那份清单和节点 id id，不然只能反问或编 id").toContain("架构现场");
    expect(call?.raw).toContain("现存人工修正");
    expect(call?.raw, "一条修正也没有时也得这么写，否则模型会以为有东西可撤").toContain("一条也没有");

    // 反面对照：练习答疑没有画布，也就没有写能力——放宽不能顺着作用域漏出去
    scripted = [OK_REPLY];
    const practiceThread = await newThread("practice", "对照线程", exerciseId);
    sentTools.length = 0;
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/practice-chat`, payload: { content: "这题怎么想？", exerciseId, threadId: practiceThread } });
    expect(sentTools[0]?.names, "practice_chat 永远不给有副作用的工具").not.toContain("set_architecture");
  });

  it("map-chat SSE：delta 拼起来＝done.reply＝库里正文", async () => {
    scripted = [`看 ${MAIN_FILE}:5 的上游，谁先把请求交给它？`];
    const threadId = await newThread("map", "流式线程");
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat/stream`, payload: { content: "流式问题", threadId } });
    const events = sseEvents(response.payload);
    const reply = String(doneEvent(events).reply);

    expect(deltasOf(events)).toBe(reply);
    expect(assistantMessage(threadId).content).toBe(reply);
    expect(lastEvent("turn_invariant").payload.scene).toBe("map_chat");
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("停止生成：aborted 帧取代 done、正文不落库，journal 只留一行 turn_aborted", async () => {
    // 让 LLM 在途 300ms，好赶在它回来之前打「停止」——这一条测的是路由收尾的分诊，不是 registry 的中止本身
    scripted = [OK_REPLY];
    holdMs = 300;
    const threadId = await newThread("map", "中止线程");
    const turnId = "abort-test-turn"; // 8~64 位 URL-safe，与 GUI 的 crypto.randomUUID 同一档
    const pending = app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat/stream`, payload: { content: "这句话会被中止", threadId, turnId } });
    await new Promise((resolve) => setTimeout(resolve, 60)); // 让回合登记上再打停止
    const stopped = await app.inject({ method: "POST", url: "/api/turns/stop", payload: { turnId } });
    expect(stopped.json()).toMatchObject({ stopped: true, scene: "map_chat" });

    const events = sseEvents((await pending).payload);
    expect(events.some((event) => event.type === "done"), "中止的回合不该回放 done").toBe(false);
    expect(events.some((event) => event.type === "error"), "中止不是错误").toBe(false);
    expect(events.filter((event) => event.type === "delta"), "中止后一帧正文都不该回放").toHaveLength(0);
    const abortedFrame = events.find((event) => event.type === "aborted");
    expect(abortedFrame, "没收到 aborted 帧").toBeDefined();
    expect(abortedFrame).toMatchObject({ type: "aborted", scene: "map_chat" });

    const aborted = lastEvent("turn_aborted");
    expect(aborted.payload).toMatchObject({ scene: "map_chat", turn_id: turnId, aborted_by: "user_stop" });
    expect(aborted.sessionId).toBe(threadId);
    // 作废的回合没有成品：库里既没有助手正文，也不该有这一轮的 turn_text（否则 GUI 回来会看到一条自己中止的回复）
    expect(readMessages(repoDir, threadId).some((message) => message.role === "assistant")).toBe(false);
    expect(eventsOf("turn_text").some((event) => event.sessionId === threadId)).toBe(false);
  });

  /**
    上一条证的是「作废的回合不落正文」，这两条补它漏掉的那半：**已发生的事实要照落**。
    这一轮真读过 src/main.ts（源码进过模型上下文）、真花过两趟 LLM，回合却被中止。
    要是跟着正文一起丢掉，journal 上这一轮就成了「什么都没干」的假账（§77 第 6 条）。
    中止有两种落法，带的审计数组在两个不同地方，所以各测一条：
    ① 落在最后一趟 LLM 在途 → 异常一路抛上来，数组挂在异常上；
    ② 落在最后一趟回来之后 → 循环已正常返回，数组在返回值里。
    */
  function expectAbortedAudit(threadId: string, events: Record<string, unknown>[]): void {
    expect(events.some((event) => event.type === "done"), "中止的回合不该回放 done").toBe(false);
    expect(events.filter((event) => event.type === "delta"), "中止后一帧正文都不该回放").toHaveLength(0);
    const reads = eventsOf("file_read").filter((event) => event.sessionId === threadId);
    expect(reads.map((event) => event.payload.path), "中止前读过的文件必须留痕").toEqual([MAIN_FILE]);
    expect(reads[0].payload.denied).toBe(false);
    const loop = eventsOf("loop_round").filter((event) => event.sessionId === threadId);
    expect(loop).toHaveLength(1);
    expect(loop[0].payload).toMatchObject({ scene: "map_chat", aborted: true, tool_rounds: 1, tool_reads: 1 });
    // 补账不等于放行成品
    expect(eventsOf("turn_text").some((event) => event.sessionId === threadId)).toBe(false);
    expect(readMessages(repoDir, threadId).some((message) => message.role === "assistant")).toBe(false);
    expect(eventsOf("turn_aborted").filter((event) => event.sessionId === threadId)).toHaveLength(1);
  }

  it("① 停止落在最后一趟在途：异常带着本轮读过的文件上来，收尾照样落账", async () => {
    const question = "这句会被中止但要记账·在途";
    scripted = [`@@tool read_file {"path":"${MAIN_FILE}"}`, OK_REPLY];
    holdMs = 1_200; // 第二趟留足在途窗口，停止一定撞在请求还活着的时候
    const threadId = await newThread("map", "中止补账·在途");
    const turnId = "abort-audit-inflight";
    const pending = app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat/stream`, payload: { content: question, threadId, turnId } });
    // 等的是「第一趟已回来、read_file 真执行过、第二趟已经发出」这个**事件**（判据=本回合第二发请求登记上），
    // 不是墙上时间：CI 那台机器上 sleep(500) 会抢在 holdMs 之前打完停止，中止于是落在第一轮工具之前，账上本来就没东西
    await waitFor(() => requestsOf(question) >= 2, "第一趟回来、read_file 执行完、第二趟请求发出");
    const stopped = await app.inject({ method: "POST", url: "/api/turns/stop", payload: { turnId } });
    expect(stopped.json()).toMatchObject({ stopped: true, scene: "map_chat" });
    expectAbortedAudit(threadId, sseEvents((await pending).payload));
  });

  it("② 停止落在最后一趟之后：数组在返回值里，收尾同样落账", async () => {
    const question = "这句答完才发现已经点了停止·收尾";
    scripted = [`@@tool read_file {"path":"${MAIN_FILE}"}`, OK_REPLY];
    const threadId = await newThread("map", "中止补账·收尾");
    const turnId = "abort-audit-late";
    // 第二趟请求**返回之前**把停止打进去：signal 已置位但这一趟照样回正文，路由收尾时才判作废
    stopInside = { turnId, marker: question, atCall: 2, seen: 0 };
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat/stream`, payload: { content: question, threadId, turnId } });
    stopInside = undefined;
    expectAbortedAudit(threadId, sseEvents(response.payload));
  });
});

/** 练习答疑：与 map-chat 同款 SSE 收尾，但线程绑题、作用域记 practice_chat。 */
describe("练习答疑作用域（SSE）", () => {
  it("practice-chat：复检先于落库与回放，正文三处一致", async () => {
    scripted = [`先跑 ${MAIN_FILE}:3 这条路，你觉得断点打在哪一行？`];
    const threadId = await newThread("practice", "练习线程", exerciseId);
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/practice-chat`, payload: { content: "这题怎么想？", exerciseId, threadId } });
    const events = sseEvents(response.payload);
    const reply = String(doneEvent(events).reply);

    const invariant = lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("practice_chat");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(threadId);

    expect(deltasOf(events)).toBe(reply);
    expect(assistantMessage(threadId).content).toBe(reply);
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("practice-chat：假引用同样吃到尾注，回放与落库都不缺这一行", async () => {
    scripted = ["见 src/nowhere.ts:9，先说结论再解释。"];
    const threadId = await newThread("practice", "练习假引用", exerciseId);
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/practice-chat`, payload: { content: "换个问法", exerciseId, threadId } });
    const events = sseEvents(response.payload);
    const reply = String(doneEvent(events).reply);

    expect(reply).toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(assistantMessage(threadId).content).toBe(reply);
    expect(lastEvent("turn_invariant").payload.failed).toBe("reference-grounding");
  });
});

/** 教学作用域：三条不变量都在这里生效（苏格拉底问句 / 引用落地 / 点名标识符），默认 style 50 = neutral 档。 */
describe("教学作用域（SSE）", () => {
  async function openSession(settings?: Record<string, unknown>): Promise<string> {
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId, courseNodeId: "unit-1", ...(settings ? { settings } : {}) } });
    const id = (created.json() as { session: { id: string } }).session.id;
    usedThreads.add(id);
    return id;
  }

  function replyOf(payload: string): { reply: string; events: Record<string, unknown>[] } {
    const events = sseEvents(payload);
    const done = doneEvent(events) as { message: { content: string } };
    return { reply: done.message.content, events };
  }

  it("teach：合格回合 applicable 含两条不变量、无尾注，done.message 与库里正文一致", async () => {
    const sessionId = await openSession();
    scripted = [`registerOrder 在 ${MAIN_FILE}:3 先跑，你觉得少了哪一步会先炸？`];
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    const { reply, events } = replyOf(response.payload);

    const invariant = lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("teach");
    const applicable = String(invariant.payload.applicable);
    expect(applicable).toContain("reference-grounding");
    expect(applicable).toContain("anchor-binding");
    // socratic-question 这条度量随教学状态机于 2026-10-14 删除（判据吃 stage 与本轮动作）
    expect(applicable).not.toContain("socratic-question");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(sessionId);

    expect(reply).not.toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(assistantMessage(sessionId).content).toBe(reply);
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("teach：假引用失守，尾注进正文也进库里那一份", async () => {
    const sessionId = await openSession();
    scripted = ["直接讲结论，registerOrder 的作用与 src/missing.ts:1 无关。"];
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "再讲一遍" } });
    const { reply, events } = replyOf(response.payload);

    const failed = String(lastEvent("turn_invariant").payload.failed);
    expect(failed).toContain("reference-grounding");

    expect(reply).toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(assistantMessage(sessionId).content).toBe(reply);
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("teach：通俗档不再判「点名标识符」，引用照判（档位只运行时内生效才算数）", async () => {
    const sessionId = await openSession({ style: 80 });
    const answer = `这一步就是把请求交给注册表，你先看 ${MAIN_FILE}:3 那一行？`;
    scripted = [answer];
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "换个通俗点的说法" } });
    const { reply } = replyOf(response.payload);

    const invariant = lastEvent("turn_invariant");
    const applicable = String(invariant.payload.applicable);
    expect(applicable).toContain("reference-grounding");
    expect(applicable).not.toContain("anchor-binding");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(reply).toBe(answer);
  });
});

/** 语言画像：架构视图要能说清「这条边有多硬」，而这份口径只能读侧实时计算。 */
describe("GET /analysis 附带的语言画像", () => {
  it("响应带本仓语言分布与能力档，但落库产物一字未改（不进缓存键）", async () => {
    const callsBefore = fetchCalls;
    const response = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/analysis` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as RepositoryAnalysis & { languageProfile?: NonNullable<RepositoryAnalysis["languageProfile"]> };

    const row = body.languageProfile?.languages.find((item) => item.language === "typescript");
    expect(row, "只有一个 .ts 文件的仓，语言分布应当只有 TypeScript 一行").toBeDefined();
    expect(row!.files).toBe(1);
    expect(row!.inDependencyGraph).toBe(true);
    // 档直接从共享表来：界面不许自己判语言
    expect(row!.capabilities.cells.dependencyEdge).toBe("exact");
    // 旧产物的图没有 parseBackend → 按 regex 认，符号抽取那个字段不能因此被说成语法树结果
    expect(body.languageProfile!.parseBackend).toBe("regex");

    // 关键一条：响应里多了字段，库里那份 analysis 不能有——它是缓存键的输入，写回去就等于给全仓重烧开票
    const database = new TutorDatabase(repoDir);
    const stored = database.getAnalysis(repositoryId);
    database.close();
    expect(stored, "落库产物读不出来就没法比对").toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(stored!, "languageProfile")).toBe(false);
    expect(stored!.versionStamp).toBe("content:fixture");
    // 零 token：拿语言画像不该付出任何模型调用
    expect(fetchCalls).toBe(callsBefore);
  });
});

/** llm.log 落点：每次 provider 调用都要有一行；线程归属必须跟着进来（前缀缓存按线程算间隔靠它）。 */
describe("LLM 工作日志落点", () => {
  it("每次 provider 调用追加一行，scene 覆盖三作用域，threadId 与用过的线程全等", async () => {
    await flushLlmLog();
    const lines = readFileSync(join(root, "llm.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBe(fetchCalls);
    // `teaching.action` 这一档随教学状态机一起没了：问答回合每个回合只发一趟措辞调用
    expect(lines.map((line) => line.scene)).toEqual(expect.arrayContaining(["map.chat", "practice.chat", "teaching.turn"]));
    expect(new Set(lines.map((line) => line.scene))).not.toContain("teaching.action");
    // 中止的用例会把请求真打断（provider 收 AbortError），那是唯一允许的 fail 行；其余任何失败都是回归
    const failed = lines.filter((line) => line.ok !== true);
    expect(failed.length, "上面那几个中止用例应该各留下一行 fail（一行都没有就是这条断言空转了）").toBeGreaterThan(0);
    expect(failed.every((line) => String(line.error).includes("已被中止")), `llm.log 里出现了非中止的失败：${JSON.stringify(failed.map((line) => line.error))}`).toBe(true);
    // 四条路径都标了线程：日志里出现的线程集合 == 本文件真正问过的线程集合
    const threads = new Set(lines.map((line) => line.threadId));
    expect(threads).toEqual(usedThreads);
    expect([...threads].every((threadId) => typeof threadId === "string" && threadId.length > 0)).toBe(true);
  });
});

/**
  源码查看的取文件边界。这条路由是裸 `readFileSync`，**不经** `source/read-file.ts` 那道
  「.env / 私钥 / 凭据载体禁读」的闸门，所以它必须只放索引里的文件（索引扩展名白名单本身就不收 `.env`）。
  单元测不出这件事——只有带着真实挂载态打路由，才知道「仓库里躺着一份 .env」时它到底给不给。
  */
describe("GET /source 的取文件边界", () => {
  // ⚠️ 本文件后面的用例靠 beforeAll 手工造的产物（锚点在 src/main.ts:3）跑。往 repoDir 写文件这件事本身
  // 不该惊动重分析（收录判据见 indexer 的 isIngestedPath，#163 那条用例钉着），但挪动用例顺序前先想清楚这一条。
  it("索引里的文件照给；越界 400，未收录（含 .env）404", async () => {
    writeFileSync(join(repoDir, ".env"), "OPENAI_API_KEY=sk-never-serve-me\n", "utf8");

    const served = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/source?path=${encodeURIComponent(MAIN_FILE)}&line=3` });
    expect(served.statusCode).toBe(200);
    const body = served.json() as { path: string; line: number; content: string };
    expect(body.path).toBe(MAIN_FILE);
    expect(body.line).toBe(3);
    expect(body.content).toContain("// line 1");

    const escaped = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/source?path=${encodeURIComponent("../outside.env")}` });
    expect(escaped.statusCode).toBe(400);

    for (const path of [".env", "src/../.env", `${MAIN_FILE}.bak`]) {
      const refused = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/source?path=${encodeURIComponent(path)}` });
      expect(refused.statusCode, `${path} 不该被这条路由读出来`).toBe(404);
      expect(refused.payload).not.toContain("sk-never-serve-me");
    }
  });

  it("line 不是数字时按 1 回，不把 NaN 序列化成的 null 发给界面", async () => {
    const response = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/source?path=${encodeURIComponent(MAIN_FILE)}&line=abc` });
    expect((response.json() as { line: number }).line).toBe(1);
  });

  /**
    路由这一侧也做**链接目标实测**（`pathReadBlock`，与 `read_file` 同一份判据）。
    以前只有工具侧查，HTTP 侧停在「字面路径在不在仓里 + 在不在索引里」：仓里放一个名字无害的链接
    就能只绕过界面那道闸。
    ⚠️ 链接取名 `evidence.txt` 是算过的两难：`.png` 会先被**名字**那道闸拦下（「该文件类型不开放读取」），
    根本走不到链接判定；而 `.ts`/`.md` 这类**收录**扩展名一进仓就是真改动，会排一轮重分析换掉挂载中的产物
    （#163 守的正是这件事）。`.txt` 既不在拒读名单、也不在收录集，才只验链接这一关。
    */
  it("仓里的符号链接指向仓外时，这条路由也给不出原文", async () => {
    const sentinel = "OUTSIDE-SENTINEL-must-not-be-served";
    writeFileSync(join(root, "outside-target.txt"), `${sentinel}\n`, "utf8");
    symlinkSync(join(root, "outside-target.txt"), join(repoDir, "evidence.txt"));

    const response = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/source?path=${encodeURIComponent("evidence.txt")}` });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error?: string }).error).toContain("符号链接指向仓库之外");
    expect(response.payload).not.toContain(sentinel);
    rmSync(join(repoDir, "evidence.txt"), { force: true }); // 只摘链接，仓外那份真目标不动
  });
});

/** UI 动作事件出口：契约里写的「sessionId 有长度上限」得有实现钉住（超长会永久占进 append-only 的审计线）。 */
describe("POST /journal 的入参守卫", () => {
  it("正常 UI 事件带线程 id 能落盘", async () => {
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/journal`, payload: { type: "file_opened", payload: { path: MAIN_FILE }, sessionId: "thread-1" } });
    expect(response.statusCode).toBe(201);
    expect(lastEvent("file_opened").sessionId).toBe("thread-1");
  });

  it("sessionId 超长 / 非字符串一律 400，不落盘", async () => {
    const before = eventsOf("file_opened").length;
    for (const sessionId of ["x".repeat(201), 123]) {
      const refused = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/journal`, payload: { type: "file_opened", payload: { path: MAIN_FILE }, sessionId } });
      expect(refused.statusCode, `sessionId 长度 ${String(sessionId).length} 不该被收下`).toBe(400);
    }
    expect(eventsOf("file_opened").length).toBe(before);
  });

  /**
    审计线不能由被审计的一方填。这条接口本机任何进程都调得到，
    若照旧按「全部事件类型」放行，一行 `code_egress`（哪些代码出过门）或 `token_usage`（花了多少钱）
    就可以被伪造进去——报表再怎么算，算的都是别人想让你看的数。
    */
  it("引擎侧类型从这条接口写不进来：400 且区分「越权」与「未知」", async () => {
    for (const type of ["file_read", "code_egress", "token_usage", "turn_text", "turn_invariant", "session_deleted", "repository_paired"]) {
      const before = eventsOf(type).length;
      const refused = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/journal`, payload: { type, payload: { path: MAIN_FILE } } });
      expect(refused.statusCode, `${type} 是引擎侧类型`).toBe(400);
      expect((refused.json() as { reason?: string }).reason, `${type} 要给出越权而非「不认识」`).toBe("engine_owned_event");
      expect(eventsOf(type).length, `${type} 不该被写进审计线`).toBe(before);
    }
    const unknown = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/journal`, payload: { type: "not_a_real_event", payload: {} } });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { reason?: string }).reason).toBe("unknown_event");
  });

  it("界面侧那 10 类照常能写（收紧审计线不能顺带把可观测性弄丢）", async () => {
    for (const type of UI_JOURNAL_EVENTS) {
      const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/journal`, payload: { type, payload: { where: "/api/x" } } });
      expect(response.statusCode, `${type} 是界面侧类型`).toBe(201);
    }
  });
});

/**
  线程定位**不看挂载集**（LRU 驱逐后仍能取回历史）。
  要拦的事故：内存里只装 `maxMounted()` 个仓，其余被驱逐的仓只是没挂上，它的库一字未动；
  而三条线程路由过去只扫内存，于是「切够几次仓再点开旧对话」会得到一句 会话不存在或已删除 ——
  把还在的历史判没了，改名和删除也一起 404。全程零 token：这几条路由压根不打模型。
  */
describe("未挂载仓库的线程仍可定位", () => {
  it("GET/PATCH/DELETE 三条线程路由不该把被驱逐的会话判成已删除", async () => {
    const registryFile = process.env.TUTOR_REGISTRY_FILE;
    expect(registryFile, "地址簿要指向临时文件").toBeTruthy();
    const original = readFileSync(registryFile!, "utf8");

    // 第二个仓：只建目录并写它自己的库——它**不进挂载路径**（这几条路由只需要库路径，产物在不在都一样读）
    const archivedDir = join(root, "archived");
    mkdirSync(archivedDir, { recursive: true });
    const archivedId = deriveRepositoryId(archivedDir);
    writeFileSync(registryFile!, `${JSON.stringify({ repositories: [repoDir, archivedDir] }, null, 2)}\n`, "utf8");
    const thread = createThread({ repositoryPath: archivedDir, repositoryId: archivedId, scope: "map", title: "旧对话" });
    expect(appendMessages(archivedDir, thread.id, [{ role: "user", content: "上次问到哪了？" }])).toBe(true);

    try {
      // 前提要钉住：它确实没挂在内存里，否则测的还是老那条路
      const catalog = await app.inject({ method: "GET", url: "/api/repositories" });
      const entry = (catalog.json() as { repositories: { repositoryPath: string; mounted: boolean }[] }).repositories
        .find((item) => item.repositoryPath === archivedDir);
      expect(entry?.mounted, "这条用例要跑在「仓未挂载」的前提下").toBe(false);

      const messages = await app.inject({ method: "GET", url: `/api/threads/${thread.id}/messages` });
      expect(messages.statusCode, "被驱逐不等于已删除").toBe(200);
      expect((messages.json() as { messages: { content: string }[] }).messages[0]?.content).toBe("上次问到哪了？");

      expect((await app.inject({ method: "PATCH", url: `/api/threads/${thread.id}`, payload: { title: "改了名" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/api/threads/${thread.id}` })).statusCode).toBe(200);
      // 删掉之后才该是 404：软删的线程读侧恒带 `deleted_at IS NULL`
      expect((await app.inject({ method: "GET", url: `/api/threads/${thread.id}/messages` })).statusCode).toBe(404);
    } finally {
      writeFileSync(registryFile!, original, "utf8");
      rmSync(archivedDir, { recursive: true, force: true });
    }
  });
});

/**
  预算闸门对**付费分支**的放行口径：`monthlyBudgetUsd` 是这产品唯一的省钱开关，调小却不拦就是
  账单照着「没预算」的样子继续走（同族事故：闸门判据散在几处、各写各的，改一处漏一处）。
  这条放在文件末尾，因为它改的是**落库预算**——前面的用例都按默认预算跑；
  全程零 token：被拒的那一支根本不该打到模型上，靠 `fetchCalls` 不增加来硬性约束。
  */
/**
  代码题的题型闸门（刀 2）。**出题与判分的端到端不在这一层测**（`src/exercises/code-generate.test.ts`
  11 例已经用真沙箱跑通了「假 provider 交 harness → 两跑自证 → 交卷判分」全链）：
  这条路由要过就得依赖挂载中的 analysis，而前面用例往 repoDir 写过文件会触发后台重索引、把手搓产物换掉，
  加等待只能买到 flaky，买不到保证。只留确定性的那一条：旧题型必须被闸门拦下。
*/
describe("代码题走通练习路由", () => {
  it("旧题型 output_prediction 已从题型闸门里退出：请求它拿 400，而不是静默出另一道题", async () => {
    const refused = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/exercises`, payload: { kind: "output_prediction" } });
    expect(refused.statusCode).toBe(400);
    expect(String((refused.json() as { error: string }).error)).toContain("不支持的练习题型");
  });
});

describe("预算已达上限时不放行付费分支", () => {
  it("预算 0 ⇒ LLM 出题被拒且一次模型调用都没发生；把预算调回去闸门就翻回放行", async () => {
    const closed = await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: 0 } });
    expect(closed.statusCode).toBe(200);
    const closedBody = closed.json() as { mode: string; settings: { monthlyBudgetUsd: number } };
    expect(closedBody.settings.monthlyBudgetUsd, "预算 0 要如实回读，不能被当成「没给」而回落默认").toBe(0);
    // 0 预算、一分钱没花仍是 degraded：闸门判的是「已花 ≥ 预算」，不是「还剩很多」
    expect(closedBody.mode).toBe("degraded");

    const callsBefore = fetchCalls;
    const refused = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/exercises`, payload: { family: "llm", tag: "依赖注入" } });
    expect(refused.statusCode).toBe(422);
    expect(String((refused.json() as { error: string }).error)).toContain("预算");
    expect(fetchCalls, "达到预算上限后不该把请求打到模型上").toBe(callsBefore);

    // 对照组：同一套运行时设置、只是预算不是 0 ⇒ 闸门翻回放行（证明上面那句 422 来自闸门，不是「没配模型」）
    const reopened = await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
    expect((reopened.json() as { mode: string }).mode).toBe("normal");
  });

  /**
    问答回合与 map/practice 共用同一条闸门：达到预算上限时**开火前就 422**，不再回一段本地文案
    （那段文案是教学状态机造的，阶梯已于 2026-10-14 撤掉）。所以这一轮的账面是「什么都没发生」。
    */
  it("teach 达到预算上限回合：拒在开火前，一次模型调用都不打、一行账都不记", async () => {
    const closed = await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: 0 } });
    expect((closed.json() as { mode: string }).mode).toBe("degraded");
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId, courseNodeId: "unit-1" } });
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const callsBefore = fetchCalls;
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    expect(response.statusCode).toBe(422);
    expect(String((response.json() as { error: string }).error)).toContain("预算");
    expect(fetchCalls, "达到预算上限后这一轮不该打到模型上").toBe(callsBefore);
    // 没开火就没有账：这一轮既不进 token_usage 也不进 turn_text，成本页的「计费回合」不必再减降级行
    expect(eventsOf("token_usage").filter((event) => event.sessionId === sessionId)).toEqual([]);
    expect(eventsOf("turn_text").filter((event) => event.sessionId === sessionId)).toEqual([]);
  });

  /**
    闸门值是这个 describe 唯一的共享状态：每条用例跑完都还回默认预算。
    以前只在用例末尾手抖一句还原——一旦中间某条断言先红，还原就跳不过去，
    后面的 teach/map 用例会整片变成 422（撤掉本地兜底之后，这种泄露再也藏不住）。
    */
  afterEach(async () => {
    await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
  });
});

/**
  本地过筛（零 token）要验的是**位置**：隐去必须发生在下发与落库之前，
  否则用户已经看见了、库里也已经存下了，再改就是事后修饰。
  全程零 token：正文由 stub 的 fetch 给定。
  */
describe("出字前的本地过筛", () => {
  it("疑似密钥与仓库外路径在 reply、chat_message、turn_text 三处都已隐去", async () => {
    scripted = ["凭据写在 sk-abcdefghijklmnop1234 这里，本机路径 /Users/someone/.ssh/id_rsa 也提一下。你觉得该先看哪一处？"];
    const threadId = await newThread("map", "过筛线程");
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "这段配置安全吗？", threadId } });
    expect(response.statusCode).toBe(200);
    const reply = (response.json() as { reply: string }).reply;
    expect(reply).toContain("[疑似密钥，已隐去]");
    expect(reply).toContain("[仓库外路径，已隐去]");
    expect(reply).toContain("本地过筛"); // 改过字要说明，不能暗改
    expect(reply).not.toContain("sk-abcdefghijklmnop");
    expect(reply).not.toContain("someone");
    expect(assistantMessage(threadId).content).toContain("[疑似密钥，已隐去]");
    const text = lastEvent("turn_text");
    expect(text.payload.answer).not.toContain("sk-abcdefghijklmnop");
    const invariant = lastEvent("turn_invariant");
    expect(invariant.payload.masked_secrets).toBe(1);
    expect(invariant.payload.masked_paths).toBe(1);
  });
});

/**
  跨仓能力现在**只在工具面上发生**（界面上那条接缝面板删了）。
  要钉的是两件事：地址簿里有第二个仓时模型才看得见 `cross_repo_link` 与仓名，
  只剩一个仓时工具清单逐字回到从前——多给一个用不上的 schema 字段，就是每轮白付 token，
  还会诱使模型去猜一个不存在的对端仓。全程零 token（fetch 被 stub 到 127.0.0.1:9）。
  */
describe("跨仓工具面随地址簿变", () => {
  it("有第二个仓才给 cross_repo_link 与 repo 参数；没有时清单不变", async () => {
    const registryFile = process.env.TUTOR_REGISTRY_FILE;
    expect(registryFile).toBeTruthy();
    const original = readFileSync(registryFile!, "utf8");
    const peerDir = join(root, "peer-repo");
    mkdirSync(peerDir, { recursive: true });
    const threadId = await newThread("map", "跨仓工具面");
    const ask = () => app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "这个请求打到哪个仓去了？", threadId } });

    try {
      sentTools.length = 0;
      expect((await ask()).statusCode).toBe(200);
      const alone = sentTools[sentTools.length - 1];
      expect(alone.names).toContain("search_code");
      expect(alone.names).not.toContain("cross_repo_link");
      expect(alone.raw).not.toContain("peer-repo");

      writeFileSync(registryFile!, `${JSON.stringify({ repositories: [repoDir, peerDir] }, null, 2)}\n`, "utf8");
      sentTools.length = 0;
      expect((await ask()).statusCode).toBe(200);
      const withPeer = sentTools[sentTools.length - 1];
      expect(withPeer.names).toContain("cross_repo_link");
      expect(withPeer.raw).toContain("peer-repo"); // 仓名进了 read_file/search_code 的 schema，模型才知道该填什么
    } finally {
      writeFileSync(registryFile!, original, "utf8");
      rmSync(peerDir, { recursive: true, force: true });
    }
  });
});
/**
  源码出网清单（`code_egress`，企业化第 3 条）。这条线只有打真路由才算验过——
  它要同时证明三件事，缺一件就是报表上看不出来的错：
  1. **装配里真放了源码的那次调用才计入审计**，且一一对得上形态（锚点摘录 / 整文件切片 / 流程窗口 / 出题摘录）；
  2. **行里有指纹而没有正文**——审计线自己不能变成第二个泄露面（`.tutor/` 是随仓可带走的东西）；
  3. 同一段代码在**动作提议与措辞两次调用里各出一次门**，就记两条，不合并成一条好看的数。
  零 token：fetch 仍被 stub 到 127.0.0.1:9。
  */
describe("源码出网清单", () => {
  const egress = () => eventsOf("code_egress");
  const sentFields = (row: JournalEvent) => Object.keys(row.payload).sort();

  it("宏观设计回合：锚点摘录逐段计入审计，带线程 id，且不含源码正文", async () => {
    const before = egress().length;
    const threadId = await newThread("map", "出网线程");
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "这一节先看哪里？", threadId, nodeId: "unit-1" } });
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
    const threadId = await newThread("map", "无源码出网线程");
    const response = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "这个项目整体是做什么的？", threadId } });
    expect(response.statusCode).toBe(200);
    expect(egress().slice(before)).toEqual([]);
  });

  it("教学回合：只剩措辞那一趟调用，同一段摘录就只记一次（撤掉动作提议前的两次出网已成历史）", async () => {
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId, courseNodeId: "unit-1" } });
    const sessionId = (created.json() as { session: { id: string } }).session.id;
    usedThreads.add(sessionId);
    const before = egress().length;
    scripted = [`registerOrder 在 ${MAIN_FILE}:3 先跑，你觉得少了哪一步会先炸？`];
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    expect(response.statusCode).toBe(200);

    const rows = egress().slice(before);
    const scenes = new Set(rows.map((row) => row.payload.scene));
    // 以前这里是两档（teaching.action + teaching.turn）：动作提议那一趟随状态机一起撤了，只剩措辞那一趟
    expect([...scenes].sort()).toEqual(["teaching.turn"]);
    // 真的带着那段摘录出门：不是只记了一条「本轮看过 src/main.ts」
    for (const scene of scenes) expect(rows.filter((row) => row.payload.scene === scene).map((row) => row.payload.path)).toContain(MAIN_FILE);
    expect(rows.every((row) => row.sessionId === sessionId)).toBe(true);
    expect(rows.some((row) => JSON.stringify(row).includes("// line 3"))).toBe(false);
  });
});

/**
  上面那两条出网用例在整包并行时偶发拿到 0 行（#163）。差别不在出网代码，而在**挂载中的产物被换掉了**：
  本文件的密钥用例往仓里写过 `.env` 与 `credentials.json`，而监听层当时的判据是「非忽略、非产物路径的改动就算源码改动」，
  于是那两次写入各自排了一轮全量重分析（450ms 防抖 + 扫描重算），产物里的 `unit-1` 锚点被真实扫描结果取代——
  出网装配读不到摘录，回合作 200 但一行账都没有。快慢机器上「重分析落到出网用例之前还是之后」不同 ⇒ 同一条用例两种结果。
  收尾后的口径：**只有「可能改变收录集」的改动才叫醒重分析**（收录判据见 indexer 的 isIngestedPath）。
*/
describe("非收录文件的写入不该换掉挂载中的产物", () => {
  it("写 .env 与 credentials.json 后：等到防抖+重扫都远超，产物仍是那份 fixture", async () => {
    writeFileSync(join(repoDir, ".env"), "OPENAI_API_KEY=sk-still-not-a-source-change\n", "utf8");
    writeFileSync(join(repoDir, "credentials.json"), '{"aws_access_key_id":"AKIA-STILL-NOT-A-SOURCE-CHANGE"}\n', "utf8");
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const response = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/analysis` });
    expect(response.statusCode).toBe(200);
    const analysis = response.json() as { versionStamp: string; graph: { symbols: { path: string }[] }; lastIncrementalUpdate?: { changedPaths: string[] } };
    // 重分析一跑，versionStamp 就从「手工造的 content:fixture」翻成真实内容哈希，锚点同时消失
    expect(analysis.versionStamp, `非收录文件的写入不该触发重分析；这轮被 ${JSON.stringify(analysis.lastIncrementalUpdate?.changedPaths ?? null)} 叫醒`).toBe("content:fixture");
    expect(analysis.graph.symbols.map((symbol) => symbol.path), "符号表不该被换成真实扫描的空结果").toContain(MAIN_FILE);
  });
});

/**
  来源闸（#166 第一层）。CORS 原先写的是 `{ origin: true }` ——反射任意来源，而只听 127.0.0.1 挡不住：
  浏览器里任意网页都能把请求打到这个地址，发请求不需要跨域权限，只有读响应才需要。
  2026-10-15 认证闸整体撤除（§64）之后**这一道就是唯一的 Web 闸**，而它只管「哪个页面能碰这台引擎」，
  不管「本机哪个进程能碰」——后者从此没有判据。

  这一组用例把三件事分开钉住：① 非可信来源被拒在**执行之前**（不只是不给 CORS 头）；
  ② 回环来源与不带 Origin 的本机调用方照常能用（产品形态不能被锁死）；③ 放宽只有一个口子（TUTOR_ALLOWED_ORIGINS）。
*/
describe("来源闸：默认只服务本机浏览器", () => {
  const EVIL = "http://evil.example";
  const fromEvil = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { origin: EVIL, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload } : {}) });

  it("非可信来源读不到源码，响应也不带 access-control-allow-origin", async () => {
    const refused = await fromEvil("GET", `/api/repositories/${repositoryId}/source?path=${encodeURIComponent(MAIN_FILE)}`);
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { reason?: string }).reason).toBe("origin_not_trusted");
    expect(refused.headers["access-control-allow-origin"], "不给回头：浏览器连读响应的资格都没有").toBeUndefined();
    expect(refused.payload).not.toContain("// line 1");
  });

  it("非可信来源改不动出网端点：403 之外更要紧的是**没执行**", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/llm/settings" })).json() as { baseUrl?: string };
    const refused = await fromEvil("PUT", "/api/llm/settings", { baseUrl: "http://evil.example:9/v1" });
    expect(refused.statusCode).toBe(403);
    const after = (await app.inject({ method: "GET", url: "/api/llm/settings" })).json() as { baseUrl?: string };
    expect(after.baseUrl, "闸拦的是这一次改配置，不是只挡响应可见性").toBe(before.baseUrl);
  });

  it("非可信来源触发不了导入：地址簿与挂载集合一条都没多", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: unknown[] };
    const refused = await fromEvil("POST", "/api/imports", { path: join(root, "not-a-repo-from-evil") });
    expect(refused.statusCode).toBe(403);
    const after = (await app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: unknown[] };
    expect(after.repositories.length).toBe(before.repositories.length);
  });

  it("连 /api/health 也不白给：这道闸免的是「不带 Origin 的本机调用」，不是「任意网页」", async () => {
    // 进程管理器与本机 curl 不带 Origin，照样走得通；健康读数里有服务商、模型名、沙箱闸门状态，
    // 那是给下一步攻击踩点用的，不该让任意网页白拿
    const refused = await fromEvil("GET", "/api/health");
    expect(refused.statusCode).toBe(403);
    expect(refused.payload).not.toContain("fixture-model");
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode, "本机 curl（无 Origin）照常用").toBe(200);
  });

  it("回环来源任何端口都放行——GUI 的正常形态没被这次收紧锁死", async () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:5199", "http://[::1]:3001"]) {
      const response = await app.inject({ method: "GET", url: "/api/repositories", headers: { origin } });
      expect(response.statusCode, origin).toBe(200);
      expect(response.headers["access-control-allow-origin"], origin).toBe(origin);
    }
  });

  it("唯一的放宽口子是清单本身：写进 TUTOR_ALLOWED_ORIGINS 才认，且按精确来源匹配", async () => {
    process.env.TUTOR_ALLOWED_ORIGINS = `${EVIL}, https://Tutor.Corp.dev:8443/`;
    try {
      expect((await fromEvil("GET", "/api/repositories")).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/repositories", headers: { origin: "https://tutor.corp.dev:8443" } })).statusCode).toBe(200);
      // 端口是来源的一部分：清单里那条带 8443，不带端口的同一个主机名不算命中（别把精确匹配读成前缀匹配）
      expect((await app.inject({ method: "GET", url: "/api/repositories", headers: { origin: "https://tutor.corp.dev" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/api/repositories", headers: { origin: `${EVIL}.evil.example` } })).statusCode).toBe(403);
    } finally {
      delete process.env.TUTOR_ALLOWED_ORIGINS;
    }
    expect((await fromEvil("GET", "/api/repositories")).statusCode, "清单一撤就恢复默认关").toBe(403);
  });
});

/**
  两个控制口的路由级验收（#173 与 #164）。它们测的都是「人能不能当场改变引擎的状态并看见结果」：
  挂起监听是「我接下来要改这个仓，别在此期间重烧」，重探沙箱是「环境修好了，别逼我重启进程」。
  两条都不花钱：前者不触发任何调用，后者打的是探测进程自己起的回环监听。
  */
describe("编辑期免打扰与沙箱重探", () => {
  afterEach(() => {
    // 挂起态不能留给后面的用例：它会让这个仓的增量监听在别的用例里静默缺席
    app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/watch`, payload: { paused: false } });
  });

  it("挂起 → 地址簿读数跟着变 → 恢复；这条路由不会顺带重分析", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: { repositoryId: string; watchPaused?: boolean }[] };
    expect(before.repositories.find((item) => item.repositoryId === repositoryId)?.watchPaused, "前提：默认没有挂起").toBeUndefined();

    const paused = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/watch`, payload: { ttlMs: 5 * 60_000 } });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { paused: boolean; watching: boolean }).paused).toBe(true);

    const catalog = (await app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: { repositoryId: string; watchPaused?: boolean; watchPausedUntil?: string }[] };
    const entry = catalog.repositories.find((item) => item.repositoryId === repositoryId);
    expect(entry?.watchPaused).toBe(true);
    expect(new Date(entry?.watchPausedUntil ?? 0).getTime()).toBeGreaterThan(Date.now());

    const resumed = (await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/watch`, payload: { paused: false } })).json() as { paused: boolean; woken: boolean };
    expect(resumed).toMatchObject({ paused: false, woken: true });
    const after = (await app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: { repositoryId: string; watchPaused?: boolean }[] };
    expect(after.repositories.find((item) => item.repositoryId === repositoryId)?.watchPaused, "恢复后读数要跟着回来").toBeUndefined();
  });

  it("地址簿里没有的仓连挂起都谈不上：懒挂载钩子先 404，原因如实给出", async () => {
    const missing = await app.inject({ method: "POST", url: "/api/repositories/repo_not_in_the_book/watch", payload: { paused: true } });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { reason?: string }).reason, "这条路由不重复实现「仓在不在」的判断，口径与其余带 :repositoryId 的路由同一处").toBe("not_in_catalog");
  });

  /**
    重探的断言刻意与环境无关：**能判的都要判准**，但「判成什么」允许随环境变——
    能跑嵌套 `sandbox-exec` 的机器上是 enforced，受限 CI 上是 unavailable，**两者都是合法读数**
    （用户 10-15 那句：环境不支持不能伪装成通过）。
    ⚠️ 唯一不能拿「环境」当借口的是**形状**：等级、白话原因、时间戳、逐项布尔。
    ⚠️ 逐项 canary 只在**这台机器有隔离后端**时才存在：`isolationBackend()` 判没有时探测直接短路（Linux CI），
    那种读数是「零项 + unavailable + 一句原因」，硬要它 `>3` 项红的是环境。判据与产品同源，不另写一份 platform 判断。
    ⚠️ 超时给到 30 秒是实测逼出来的：这一发单独跑 2.7~4.5 秒，全量并行时**实测撞过 vitest 默认的 5 秒**（用例本身没红在断言上，红在没时间）。
    它要起十来个沙箱子进程，不是能被别的用例挤一挤就该判失败的逻辑问题。
    */
  it("POST /api/sandbox/reprobe 返回新的实测读数，字段形状与开机那份一致", async () => {
    const response = await app.inject({ method: "POST", url: "/api/sandbox/reprobe" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { sandbox: { level: string; checks: { name: string; passed: boolean }[]; reason: string; probedAt: string } };
    expect(["enforced", "unavailable"]).toContain(body.sandbox.level);
    expect(body.sandbox.reason.length, "界面直接显示这句白话原因，不能空").toBeGreaterThan(0);
    if (isolationBackend().available) {
      expect(body.sandbox.checks.length, "有后端的机器上一次重探必须给出逐项 canary，而不是一个总判断").toBeGreaterThan(3);
    } else {
      // 没有后端却报出 canary，那是编的；报了 enforced 更是要命（整域禁用的闸门被绕过）
      expect(body.sandbox.checks, "零 canary 才是这台机器的实话").toEqual([]);
      expect(body.sandbox.level).toBe("unavailable");
    }
    expect(body.sandbox.checks.every((check) => typeof check.passed === "boolean")).toBe(true);
    expect(new Date(body.sandbox.probedAt).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
    // 与开机那份同源：/api/health 的 sandbox 必须已经是重探之后的读数
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json() as { sandbox: { probedAt: string } };
    expect(health.sandbox.probedAt).toBe(body.sandbox.probedAt);
  }, 30_000);
});

/**
  架构视图这条新链路的路由级验收（分层产物 + 覆盖层）。为什么必须打到路由：
  `/course` 与 `/architecture` 要在实时计算完 tier 之后叠**同一份**人工覆盖层——
  两条出口的叠放顺序或来源差一点，用户拖完模块、切个 tab 就看到模块回到原位，
  而这种事各测各的单测永远发现不了。零 token：假 provider 仍指向 127.0.0.1:9。
*/
describe("架构视图：分层产物与人工覆盖层", () => {
  it("读侧一发不发，只有 regenerate 花钱；模型给的箭头一个字都不进产物", async () => {
    type Plan = { layers: { name: string; moduleIds: string[] }[]; edges: unknown[]; externals: unknown[]; source: string; unavailableReason?: string; reason?: string; externalsNote?: string; usage?: unknown; blocks?: { id: string }[]; sideModules?: number };
    // ① 打开画布（GET）：这个仓还没判过层，路由必须只给静态三层，一次请求都不发
    const coldCalls = sentTools.length;
    const cold = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/architecture` })).json() as Plan;
    expect(sentTools.length, "读侧不许自己发一发：否则「打开画布」这个动作就静默产生一笔没人确认的钱").toBe(coldCalls);
    expect(cold.source).toBe("unavailable");
    expect(cold.unavailableReason).toBe("not_judged");
    expect(cold.layers, "没判过就一个节点都不画：以前这里塞的是按结构角色分的三层").toEqual([]);
    expect(cold.reason).toContain("还没判过层");
    expect(cold.usage).toBeUndefined();

    // ② 显式重问：这一发才是付费路径
    scripted = [JSON.stringify({ layers: [
      { name: "接入", duty: "把请求收进来", modules: ["module:src"] },
      { name: "存储", duty: "落库", modules: [] }
    ], edges: [{ from: "接入", to: "存储", weight: 12 }] })];
    const regen = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/architecture/regenerate` });
    expect(regen.statusCode).toBe(200);
    expect(sentTools.length, "付费那一下要真发出去").toBe(coldCalls + 1);
    const plan = regen.json() as Plan;
    expect(plan.layers.map((layer) => [layer.name, layer.moduleIds]), "模块为空的层不占一栏").toEqual([["接入", ["module:src"]]]);
    expect(plan.edges, "fixture 的图里没有跨模块 import 边，就该一条箭头都没有").toEqual([]);
    expect(JSON.stringify(plan.edges), "模型给的 12 权重箭头一个字都不许进产物").not.toContain("12");
    expect(plan.reason, "模型试图发明箭头这件事要留下读数").toContain("已丢弃");
    expect(plan.source).toBe("llm");
    expect(plan.externals).toEqual([]);
    expect(`${plan.externalsNote ?? ""}${plan.reason ?? ""}`, "旧产物没采过外部包名 ⇒ 那一栏为空必须给原因").toContain("还没采外部");

    // ③ 发明过边的那一份不落盘（payload 与产出不同构），所以下一次读还是静态——不发第二发
    const afterBad = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/architecture` })).json() as Plan;
    expect(sentTools.length, "读侧仍然一发不发").toBe(coldCalls + 1);
    expect(afterBad.source).toBe("unavailable");

    // ④ 干净的一份判层落盘后，读侧命中缓存：同一笔钱不被计两次
    //    清单只有 `module:src` 一个节点：另一个模块（docs/design.md）没人引用、入口也走不到，压缩那处改动已经把它删了
    scripted = [JSON.stringify({ layers: [{ name: "接入", duty: "把请求收进来", modules: ["module:src"] }] })];
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/architecture/regenerate` });
    expect(sentTools.length).toBe(coldCalls + 2);
    const hit = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/architecture` })).json() as Plan;
    expect(sentTools.length, "命中缓存不许再发").toBe(coldCalls + 2);
    expect(hit.source).toBe("llm");
    expect(hit.usage, "命中缓存不报用量").toBeUndefined();
    expect(hit.layers.map((layer) => layer.name)).toEqual(["接入"]);
    expect(hit.blocks?.map((block) => block.id), "节点清单是读的时候实时计算的，命中原判也照样带上").toEqual(["module:src"]);
    expect(hit.sideModules, "藏掉几个节点要有读数，不然界面与产物两头都问不出「这是全部还是筛过的」").toBe(1);
    expect(JSON.stringify(hit.blocks), "孤立节点不该连累付费载荷").not.toContain("module:docs");

    // ⑤ 被藏的那个节点也能靠一次修正回到图上（agent 说「这个文档不算孤立节点」的那条出口）
    const applied = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/overlays/apply`, payload: { intent: { kind: "move_module", module: "module:docs", layer: "接入" }, via: "agent" } });
    expect(applied.statusCode, "把模块挪进现有层要写成功（失败原因看 response）").toBe(200);
    const rejected = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/overlays/apply`, payload: { intent: { kind: "move_module", module: "module:src", layer: "图上没有的这一层" }, via: "agent" } });
    expect(rejected.statusCode).toBe(422);
    const body = rejected.json() as { text: string; error?: string };
    expect(body.error, "拒写理由要同时进 `error`：GUI 的 fetch 封装只认这个字段，不然用户只看到一句通用的「没送达」").toBe(body.text);
    const dragged = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/architecture` })).json() as Plan;
    expect(sentTools.length, "挪一下不是重判的理由：为此翻缓存键就等于每次修正 ¥0.02 ¥0.02").toBe(coldCalls + 2);
    expect(dragged.source).toBe("llm");
    expect(dragged.layers.map((layer) => [layer.name, layer.moduleIds]), "原判只有一个节点，挪进来的那个节点跟着它").toEqual([["接入", ["module:src", "module:docs"]]]);
    // 撤掉修正：那个节点重新被藏起来，读侧回到原判，同样不发请求
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/overlays/apply`, payload: { intent: { kind: "reset", module: "module:docs" }, via: "agent" } });
    const restored = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/architecture` })).json() as Plan;
    expect(sentTools.length).toBe(coldCalls + 2);
    expect(restored.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([["接入", ["module:src"]]]);
    expect(restored.blocks?.map((block) => block.id), "节点清单是算出来的，判没判都在").toEqual(["module:src"]);

    // ⑥ 重判换了层名：落不了地的修正必须说出来（以前是一条无声的 continue）
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/overlays/apply`, payload: { intent: { kind: "rename_layer", from: "接入", to: "入口层" }, via: "agent" } });
    scripted = [JSON.stringify({ layers: [{ name: "接口与契约", duty: "对外与形状", modules: ["module:src"] }] })];
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/architecture/regenerate` });
    const stale = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/architecture` })).json() as Plan & { lostOverrides?: { kind: string; module?: string; layer?: string; from?: string }[] };
    expect(sentTools.length, "失效读数是读的时候实时计算的，不该为它多发一发").toBe(coldCalls + 3);
    expect(stale.lostOverrides, "「接入」这个旧层名重判后没了 ⇒ 那次改名落空，要如实报").toEqual([{ kind: "rename_layer", from: "接入" }]);
    expect(stale.layers.map((layer) => layer.name), "落空就不动模块：只留模型判的那一层").toEqual(["接口与契约"]);
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/overlays/apply`, payload: { intent: { kind: "reset", layerRename: "接入" }, via: "agent" } });
  });

  it("覆盖层写进去后 /course 看得见，撤掉之后回到引擎原判的那一档", async () => {
    const patched = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/overlays`, payload: { modules: { tier: { "module:src": "core" } }, architecture: { moduleLayer: { "module:docs": "接入" } } } });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { overlays: { modules?: { tier?: Record<string, string> }; architecture?: { moduleLayer?: Record<string, string> } }; counts: { modules: number; layers: number } };
    expect(body.overlays.modules?.tier?.["module:src"]).toBe("core");
    expect(body.overlays.architecture?.moduleLayer?.["module:docs"]).toBe("接入");
    expect(body.counts).toEqual({ modules: 1, layers: 1 });

    const course = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/course` })).json() as { root: { children: { id: string; children: { id: string; tier?: string; tierGiven?: string; tierOverridden?: boolean }[] }[] } };
    const src = course.root.children.find((node) => node.id === "modules")!.children.find((node) => node.id === "module:src")!;
    expect(src.tier, "人工改的档要出现在这条出口上").toBe("core");

    const removed = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/overlays`, payload: { remove: { modules: { tier: ["module:src"] }, architecture: { moduleLayer: ["module:docs"] } } } });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { counts: unknown }).counts).toEqual({ modules: 0, layers: 0 });
    const read = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/overlays` })).json() as { overlays: { modules?: { tier?: Record<string, string> } } };
    expect(read.overlays.modules?.tier ?? {}, "撤档要真删掉那条记录，不能留个空值").not.toHaveProperty("module:src");
  });
});

/**
  「推荐入口」这条路由以前只有 entry-suggest 的单测兜着（判据住在那一层）。这次补路由级用例是因为
  改的是**什么有资格当入口**：只有打一次路由才看得见送出去的候选载荷里真没有文档，而不只是本地算对了。
  零 token：假 provider 照样指向 127.0.0.1:9，被 stub 的 fetch 接住。
*/
describe("流程视图的只读出口（MCP 的 repo_flow 打的是这一条）", () => {
  type FlowResponse = { flow: { entry: { path: string }; title: string }; source: string; reason?: string };

  it("readonly=1 冷缓存一发不发、回静态调用链并说明原因；不带它的默认路由才会发模型", async () => {
    const before = sentTools.length;
    const cold = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/flow?readonly=1&entry=${encodeURIComponent(MAIN_FILE)}` })).json() as FlowResponse;
    expect(sentTools.length, "只读读数一发都不许发：外部 agent 问一句流程不该产生账单").toBe(before);
    expect(cold.source).toBe("static");
    expect(cold.reason).toContain("只读请求");
    expect(cold.flow.entry.path).toBe(MAIN_FILE);

    // 对照：同一个入口走默认那条路由，冷缓存确实会发一趟（这一发钱是界面上的流程视图点的）
    scripted = ["这不是流程 JSON，解析不过——但请求已经发出去了"];
    const open = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/flow?entry=${encodeURIComponent(MAIN_FILE)}` });
    expect(open.statusCode).toBe(200);
    expect(sentTools.length, "默认路由该发模型；否则这条对照测试什么都没说明").toBeGreaterThan(before);
  });
});

describe("推荐入口：文档不进候选清单", () => {
  it("文档在课程树上、却不在出网载荷里；模型回推它的 id 也不会被路由复活", async () => {
    const tree = (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/course` })).payload;
    expect(tree, "前提：fixture 里得有那个文档节点，否则下面的「不含」是空的通过").toContain("docs/design.md");

    const outboundBefore = sentTools.length;
    scripted = ['["design"]', '[{"id":"unit-doc","reason":"设计文档正是主题入口"},{"id":"unit-1","reason":"实现主干"}]'];
    const response = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/module-entries?module=${encodeURIComponent("设计文档")}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: { id: string; path: string }[]; source: string };
    // 模型按旧习惯先推文档：池子里没有这个 id，路由只返回代码那条，而不是替它把文档复活
    expect(body.entries.map((entry) => entry.id)).toEqual(["unit-1"]);
    expect(body.source).toBe("llm");

    const outbound = sentTools.slice(outboundBefore).map((call) => call.raw).join("\n");
    expect(outbound, "文档连候选都不是：不该进过一次出网载荷").not.toContain("docs/design.md");
    expect(outbound).toContain(MAIN_FILE);
    // 翻译层的词表同样来自池子：文档路径切出来的 design/md 不该进 repoVocabulary
    expect(sentTools.slice(outboundBefore)[0].raw).not.toContain('"md"');
  });
});

/**
  「重绘这张图」这条动线（§72）。打到路由的原因很具体：这一条上**谁付钱、谁能批准**是产品红线，
  而它只能从 HTTP 侧看出来——`propose` 必须一发不发，`run` 必须等用户点横幅，`commit` 必须只有用户能按。
*/
describe("重绘这张图：提议 → 预览 → 替换 → 恢复默认", () => {
  type DiagramView = {
    origin: "default" | "agent";
    purpose?: string;
    stale?: string;
    pending?: { purpose: string };
    preview?: { purpose: string; draft: { kind: string; layers: { name: string; nodes: string[] }[]; omitted: unknown[]; conflicts: { node: string }[] } };
    conflicts?: { node: string }[];
  };
  type ArchView = {
    layers: { name: string; moduleIds: string[] }[];
    source: string;
    diagram?: DiagramView;
  };
  const read = async (): Promise<ArchView> => (await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/architecture` })).json() as ArchView;
  const EXPLORE = '{"findings":[{"unit":"src","claim":"这里注册路由并把请求交给编排","evidence":"src/main.ts:3"}],"boundaries":"框内是仓里写的代码","notes":""}';
  const DRAFT = JSON.stringify({ layers: [{ name: "接入", duty: "收请求", nodes: ["module:src"] }, { name: "说明", duty: "记录设计与约定", nodes: ["module:docs"] }], omitted: [] });

  it("propose 一个 token 都不发；run 才发那两趟；替换与恢复默认都不再花钱", async () => {
    const before = sentTools.length;
    const missing = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "propose" } });
    expect(missing.statusCode, "没有目的的图只是换一种画法，得先问用户").toBe(422);

    const proposed = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "propose", purpose: "给第一次进这个仓的人讲模块边界" } });
    expect(proposed.statusCode).toBe(200);
    expect((proposed.json() as { status: string }).status).toBe("pending");
    expect(sentTools.length, "挂一条提议不该发出任何一发请求").toBe(before);

    const early = await read();
    expect(early.diagram?.pending?.purpose).toContain("模块边界");
    expect(early.diagram?.origin, "还没画，画的仍是默认那份").toBe("default");

    const tooEarly = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "commit" } });
    expect(tooEarly.statusCode, "没有预览就替换是凭空造一张图").toBe(422);

    scripted = [EXPLORE, DRAFT];
    const drawn = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "run" } });
    expect(drawn.statusCode, (drawn.json() as { error?: string }).error ?? "").toBe(200);
    expect(sentTools.length, "取证 + 出图：这一趟正好两发").toBe(before + 2);
    const previewing = await read();
    expect(previewing.diagram?.preview?.draft.layers.map((layer) => layer.name)).toEqual(["接入", "说明"]);
    expect(previewing.diagram?.origin, "预览态不改变生效的那张").toBe("default");
    expect(previewing.layers.map((layer) => layer.name), "画布取数的 layers 仍是默认那份的层").not.toEqual(["接入", "说明"]);

    const committed = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "commit" } });
    expect(committed.statusCode).toBe(200);
    const replaced = await read();
    expect(replaced.diagram?.origin).toBe("agent");
    expect(replaced.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([["接入", ["module:src"]], ["说明", ["module:docs"]]]);
    expect(replaced.diagram?.preview, "替换完预览就没了").toBeUndefined();
    expect(replaced.diagram?.conflicts ?? [], "这两个节点的角色与所在层并不相反（一个节点一层），不该硬造反证").toEqual([]);

    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "reset" } });
    const restored = await read();
    expect(restored.diagram?.origin, "删掉替换那一行，默认那份立刻回来（它一直实时计算实时叠加着）").toBe("default");
    expect(sentTools.length, "四个动作里只有 run 发过请求").toBe(before + 2);
  });

  it("没有待确认的提议时 run 拒；agent 手上只有 propose / keep / reset", async () => {
    const orphan = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "run" } });
    expect(orphan.statusCode, "用户没点横幅就不该发这一发").toBe(422);

    const before = sentTools.length;
    const threadId = await newThread("map", "重绘线程");
    // 第一回合模型想一步做完：直接 commit。工具回执必须拒，且**图不能被它替换掉**
    scripted = [`@@tool redraw_diagram {"action":"commit"}`, "这一步我没权限，得你在画布上点。"];
    const turn = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "把刚才那张直接换上", threadId } });
    expect(turn.statusCode).toBe(200);
    expect(sentTools[0]?.names, "map 作用域每一轮都该有这个工具（不要求先选中模块）").toContain("redraw_diagram");
    const second = sentTools[sentTools.length - 1]?.raw ?? "";
    expect(second, "工具回执要回实话：这一动作不由 agent 按").toContain("不由你按");
    expect((await read()).diagram?.origin, "被拒之后生效的那张没变").toBe("default");

    // 第二回合走正路：propose 仍然一发不发（除了对话本身那发）
    const beforePropose = sentTools.length;
    scripted = [`@@tool redraw_diagram {"action":"propose","purpose":"只看下单这条链路"}`, "已把提议挂到画布上，等你点开始重绘。"];
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/map-chat`, payload: { content: "换个角度看这张图", threadId } });
    const pending = await read();
    expect(pending.diagram?.pending?.purpose).toBe("只看下单这条链路");
    expect(sentTools.length, "对话两发之外，propose 没多花任何一发").toBe(beforePropose + 2);
    await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/diagram/redraw`, payload: { kind: "architecture", action: "keep" } });
    expect(sentTools.length - before, "整段对话只发了回合本身的请求：重绘一步没花钱").toBe(4);
  });
});
