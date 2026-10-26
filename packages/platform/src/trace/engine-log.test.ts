import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineLogPath, flushEngineLog, formatEngineTraceLine, traceEngine } from "./engine-log.js";
import { currentTraceId, runWithTrace } from "./context.js";
import type { EngineTraceEvent } from "@codebase-tutor/domain";

/**
  落盘要逐行可机读、回显只给非 http/boot 的种类；LLM 调用明细不在这一条线（同一事实只写一处，靠 traceId 关联 llm.log）。
  */

describe("traceId 上下文的传播", () => {
  it("排队回调继承「挂上去那一刻」的上下文；出了上下文回 null", async () => {
    const seen = await runWithTrace("req-A", async () => {
      await Promise.resolve();
      return Promise.resolve().then(() => currentTraceId());
    });
    // 这一条钉住 `importer.submit` 的排队语义：导入是这么排队的，所以它几分钟内的 journal / llm.log 行
    // 都带着来源请求的 reqId——那是「这一次导入花了哪些钱」唯一的关联键，断开就没法回查。
    expect(seen).toBe("req-A");
    expect(currentTraceId(), "监听器叫醒的重分析没有请求上下文，读数是 null").toBeNull();
  });
});

describe("引擎工作日志", () => {
  let directory: string;
  let logFile: string;
  let logged: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tutor-engine-log-"));
    logFile = join(directory, "nested", "engine.jsonl");
    process.env.TUTOR_ENGINE_LOG = logFile;
    logged = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => { logged.push(String(message)); });
    vi.spyOn(console, "warn").mockImplementation((message?: unknown) => { logged.push(`WARN ${String(message)}`); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TUTOR_ENGINE_LOG;
    rmSync(directory, { recursive: true, force: true });
  });

  const readLines = (): EngineTraceEvent[] =>
    readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as EngineTraceEvent);

  it("控制台摘要行含种类 / 耗时 / traceId / 字段（跳过 null 与空串）", () => {
    const line = formatEngineTraceLine({
      at: "2026-09-17T02:00:00.000Z",
      kind: "import",
      traceId: "req-7",
      durationMs: 1830,
      detail: { job: "job-1", phase: "completed", files: 42, error: null, note: "" }
    });
    expect(line).toBe("[engine] import · 1830ms · trace req-7 · job=job-1 phase=completed files=42");
  });

  it("无 traceId 时不打印 trace 段（后台任务不自造 id）", () => {
    const line = formatEngineTraceLine({ at: "2026-09-17T02:00:00.000Z", kind: "reindex", traceId: null, detail: { ok: true } });
    expect(line).toBe("[engine] reindex · ok=true");
  });

  it("请求上下文里的记录带上 traceId 并落盘", async () => {
    runWithTrace("req-1", () => traceEngine("degrade", { scope: "teaching", cause: "monthly_budget_reached" }));
    runWithTrace("req-2", () => traceEngine("degrade", { scope: "teaching", cause: "monthly_budget_reached" }));
    await flushEngineLog();
    // 认证闸撤了之后两条都必须把 actor 这列写成 null（列在，值没有——别让它整个消失）
    expect(readLines()).toEqual([{
      at: expect.any(String),
      kind: "degrade",
      traceId: "req-1",
      actor: null,
      detail: { scope: "teaching", cause: "monthly_budget_reached" }
    }, {
      at: expect.any(String),
      kind: "degrade",
      traceId: "req-2",
      actor: null,
      detail: { scope: "teaching", cause: "monthly_budget_reached" }
    }]);
  });

  it("后台任务（无请求上下文）记 traceId: null，且显式传 null 与默认同义", async () => {
    traceEngine("reindex", { ok: true });
    traceEngine("import", { phase: "completed" }, { traceId: null });
    await flushEngineLog();
    expect(readLines().map((entry) => entry.traceId)).toEqual([null, null]);
  });

  it("http 与 boot 只落盘、不回显控制台（避免每条请求都刷屏）", async () => {
    traceEngine("http", { method: "GET", url: "/api/health", status: 200 }, { traceId: "req-9" });
    traceEngine("boot", { phase: "listening" }, { traceId: null });
    traceEngine("degrade", { scope: "flow" });
    await flushEngineLog();
    expect(logged.filter((line) => line.includes("[engine] http"))).toHaveLength(0);
    expect(logged.filter((line) => line.includes("[engine] boot"))).toHaveLength(0);
    expect(logged.some((line) => line.includes("[engine] degrade"))).toBe(true);
    expect(readLines()).toHaveLength(3);
  });

  it("并发写入串行落盘：行数与条数一致且每行可解析", async () => {
    for (let index = 0; index < 12; index += 1) traceEngine("http", { url: `/api/${index}`, status: 200 }, { traceId: `req-${index}` });
    await flushEngineLog();
    const lines = readLines();
    expect(lines).toHaveLength(12);
    expect(lines[11]?.traceId).toBe("req-11");
  });

  it("TUTOR_ENGINE_LOG=off 时只打控制台，不落盘", () => {
    process.env.TUTOR_ENGINE_LOG = "off";
    expect(engineLogPath()).toBeNull();
    traceEngine("degrade", { scope: "flow" });
    expect(logged.some((line) => line.startsWith("[engine] degrade"))).toBe(true);
  });

  it("durationMs 默认时不写该字段（不假装成 0）", async () => {
    traceEngine("degrade", { scope: "flow" });
    await flushEngineLog();
    expect(readLines()[0]).not.toHaveProperty("durationMs");
  });
});
