import { describe, expect, it } from "vitest";
import { LlmSummaryProvider, LocalSummaryProvider, parseBatchReply, SUMMARY_BATCH_SIZE, type SummaryProvider } from "./provider.js";
import type { FileSlice } from "./slice.js";
import type { LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { AnthropicProvider, OllamaTeachingProvider, OpenAICompatibleProvider, RetryLlmProvider, teachingProviderStatus } from "../llm/provider.js";

/** L1 的输入是结构切片（不再是整份正文），桩数据按切片形状给。 */
function sliceOf(path = "src/main.ts"): FileSlice {
  return {
    path,
    lines: 12,
    role: "core",
    entries: [
      { name: "main", kind: "function", line: 1, signature: "main()" },
      { name: "helper", kind: "function", line: 5, signature: "helper(x)" }
    ],
    omittedSymbols: 0,
    dependsOn: ["src/util.ts"],
    dependedOnBy: []
  };
}

function llmOf(reply: string | (() => Promise<never>), onCall?: (input: LlmCompletionInput) => void): LlmProvider {
  return {
    name: "stub",
    modelVersion: "stub-1",
    complete: async (input) => {
      onCall?.(input);
      if (typeof reply !== "string") return reply();
      return { text: reply, usage: { inputTokens: 100, outputTokens: 50 } };
    }
  };
}

describe("摘要档", () => {
  it("批量回复解析：按路径建索引、滤掉不合格的项，没回应的项自然留空", () => {
    const reply = JSON.stringify([
      { path: "a.ts", summary: "负责入口编排。", role: "core" },
      { path: "b.ts", summary: "配置加载。", role: "不存在的角色" },
      { summary: "缺路径会被丢掉" },
      { path: "c.ts", summary: "" }
    ]);
    const parsed = parseBatchReply(reply);
    expect(parsed.get("a.ts")).toEqual({ summary: "负责入口编排。", role: "core" });
    expect(parsed.get("b.ts")).toEqual({ summary: "配置加载。" });
    expect(parsed.has("c.ts")).toBe(false);
    expect(parsed.size).toBe(2);
    expect(parseBatchReply("模型没按格式给东西。").size).toBe(0);
  });

  it("轻量档：一次调用处理整批切片，按下标对齐，被模型漏掉的那条留成空位", async () => {
    let calls = 0;
    let sawSystem = "";
    const slices = ["a.ts", "b.ts", "c.ts"].map((path) => sliceOf(path));
    const provider = new LlmSummaryProvider(llmOf(
      JSON.stringify([{ path: "a.ts", summary: "甲", role: "core" }, { path: "c.ts", summary: "丙" }]),
      (input) => {
        calls += 1;
        sawSystem = input.system;
      }
    ));
    const results = await provider.summarizeMany(slices);
    expect(calls).toBe(1);
    expect(results).toEqual([{ summary: "甲", role: "core" }, undefined, { summary: "丙" }]);
    expect(sawSystem).toContain("严格输出 JSON 数组");
    expect(provider.modelVersion).toBe("stub-1");
  });

  it("确定性兜底档：逐条都给结果，摘要是路径 + 结构角色 + 主要符号，且不覆盖结构角色", async () => {
    const results = await new LocalSummaryProvider().summarizeMany([sliceOf(), sliceOf("src/empty.ts")]);
    expect(results).toHaveLength(2);
    expect(results[0].summary).toBe("src/main.ts：执行主干；定义 main、helper");
    expect(results[0].role).toBeUndefined();
  });

  it("批量里整批失败时不在接口层吞异常（由调用方按条回落）", async () => {
    const provider: SummaryProvider = { name: "boom", modelVersion: "boom-1", summarizeMany: async () => { throw new Error("offline"); } };
    await expect(provider.summarizeMany([sliceOf()])).rejects.toThrow("offline");
  });

  it("批次大小是常量：改它要连着看导入耗时与单次失败的牵连面", () => {
    expect(SUMMARY_BATCH_SIZE).toBeGreaterThan(1);
  });
});

describe("teaching LLM providers", () => {
  it("parses OpenAI-compatible chat responses and usage", async () => {
    const provider = new OpenAICompatibleProvider({
      endpoint: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async (url, init) => {
        expect(url).toBe("https://example.test/v1/chat/completions");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
        return new Response(JSON.stringify({ choices: [{ message: { content: "回答" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8 } }), { status: 200 });
      }
    });
    await expect(provider.complete({ system: "system", user: "user" })).resolves.toMatchObject({ text: "回答", usage: { inputTokens: 12, outputTokens: 8 } });
  });

  it("supports Anthropic and Ollama response shapes", async () => {
    const anthropic = new AnthropicProvider({ endpoint: "https://example.test", apiKey: "key", model: "claude-test", fetchImpl: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "安" }], usage: { input_tokens: 3, output_tokens: 4 } }), { status: 200 }) });
    await expect(anthropic.complete({ system: "s", user: "u" })).resolves.toMatchObject({ text: "安", usage: { inputTokens: 3, outputTokens: 4 } });
    const ollama = new OllamaTeachingProvider({ endpoint: "http://ollama", model: "qwen", fetchImpl: async () => new Response(JSON.stringify({ message: { content: "答" }, prompt_eval_count: 5, eval_count: 6 }), { status: 200 }) });
    await expect(ollama.complete({ system: "s", user: "u" })).resolves.toMatchObject({ text: "答", usage: { inputTokens: 5, outputTokens: 6 } });
  });

  it("retries one failed teaching request before succeeding", async () => {
    let calls = 0;
    const provider = new RetryLlmProvider({ name: "flaky", modelVersion: "flaky-v1", complete: async () => { calls += 1; if (calls === 1) throw new Error("temporary"); return { text: "ok" }; } });
    await expect(provider.complete({ system: "s", user: "u" })).resolves.toMatchObject({ text: "ok" });
    expect(calls).toBe(2);
  });

  it("reports local and remote teaching runtime status", () => {
    expect(teachingProviderStatus()).toMatchObject({ mode: "local", model: "local-heuristic-v1" });
    expect(teachingProviderStatus({ name: "fake", modelVersion: "fake-v1", complete: async () => ({ text: "ok" }) })).toMatchObject({ mode: "remote", provider: "fake", model: "fake-v1" });
  });
});
