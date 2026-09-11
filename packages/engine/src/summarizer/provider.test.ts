import { describe, expect, it } from "vitest";
import { FailoverSummaryProvider, LocalSummaryProvider, type SummaryProvider } from "./provider.js";
import { AnthropicProvider, OllamaTeachingProvider, OpenAICompatibleProvider, RetryLlmProvider, teachingProviderStatus } from "../llm/provider.js";

describe("summary provider fallback", () => {
  it("falls back locally when the configured provider fails", async () => {
    const failing: SummaryProvider = { name: "failing", modelVersion: "failing-v1", summarize: async () => { throw new Error("offline"); } };
    const provider = new FailoverSummaryProvider(failing, new LocalSummaryProvider());
    await expect(provider.summarize({ path: "src/main.ts", content: "export function main() {}" })).resolves.toContain("main");
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
