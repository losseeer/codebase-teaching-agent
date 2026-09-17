import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineLogPath, flushEngineLog, formatEngineTraceLine, traceEngine } from "./engine-log.js";
import { runWithTrace } from "./context.js";
import type { EngineTraceEvent } from "@codebase-tutor/shared";

/**
  引擎工作日志：可机读落盘（JSONL）+ 控制台摘要；http / boot 只落盘不回显（pino 与 [boot] 行已覆盖）。
  与 llm.log 的分工是「同一事实只写一处」，靠 traceId 关联。
  */

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
    await flushEngineLog();
    expect(readLines()).toEqual([{
      at: expect.any(String),
      kind: "degrade",
      traceId: "req-1",
      detail: { scope: "teaching", cause: "monthly_budget_reached" }
    }]);
  });

  it("后台任务（无请求上下文）记 traceId: null，且显式传 null 与缺省同义", async () => {
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

  it("durationMs 缺省时不写该字段（不假装成 0）", async () => {
    traceEngine("degrade", { scope: "flow" });
    await flushEngineLog();
    expect(readLines()[0]).not.toHaveProperty("durationMs");
  });
});
