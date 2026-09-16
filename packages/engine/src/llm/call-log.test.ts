import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoggingLlmProvider, flushLlmLog, formatLlmCallLine, llmLogPath, type LlmCallRecord } from "./call-log.js";
import type { LlmProvider } from "./provider.js";
import { ThinkingOverrideLlmProvider } from "./provider.js";

/**
  LLM 工作日志：既要有可机读的落盘（JSONL），也要有控制台单行摘要；
  失败必须照记并原样抛出——日志不允许把失败伪装成成功。
  */

function fakeProvider(handler: (input: unknown) => Promise<{ text: string }>): LlmProvider {
  return { name: "test provider", modelVersion: "openai:test-model", complete: handler as LlmProvider["complete"] };
}

const record = (overrides: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  at: "2026-09-16T01:00:00.000Z",
  tier: "teaching",
  scene: "teaching.turn",
  provider: "p",
  model: "openai:m",
  ok: true,
  ms: 1200,
  thinking: "auto",
  ...overrides
});

describe("LLM 工作日志", () => {
  let directory: string;
  let logFile: string;
  let logged: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tutor-llm-log-"));
    logFile = join(directory, "nested", "llm.log");
    process.env.TUTOR_LLM_LOG = logFile;
    logged = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => { logged.push(String(message)); });
    vi.spyOn(console, "warn").mockImplementation((message?: unknown) => { logged.push(`WARN ${String(message)}`); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TUTOR_LLM_LOG;
    rmSync(directory, { recursive: true, force: true });
  });

  it("控制台摘要行含层级 / 场景 / 模型 / 结果 / token / 缓存命中 / 工具", () => {
    const line = formatLlmCallLine(record({ inputTokens: 8123, outputTokens: 421, cacheHitTokens: 7000, tools: ["read_file"] }));
    expect(line).toBe("[llm] teaching · teaching.turn · openai:m · ok · 1200ms · in 8123(cache 7000) out 421 · think auto · tools read_file");
  });

  it("失败记录把原因写在摘要行里（不吞错）", () => {
    expect(formatLlmCallLine(record({ ok: false, error: "LLM 请求超时（12000ms）" }))).toContain("fail");
    expect(formatLlmCallLine(record({ ok: false, error: "LLM 请求超时（12000ms）" }))).toContain("LLM 请求超时（12000ms）");
  });

  it("端点未上报 token 时摘要显示 tokens n/a（不假装是 0）", () => {
    expect(formatLlmCallLine(record())).toContain("tokens n/a");
  });

  it("包装器透传结果，并按调用点声明的 scene 落盘一条 JSONL（含 usage 与工具名）", async () => {
    const provider = new LoggingLlmProvider({
      name: "openai-compatible",
      modelVersion: "openai:deepseek-flash",
      complete: async () => ({
        text: "答案",
        usage: { inputTokens: 900, outputTokens: 40, promptCacheHitTokens: 800 },
        finishReason: "stop"
      })
    }, "light");

    const completion = await provider.complete({ system: "s", user: "u", scene: "practice.judge", thinking: "high", tools: [{ name: "read_file", description: "d", parameters: {} }] });
    expect(completion.text).toBe("答案");
    await flushLlmLog();

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as LlmCallRecord;
    expect(entry).toMatchObject({
      tier: "light",
      scene: "practice.judge",
      provider: "openai-compatible",
      model: "openai:deepseek-flash",
      ok: true,
      thinking: "high",
      tools: ["read_file"],
      inputTokens: 900,
      outputTokens: 40,
      cacheHitTokens: 800,
      finishReason: "stop"
    });
    expect(typeof entry.ms).toBe("number");
  });

  it("未声明 scene 的调用记为 unspecified（不静默丢字段）", async () => {
    const provider = new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok" })), "teaching");
    await provider.complete({ system: "s", user: "u" });
    await flushLlmLog();
    const entry = JSON.parse(readFileSync(logFile, "utf8").trim()) as LlmCallRecord;
    expect(entry.scene).toBe("unspecified");
    expect(entry.thinking).toBe("auto");
    expect(entry.tools).toBeUndefined();
  });

  it("失败调用照记 ok=false + 原因，并把原错误抛给调用方", async () => {
    const provider = new LoggingLlmProvider(fakeProvider(async () => { throw new Error("LLM returned 500"); }), "teaching");
    await expect(provider.complete({ system: "s", user: "u", scene: "teaching.turn" })).rejects.toThrow("LLM returned 500");
    await flushLlmLog();
    const entry = JSON.parse(readFileSync(logFile, "utf8").trim()) as LlmCallRecord;
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe("LLM returned 500");
    expect(logged.some((line) => line.includes("fail") && line.includes("LLM returned 500"))).toBe(true);
  });

  it("并发调用串行落盘：行数与条数一致且每行可解析", async () => {
    const provider = new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok" })), "light");
    await Promise.all(Array.from({ length: 12 }, (_, index) => provider.complete({ system: "s", user: `u${index}`, scene: "map.refine" })));
    await flushLlmLog();
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(12);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ scene: "map.refine", ok: true });
  });

  it("TUTOR_LLM_LOG=off 时只打控制台，不落盘", async () => {
    process.env.TUTOR_LLM_LOG = "off";
    expect(llmLogPath()).toBeNull();
    const provider = new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok" })), "light");
    await provider.complete({ system: "s", user: "u" });
    await flushLlmLog();
    expect(logged.some((line) => line.startsWith("[llm] light"))).toBe(true);
  });

  it("档位注入在日志外层时，记到的是实际下发的档位（不是调用方没写时的 auto）", async () => {
    // runtime 的组装顺序：ThinkingOverride(Logging(raw))——反过来会把 "off" 记成 "auto"
    const provider = new ThinkingOverrideLlmProvider(new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok" })), "light"), "off");
    await provider.complete({ system: "s", user: "u" });
    await flushLlmLog();
    expect((JSON.parse(readFileSync(logFile, "utf8").trim()) as LlmCallRecord).thinking).toBe("off");
  });
});
