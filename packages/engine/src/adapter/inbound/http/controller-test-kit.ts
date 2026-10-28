import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ChatThreadMessage } from "@codebase-tutor/contract";
import type { ImportEstimate, JournalEvent, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

import { repositoryId as deriveRepositoryId } from "@codebase-tutor/platform";
import { flushLlmLog } from "../../outbound/llm/call-log.js";
import { TutorDatabase } from "../../outbound/persistence/database.js";
import { readJournal } from "../../outbound/persistence/journal.js";
import { readMessages } from "../../outbound/persistence/chat-store.js";

/**
  路由级测试的共用夹具：临时仓与地址簿、假 provider、journal/chat_message 读回、llm.log 核对。
  夹具不调用真实模型，正文由 `scripted` 给定；每个用例文件各一个实例。
*/

export const MAIN_FILE = "src/main.ts";
/** 默认助手正文：含问句与仓内真引用。 */
export const OK_REPLY = `先看 ${MAIN_FILE}:3 的 registerOrder，你觉得哪一步会先执行？`;
/** 回复尾注里的标记词。 */
export const TAIL = "未能核实";

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

/** llm.log 中属于会话回合的 scene 值。 */
const TURN_SCENES = new Set(["map.chat", "practice.chat", "teaching.turn"]);

export interface RouteFixture {
  readonly root: string;
  readonly repoDir: string;
  /** 临时仓与地址簿就绪后才赋值。 */
  app: FastifyInstance;
  repositoryId: string;
  exerciseId: string;
  /** 假 provider 的脚本，每次调用取一条。 */
  scripted: string[];
  /** 脚本用完之后反复回的那一条。 */
  spoken: string;
  /** 假 provider 的在途时长（毫秒）。 */
  holdMs: number;
  /** 在第 N 次带 `marker` 的请求返回前触发用户停止。 */
  stopInside: { turnId: string; marker: string; atCall: number; seen: number } | undefined;
  /** 每次请求实际带上的工具清单。 */
  readonly sentTools: { names: string[]; raw: string }[];
  /** 本用例文件用过的线程 id。 */
  readonly usedThreads: Set<string>;
  readonly echoServerFixture: string;
  fetchCalls(): number;
  requestsOf(marker: string): number;
  mount(): Promise<void>;
  teardown(): Promise<void>;
  /** 用例开跑前把脚本与在途设置归零。 */
  reset(): void;
  eventsOf(type: string): JournalEvent[];
  lastEvent(type: string): JournalEvent;
  assistantMessage(threadId: string): ChatThreadMessage;
  newThread(scope: "map" | "practice", title: string, linkedExerciseId?: string): Promise<string>;
  /** 逐行核对 llm.log 的调用数、线程集合与失败原因。 */
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
    echoServerFixture: join(import.meta.dirname, "..", "..", "outbound", "integrations", "fixtures", "echo-server.mjs")
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
    try {
      const parsed = JSON.parse(raw) as { tools?: { function?: { name?: string } }[] };
      fx.sentTools.push({ names: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "").filter(Boolean), raw });
    } catch { /* 非 JSON 的请求体不入这份清单 */ }
    if (fx.holdMs) {
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
    // 脚本前缀 `@@tool 工具名 {json}` 表示一次工具调用
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
    // 临时仓：单文件、每行一条注释，行号可预期
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
    // 练习缓存里放一条题目
    fx.exerciseId = "ex-fixture";
    database.exercises.put(fx.repositoryId, "content:fixture", "impact_analysis", "unit-1", {
      exercise: {
        id: fx.exerciseId, repositoryId: fx.repositoryId, contentVersion: "content:fixture", kind: "impact_analysis",
        targetUnitId: "unit-1", targetTitle: "注册顺序", difficulty: 1, title: "影响分析", prompt: "改这一行会先影响谁？",
        anchors: [{ path: MAIN_FILE, line: 3, label: "入口" }], inputMode: "multi_select", gradingMode: "set_match", createdAt: now
      }
    });
    database.close();

    process.env.TUTOR_REGISTRY_FILE = join(root, "registry.json");
    writeFileSync(process.env.TUTOR_REGISTRY_FILE, `${JSON.stringify({ repositories: [repoDir] }, null, 2)}\n`, "utf8");
    process.env.TUTOR_LLM_SETTINGS_FILE = join(root, "llm-settings.json");
    writeFileSync(process.env.TUTOR_LLM_SETTINGS_FILE, `${JSON.stringify({ provider: "openai-compatible", model: "fixture-model", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-key", thinking: "auto" }, null, 2)}\n`, "utf8");
    process.env.TUTOR_LLM_LOG = join(root, "llm.log");
    process.env.TUTOR_ENGINE_LOG = "off";

    // 必须早于 import server
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
    expect(new Set(lines.map((line) => line.scene))).not.toContain("teaching.action");
    for (const scene of options.scenes ?? []) expect(lines.map((line) => line.scene), `llm.log 里少了 ${scene} 这一档`).toContain(scene);
    const failed = lines.filter((line) => line.ok !== true);
    if (options.expectAborted) expect(failed.length, "中止用例应该各留下一行 fail（一行都没有就是那条用例空转了）").toBeGreaterThan(0);
    expect(failed.every((line) => String(line.error).includes("已被中止")), `llm.log 里出现了非中止的失败：${JSON.stringify(failed.map((line) => line.error))}`).toBe(true);
    // 分析类调用不属于会话线程
    const turnLines = lines.filter((line) => TURN_SCENES.has(String(line.scene)));
    expect(new Set(turnLines.map((line) => line.threadId))).toEqual(fx.usedThreads);
    expect(turnLines.every((line) => typeof line.threadId === "string" && line.threadId.length > 0), "有回合调用没带 threadId：前缀缓存按线程算间隔就读不到").toBe(true);
  };

  return fx;
}
