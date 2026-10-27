import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoggingLlmProvider, flushLlmLog, formatLlmCallLine, llmLogPath, outboundFingerprint, type LlmCallRecord } from "./call-log.js";
import type { LlmCompletion, LlmProvider } from "../../../application/port/llm-provider.js";
import { RetryLlmProvider, ThinkingOverrideLlmProvider } from "./provider.js";
import { runWithTrace } from "@codebase-tutor/platform";

/**
  LLM 工作日志：既要有可机读的落盘（JSONL），也要有控制台单行摘要；
  失败必须照记并原样抛出——日志不允许把失败伪装成成功。
  */

function fakeProvider(handler: (input: unknown) => Promise<LlmCompletion>): LlmProvider {
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
  traceId: null,
  threadId: null,
  actor: null,
  outbound: { chars: 120, hash: "aaaaaaaaaaaa" },
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

  /**
    重试读数：日志包在重试层外面，一次逻辑调用只落一行，第几次成、每次多久只能由 RetryLlmProvider
    挂在结果/错误上带出来。
    */
  it("重试层带出来的 attempts 与 attemptMs 原样落行，并在控制台单行上屏", async () => {
    const provider = new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok", attempts: 2, attemptMs: [60_000, 1_500] })), "light");
    await provider.complete({ system: "s", user: "u", scene: "map.refine" });
    await flushLlmLog();
    const entry = JSON.parse(readFileSync(logFile, "utf8").trim()) as LlmCallRecord;
    expect(entry).toMatchObject({ ok: true, attempts: 2, attemptMs: [60_000, 1_500] });
    expect(entry.ms).toBeGreaterThanOrEqual(0);
    expect(logged.some((line) => line.includes("retry 2"))).toBe(true);
  });

  it("一次就的行不带 retry 字样（不制造噪音），但 attempts=1 仍如实落盘", async () => {
    const provider = new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok", attempts: 1, attemptMs: [800] })), "light");
    await provider.complete({ system: "s", user: "u", scene: "map.summary" });
    await flushLlmLog();
    expect((JSON.parse(readFileSync(logFile, "utf8").trim()) as LlmCallRecord).attempts).toBe(1);
    expect(logged.some((line) => line.includes("retry"))).toBe(false);
  });

  it("最终失败也带次数；老形状的内层错误（没挂这这两个字段）不硬造数字，缺就是缺", async () => {
    const retried = new LoggingLlmProvider(fakeProvider(async () => {
      const error = new Error("LLM 请求超时（60000ms）");
      Object.defineProperty(error, "attempts", { value: 2, configurable: true });
      Object.defineProperty(error, "attemptMs", { value: [60_000, 60_000], configurable: true });
      throw error;
    }), "teaching");
    await expect(retried.complete({ system: "s", user: "u", scene: "map.flow" })).rejects.toThrow("请求超时");
    const plain = new LoggingLlmProvider(fakeProvider(async () => { throw new Error("fetch failed"); }), "teaching");
    await expect(plain.complete({ system: "s", user: "u", scene: "map.flow" })).rejects.toThrow("fetch failed");
    await flushLlmLog();
    const [first, second] = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LlmCallRecord);
    expect(first).toMatchObject({ ok: false, attempts: 2, attemptMs: [60_000, 60_000] });
    expect(second.attempts, "「没记」不能伪装成 1——历史行与新行分得开才有意义").toBeUndefined();
  });

  it("按生产装配顺序（Logging 在 Retry 外面）走一遍：重试发生过，行里就读得出来", async () => {
    // 单独测 Retry 或单独测 Logging 都证不了这个字段能穿过装配边界，这里按生产顺序 Logging → Retry 组一次真的。
    let count = 0;
    const flaky: LlmProvider = {
      name: "flaky",
      modelVersion: "openai:flaky-model",
      complete: async () => {
        count += 1;
        if (count === 1) throw new Error("LLM 请求超时（60000ms）：推理模型生成较慢时可调大 TUTOR_LLM_TIMEOUT_MS。");
        return { text: "第二次成的", usage: { inputTokens: 900, outputTokens: 40, promptCacheHitTokens: 0 }, finishReason: "stop" };
      }
    };
    const provider = new LoggingLlmProvider(new RetryLlmProvider(flaky, 2), "light");
    const completion = await provider.complete({ system: "s", user: "u", scene: "map.refine" });
    await flushLlmLog();
    expect(completion.attempts).toBe(2);
    const entry = JSON.parse(readFileSync(logFile, "utf8").trim()) as LlmCallRecord;
    expect(entry).toMatchObject({ ok: true, scene: "map.refine", attempts: 2 });
    expect(entry.attemptMs).toHaveLength(2);
    // 总墙钟不等于任何单次：这一行同时给出「一共多久」与「每次多久」
    expect(entry.ms).toBeGreaterThanOrEqual(0);
    expect(logged.some((line) => line.includes("retry 2"))).toBe(true);
  });

  it("并发调用串行落盘：行数与条数一致且每行可解析", async () => {    const provider = new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok" })), "light");
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

  it("请求上下文里的调用记下 traceId；后台任务（无上下文）记为 null（不丢字段也不编造）", async () => {
    const provider = new LoggingLlmProvider(fakeProvider(async () => ({ text: "ok" })), "teaching");

    await runWithTrace("req-42", () => provider.complete({ system: "s", user: "u", scene: "teaching.turn" }));
    await provider.complete({ system: "s", user: "u", scene: "map.refine" });
    await flushLlmLog();

    const entries = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LlmCallRecord);
    expect(entries[0]).toMatchObject({ scene: "teaching.turn", traceId: "req-42", actor: null });
    expect(entries[1]).toMatchObject({ scene: "map.refine", traceId: null, actor: null });
    // 指纹落进行里：审计者要在本地重跑一次装配、比这一列才知道「出去的是不是这份」
    expect(entries[0].outbound).toMatchObject({ chars: expect.any(Number) });
    expect(entries[0].outbound.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("出网载荷指纹：正文差一个字就换哈希，工具结果与工具清单都算进去", () => {
    const base = { system: "提示词", user: "问题" };
    const first = outboundFingerprint(base);
    expect(outboundFingerprint(base)).toEqual(first); // 同一次装配重跑两次必须给同一个指纹，否则没法核对
    expect(outboundFingerprint({ ...base, user: "问题？" })).not.toEqual(first);

    // read_file 的内容是在下一轮出门的：它作为 tool 消息进 messages，指纹必须认得到
    const withTool = { system: "提示词", messages: [{ role: "user" as const, content: "问题" }, { role: "tool" as const, content: "文件 src/main.ts（第 1-20 行）：\nsecret" }] };
    expect(outboundFingerprint(withTool).chars).toBeGreaterThan(first.chars);
    expect(outboundFingerprint({ ...withTool, messages: withTool.messages.slice(0, 1) }).hash).not.toBe(outboundFingerprint(withTool).hash);

    // 工具清单也占输入：跨仓那档多一个 cross_repo_link，文本一字不变也得算成不同载荷
    const tool = { name: "read_file", description: "读文件", parameters: { path: { type: "string" } } };
    const withoutTools = outboundFingerprint({ ...base, tools: [] });
    const withTools = outboundFingerprint({ ...base, tools: [tool] });
    expect(withTools.hash).not.toBe(withoutTools.hash);
    // 工具描述确实进请求体（provider.ts:215 把 name+description+parameters 一起发），所以改描述就是改载荷
    expect(outboundFingerprint({ ...base, tools: [{ ...tool, description: "读文件（带行号）" }] }).hash).not.toBe(withTools.hash);
  });
});
