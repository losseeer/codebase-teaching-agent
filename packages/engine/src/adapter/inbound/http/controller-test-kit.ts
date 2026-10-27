import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ChatThreadMessage } from "@codebase-tutor/contract";
import type { ImportEstimate, JournalEvent, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

import { repositoryId as deriveRepositoryId } from "@codebase-tutor/platform";
import { flushLlmLog } from "../../../llm/call-log.js";
import { TutorDatabase } from "../../../persistence/database.js";
import { readJournal } from "../../../persistence/journal.js";
import { readMessages } from "../../../persistence/chat-store.js";

/**
  路由级测试的共用夹具。它管四件事：一份行号可预期的临时仓与地址簿、假 provider、
  journal/chat_message 的读回口径，以及「每一次 provider 调用都带得上线程」这条账面核对。
  产品数据一条都不碰：注册表、llm.log、llm-settings 全指到本夹具自己的临时目录，
  而且必须早于 import server（provider 在构造时就把 fetch 绑成了实例字段）。

  零 token：服务商指向 127.0.0.1:9（打不到的端口），一切正文由 `scripted` 给定。
  每个用例文件各拿一个实例——`process.env`、`sentTools`、`usedThreads` 都不跨文件串。
  */

export const MAIN_FILE = "src/main.ts";
/** 引用核得上时的默认正文：带问句、带真引用、带长标识符，三条不变量都能过。 */
export const OK_REPLY = `先看 ${MAIN_FILE}:3 的 registerOrder，你觉得哪一步会先执行？`;
/** 尾注里独有的词（文案全文住在 application/turn-invariants.ts，这里只判「有没有出现」） */
export const TAIL = "未能核实";

/** 轮询到条件成立；到点不成就带着「在等什么」失败。 */
export async function waitFor(predicate: () => boolean, why: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等不到「${why}」（${timeoutMs}ms 超时）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function sseEvents(payload: string): Record<string, unknown>[] {
  return payload.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

export function deltasOf(events: Record<string, unknown>[]): string {
  return events.filter((event) => event.type === "delta").map((event) => String(event.delta ?? "")).join("");
}

export function doneEvent(events: Record<string, unknown>[]): Record<string, unknown> {
  const done = events.find((event) => event.type === "done");
  expect(done, "SSE 流缺少 done 事件（回合没走完）").toBeDefined();
  expect(events.some((event) => event.type === "error" || event.type === "aborted")).toBe(false);
  return done as Record<string, unknown>;
}

/** llm.log 里属于「会话回合」的那三档：只有这些行必须带 threadId。 */
const TURN_SCENES = new Set(["map.chat", "practice.chat", "teaching.turn"]);

export interface RouteFixture {
  readonly root: string;
  readonly repoDir: string;
  /** 仓与地址簿建好之后才 import server；没挂上就用 = 用例当场红。 */
  app: FastifyInstance;
  repositoryId: string;
  exerciseId: string;
  /** 假 provider 的脚本：每次非决策调用 shift 一条。绝不回空正文——重试层会把空 content 当失败重发，脚本会整体串位。 */
  scripted: string[];
  /** 脚本用完之后反复回的那一条。 */
  spoken: string;
  /** 让假 provider 在途一会儿：「停止生成」的用例得赶在 LLM 返回之前打进 `/api/turns/stop`。 */
  holdMs: number;
  /** 在本回合第 N 趟请求返回之前替用户点停止。计数只认带 `marker`（这一回合的问题原文）的请求——全局调用序号会被别处多发的一发挪走。 */
  stopInside: { turnId: string; marker: string; atCall: number; seen: number } | undefined;
  /** 每次请求实际带上的工具清单（跨仓那档要验的是它随不随地址簿变长）。 */
  readonly sentTools: { names: string[]; raw: string }[];
  /** 本文件真正用过的线程 id（teach 的 sessionId 也算线程）：与 llm.log 里的 threadId 集合做全等比对。 */
  readonly usedThreads: Set<string>;
  readonly echoServerFixture: string;
  fetchCalls(): number;
  requestsOf(marker: string): number;
  mount(): Promise<void>;
  teardown(): Promise<void>;
  /** 每条用例开跑前把脚本与在途设置归零。 */
  reset(): void;
  eventsOf(type: string): JournalEvent[];
  lastEvent(type: string): JournalEvent;
  assistantMessage(threadId: string): ChatThreadMessage;
  newThread(scope: "map" | "practice", title: string, linkedExerciseId?: string): Promise<string>;
  /** 逐行核对 llm.log：调用数对得上、线程集合全等、失败只允许是中止。 */
  verifyLlmLog(options?: { expectAborted?: boolean; scenes?: string[] }): Promise<void>;
}

export function createRouteFixture(): RouteFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-routes-")));
  const repoDir = join(root, "repo");
  const fx = {
    root,
    repoDir,
    app: undefined as unknown as FastifyInstance,
    repositoryId: "",
    exerciseId: "",
    scripted: [] as string[],
    spoken: OK_REPLY,
    holdMs: 0,
    stopInside: undefined as RouteFixture["stopInside"],
    sentTools: [] as { names: string[]; raw: string }[],
    usedThreads: new Set<string>(),
    echoServerFixture: join(import.meta.dirname, "..", "..", "..", "integrations", "fixtures", "echo-server.mjs")
  } as RouteFixture;
  let fetchCalls = 0;

  function replyFor(): string {
    const next = fx.scripted.shift();
    if (next) fx.spoken = next;
    return fx.spoken;
  }

  async function fakeFetch(_url: unknown, init?: { body?: string; signal?: AbortSignal }): Promise<Response> {
    fetchCalls += 1;
    const raw = String(init?.body ?? "{}");
    // 先登记再在途：这一行代表「请求已经发出去了」，用例靠它判断自己该在什么时刻打停止
    try {
      const parsed = JSON.parse(raw) as { tools?: { function?: { name?: string } }[] };
      fx.sentTools.push({ names: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "").filter(Boolean), raw });
    } catch { /* 非 JSON 的请求体不进这份清单 */ }
    if (fx.holdMs) {
      // 真在途、真被 signal 打断：provider 会把它归因成 LlmAbortedError，于是测得到「异常携带」那半条补账路径
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, fx.holdMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        }, { once: true });
      });
    }
    if (fx.stopInside && raw.includes(fx.stopInside.marker) && ++fx.stopInside.seen === fx.stopInside.atCall) {
      const stopped = await fx.app.inject({ method: "POST", url: "/api/turns/stop", payload: { turnId: fx.stopInside.turnId } });
      expect(stopped.json()).toMatchObject({ stopped: true });
    }
    const text = replyFor();
    // `@@tool 工具名 {json}` 这种脚本前缀让假 provider 回一次工具调用：副作用工具实际被拒的是什么，从此能端到端验
    const call = /^@@tool (\S+) (.*)$/s.exec(text);
    const payload = {
      choices: [{ message: call ? { content: "", tool_calls: [{ id: `call_${fetchCalls}`, type: "function", function: { name: call[1], arguments: call[2] } }] } : { content: text }, finish_reason: call ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 40 }
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }

  fx.fetchCalls = () => fetchCalls;
  fx.requestsOf = (marker: string) => fx.sentTools.filter((entry) => entry.raw.includes(marker)).length;

  fx.mount = async () => {
    // 临时仓：一个文件、一行一条注释，行号可预期（src/main.ts:3 判「在范围内」）
    mkdirSync(join(repoDir, "src"), { recursive: true });
    fx.repositoryId = deriveRepositoryId(repoDir);
    const source = Array.from({ length: 20 }, (_unused, index) => `// line ${index + 1}`).join("\n");
    writeFileSync(join(repoDir, MAIN_FILE), `${source}\n`, "utf8");

    const now = new Date().toISOString();
    const index: RepositoryIndex = {
      repositoryId: fx.repositoryId, repositoryPath: repoDir, scannedAt: now, totalFiles: 1, totalLines: 20,
      files: [{ path: MAIN_FILE, extension: ".ts", bytes: source.length, lines: 20 }],
      fileTree: [], hotspots: []
    };
    const analysis: RepositoryAnalysis = {
      repositoryId: fx.repositoryId, generatedAt: now, versionStamp: "content:fixture",
      graph: {
        imports: { [MAIN_FILE]: [] }, calls: [],
        symbols: [{ id: "sym-1", name: "registerOrder", kind: "function", path: MAIN_FILE, line: 3, endLine: 6, parameters: ["builder"], language: "typescript" }],
        entrypoints: [{ path: MAIN_FILE, line: 3, label: "registerOrder" }],
        semanticBackend: "static", lspStatus: []
      },
      implementations: []
    };
    const estimate: ImportEstimate = { cachedFiles: 0, summarizedFiles: 1, estimatedInputTokens: 0, estimatedCostUsd: 0, provider: "none", modelVersion: "fixture-v1" };
    const database = new TutorDatabase(repoDir);
    database.state.saveIndex(index);
    database.state.saveEstimate(fx.repositoryId, estimate);
    database.state.saveAnalysis(analysis);
    // 练习答疑要求题目在缓存里（题面由 fixture 给定，不走出题路径）
    fx.exerciseId = "ex-fixture";
    database.exercises.put(fx.repositoryId, "content:fixture", "impact_analysis", "unit-1", {
      exercise: {
        id: fx.exerciseId, repositoryId: fx.repositoryId, contentVersion: "content:fixture", kind: "impact_analysis",
        targetUnitId: "unit-1", targetTitle: "注册顺序", difficulty: 1, title: "影响分析", prompt: "改这一行会先影响谁？",
        anchors: [{ path: MAIN_FILE, line: 3, label: "入口" }], inputMode: "multi_select", gradingMode: "set_match", createdAt: now
      }
    });
    database.close();

    // 引擎的产品数据落点全部改指临时目录（各自的 env 注释见对应模块）
    process.env.TUTOR_REGISTRY_FILE = join(root, "registry.json");
    writeFileSync(process.env.TUTOR_REGISTRY_FILE, `${JSON.stringify({ repositories: [repoDir] }, null, 2)}\n`, "utf8");
    process.env.TUTOR_LLM_SETTINGS_FILE = join(root, "llm-settings.json");
    writeFileSync(process.env.TUTOR_LLM_SETTINGS_FILE, `${JSON.stringify({ provider: "openai-compatible", model: "fixture-model", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-key", thinking: "auto" }, null, 2)}\n`, "utf8");
    process.env.TUTOR_LLM_LOG = join(root, "llm.log");
    process.env.TUTOR_ENGINE_LOG = "off";

    // 必须早于 import server（理由见本文件开头的夹具说明）
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    ({ app: fx.app } = await import("../../../server.js"));
  };

  fx.teardown = async () => {
    await fx.app?.close();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
    for (const key of ["TUTOR_REGISTRY_FILE", "TUTOR_LLM_SETTINGS_FILE", "TUTOR_LLM_LOG", "TUTOR_ENGINE_LOG"]) delete process.env[key];
  };

  fx.reset = () => {
    fx.scripted = [];
    fx.spoken = OK_REPLY;
    fx.holdMs = 0;
    fx.stopInside = undefined;
  };

  fx.eventsOf = (type: string) => readJournal(repoDir).filter((event) => event.type === type);
  fx.lastEvent = (type: string) => {
    const list = fx.eventsOf(type);
    expect(list.length, `journal 里没有 ${type} 事件`).toBeGreaterThan(0);
    return list[list.length - 1];
  };
  fx.assistantMessage = (threadId: string) => {
    const messages = readMessages(repoDir, threadId).filter((message) => message.role === "assistant");
    expect(messages.length, "chat_message 里没有助手正文").toBeGreaterThan(0);
    return messages[messages.length - 1];
  };
  fx.newThread = async (scope: "map" | "practice", title: string, linkedExerciseId?: string) => {
    const response = await fx.app.inject({
      method: "POST",
      url: `/api/repositories/${fx.repositoryId}/threads`,
      payload: { scope, title, ...(linkedExerciseId ? { exerciseId: linkedExerciseId } : {}) }
    });
    const threadId = (response.json() as { thread: { id: string } }).thread.id;
    fx.usedThreads.add(threadId);
    return threadId;
  };

  fx.verifyLlmLog = async (options = {}) => {
    await flushLlmLog();
    const lines = readFileSync(join(root, "llm.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBe(fetchCalls);
    // 问答回合每个回合只发一趟措辞调用，没有别的教学档
    expect(new Set(lines.map((line) => line.scene))).not.toContain("teaching.action");
    for (const scene of options.scenes ?? []) expect(lines.map((line) => line.scene), `llm.log 里少了 ${scene} 这一档`).toContain(scene);
    // 中止的用例会把请求真打断（provider 收 AbortError），那是唯一允许的 fail 行；其余任何失败都是回归
    const failed = lines.filter((line) => line.ok !== true);
    if (options.expectAborted) expect(failed.length, "中止用例应该各留下一行 fail（一行都没有就是那条用例空转了）").toBeGreaterThan(0);
    expect(failed.every((line) => String(line.error).includes("已被中止")), `llm.log 里出现了非中止的失败：${JSON.stringify(failed.map((line) => line.error))}`).toBe(true);
    // 回合那一档的线程集合 == 本文件真正问过的线程集合；
    // 只筛这三档，是因为分析类调用（摘要等）本来就不属于任何会话线程
    const turnLines = lines.filter((line) => TURN_SCENES.has(String(line.scene)));
    expect(new Set(turnLines.map((line) => line.threadId))).toEqual(fx.usedThreads);
    expect(turnLines.every((line) => typeof line.threadId === "string" && line.threadId.length > 0), "有回合调用没带 threadId：前缀缓存按线程算间隔就读不到").toBe(true);
  };

  return fx;
}
