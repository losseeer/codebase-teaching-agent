import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ChatThreadMessage, CourseTree, ImportEstimate, JournalEvent, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { repositoryId as deriveRepositoryId } from "./lib.js";
import { defaultMonthlyBudgetUsd } from "./cost/cost.js";
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
  2. `turn_invariant` 一定落 journal（合格也记，分母才在环内成立）；
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

function decisionCall(raw: string): boolean {
  return raw.includes("动作决策器") || raw.includes("意图分类");
}

function replyFor(raw: string): string {
  if (decisionCall(raw)) return "（测试：本轮不给动作提议）";
  const next = scripted.shift();
  if (next) spoken = next;
  return spoken;
}

async function fakeFetch(_url: unknown, init?: { body?: string }): Promise<Response> {
  fetchCalls += 1;
  const raw = String(init?.body ?? "{}");
  const payload = {
    choices: [{ message: { content: replyFor(raw) }, finish_reason: "stop" }],
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
      children: [{ id: "unit-1", title: "注册顺序", summary: "builder 先注册再分发。", kind: "implementation", anchors: [{ path: MAIN_FILE, line: 3, label: "入口" }], children: [] }]
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
  database.putExerciseCache(repositoryId, "content:fixture", "output_prediction", "unit-1", {
    exercise: {
      id: exerciseId, repositoryId, contentVersion: "content:fixture", kind: "output_prediction",
      targetUnitId: "unit-1", targetTitle: "注册顺序", difficulty: 1, title: "预测输出", prompt: "改这一行会先影响谁？",
      anchors: [{ path: MAIN_FILE, line: 3, label: "入口" }], inputMode: "text", gradingMode: "execution", createdAt: now
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

  it("teach：合格回合 applicable 含三条不变量、无尾注，done.message 与库里正文一致", async () => {
    const sessionId = await openSession();
    scripted = [`registerOrder 在 ${MAIN_FILE}:3 先跑，你觉得少了哪一步会先炸？`];
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    const { reply, events } = replyOf(response.payload);

    const invariant = lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("teach");
    const applicable = String(invariant.payload.applicable);
    expect(applicable).toContain("reference-grounding");
    expect(applicable).toContain("socratic-question");
    expect(applicable).toContain("anchor-binding");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(sessionId);

    expect(reply).not.toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(assistantMessage(sessionId).content).toBe(reply);
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("teach：没问句 + 假引用双双失守，尾注只由引用触发但仍进正文与库里", async () => {
    const sessionId = await openSession();
    scripted = ["直接讲结论，registerOrder 的作用与 src/missing.ts:1 无关。"];
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "再讲一遍" } });
    const { reply, events } = replyOf(response.payload);

    const failed = String(lastEvent("turn_invariant").payload.failed);
    expect(failed).toContain("reference-grounding");
    expect(failed).toContain("socratic-question");

    expect(reply).toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(assistantMessage(sessionId).content).toBe(reply);
    expect(lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("teach：通俗档不再判「点名标识符」，但引用与问句照判（档位只在环内生效才算数）", async () => {
    const sessionId = await openSession({ style: 80 });
    const answer = "这一步就是把请求交给注册表，你说先看哪个文件？";
    scripted = [answer];
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "换个通俗点的说法" } });
    const { reply } = replyOf(response.payload);

    const invariant = lastEvent("turn_invariant");
    const applicable = String(invariant.payload.applicable);
    expect(applicable).toContain("socratic-question");
    expect(applicable).not.toContain("anchor-binding");
    // 没有引用形态的串 → 引用这条缩出分母，分母如实记
    expect(applicable).not.toContain("reference-grounding");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(reply).toBe(answer);
  });
});

/** 语言画像：架构视图要能说清「这条边有多硬」，而这份口径只能读侧现算。 */
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
    // 旧产物的图没有 parseBackend → 按 regex 认，符号抽取那一格不能因此被说成语法树结果
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
    expect(lines.map((line) => line.scene)).toEqual(expect.arrayContaining(["map.chat", "practice.chat", "teaching.turn", "teaching.action"]));
    expect(lines.every((line) => line.ok === true)).toBe(true);
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
  这条放在文件末尾，因为它改的是**落库预算**——前面的用例都按缺省预算跑；
  全程零 token：被拒的那一支根本不该打到模型上，靠 `fetchCalls` 不增加来钉死。
  */
describe("预算触顶时不放行付费分支", () => {
  it("预算 0 ⇒ LLM 出题被拒且一次模型调用都没发生；把预算调回去闸门就翻回放行", async () => {
    const closed = await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: 0 } });
    expect(closed.statusCode).toBe(200);
    const closedBody = closed.json() as { mode: string; settings: { monthlyBudgetUsd: number } };
    expect(closedBody.settings.monthlyBudgetUsd, "预算 0 要如实回读，不能被当成「没给」而回落缺省").toBe(0);
    // 0 预算、一分钱没花仍是 degraded：闸门判的是「已花 ≥ 预算」，不是「还剩很多」
    expect(closedBody.mode).toBe("degraded");

    const callsBefore = fetchCalls;
    const refused = await app.inject({ method: "POST", url: `/api/repositories/${repositoryId}/exercises`, payload: { family: "llm", tag: "依赖注入" } });
    expect(refused.statusCode).toBe(422);
    expect(String((refused.json() as { error: string }).error)).toContain("预算");
    expect(fetchCalls, "触顶后不该把请求打到模型上").toBe(callsBefore);

    // 对照组：同一套运行时设置、只是预算不是 0 ⇒ 闸门翻回放行（证明上面那句 422 来自闸门，不是「没配模型」）
    const reopened = await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
    expect((reopened.json() as { mode: string }).mode).toBe("normal");
  });

  /**
    降级那一轮的账面：`token_usage` 必须**只**在真调用过模型时才有 token，而「这一轮走了本地规则」
    得有一条 `mode: "degraded"` 的记录。两条口径曾经都错——正文按字数÷4 造一份不存在的 token（免费回合
    吃掉预算，反过来把付费分支关掉），而记账处又改看「本会话累计成本」，于是闸门放行了却没人知道。
    这条同时是那个事故的回归网。
    */
  it("teach 降级回合：一条模型调用都不打，token 记 0，且降级留痕确实落进 journal", async () => {
    await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: 0 } });
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId, courseNodeId: "unit-1" } });
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const callsBefore = fetchCalls;
    const response = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    const events = sseEvents(response.payload);
    expect(events.some((event) => event.type === "error" || event.type === "aborted"), "降级回合照样要走完收尾").toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(fetchCalls, "预算触顶后这一轮不该打到模型上").toBe(callsBefore);

    const usage = eventsOf("token_usage").filter((event) => event.sessionId === sessionId);
    // 一个回合**只留一行**：成本页的「计费回合」= token_usage 行数 − `mode:"degraded"` 行数，
    // 降级回合若另留一条 0 token 的正常行，就同时进了两个分子——免费那一轮会被算成付过钱。
    expect(usage.length, "降级回合只留那条降级记录").toBe(1);
    // 没有真 usage 就是 0：字数换算的估算进账本会被当成花掉的钱
    expect(usage.every((event) => Number(event.payload.input_tokens ?? 0) === 0 && Number(event.payload.output_tokens ?? 0) === 0), "本地回合不能记下没花过的 token").toBe(true);
    // 闸门确实留了痕：降级不是静默回落
    expect(usage[0].payload.mode, "触顶回合要有可查的降级记录").toBe("degraded");
    expect(usage[0].payload.cause).toBe("monthly_budget_reached");

    await app.inject({ method: "PUT", url: `/api/repositories/${repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
  });
});
