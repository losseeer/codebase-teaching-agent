import { afterEach, describe, expect, it, vi } from "vitest";
import { createLightLlmProvider, createTeachingProvider, OpenAICompatibleProvider, RetryLlmProvider, ThinkingOverrideLlmProvider, type LlmProvider } from "./provider.js";

/** 构造一个 OpenAI chat.completions 形状的响应。 */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function chatBody(content: unknown, finishReason: string): unknown {
  return { choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

const OPTIONS = { endpoint: "https://llm.example.com/v1", apiKey: "test-key", model: "test-model", timeoutMs: 5_000 };

afterEach(() => {
  delete process.env.TUTOR_LLM_REASONING_HEADROOM;
});

describe("OpenAICompatibleProvider", () => {
  it("max_tokens 加上推理余量（默认 3000）", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await provider.complete({ system: "s", user: "u", maxTokens: 12 });
    expect(captured?.max_tokens).toBe(12 + 3_000);
  });

  it("TUTOR_LLM_REASONING_HEADROOM=0 关闭余量", async () => {
    process.env.TUTOR_LLM_REASONING_HEADROOM = "0";
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await provider.complete({ system: "s", user: "u", maxTokens: 700 });
    expect(captured?.max_tokens).toBe(700);
  });

  it("finish=length 且 content 为空时抛显式错误（推理预算耗尽）", async () => {
    const fetchImpl = (async () => jsonResponse(chatBody("", "length"))) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await expect(provider.complete({ system: "s", user: "u", maxTokens: 300 }))
      .rejects.toThrow(/max_tokens=3300.*推理模型/);
  });

  it("非 length 的空 content 保持通用错误", async () => {
    const fetchImpl = (async () => jsonResponse(chatBody("  ", "stop"))) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow("LLM returned an empty completion");
  });

  it("请求中止时抛显式超时错误", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      // 模拟 fetch 对 abort signal 的行为
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl, timeoutMs: 20 });
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(/LLM 请求超时（20ms）/);
  });

  it("finish=length 但 content 非空时正常返回", async () => {
    const fetchImpl = (async () => jsonResponse(chatBody("部分内容", "length"))) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    const completion = await provider.complete({ system: "s", user: "u" });
    expect(completion.text).toBe("部分内容");
    expect(completion.finishReason).toBe("length");
  });

  it("tools 进入请求体；tool_calls 被解析且空 content 不报错", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        choices: [{ message: { content: "", tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"src/app.ts\"}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 8 }
      });
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    const completion = await provider.complete({
      system: "s", user: "u", maxTokens: 700,
      tools: [{ name: "read_file", description: "读文件", parameters: { type: "object", properties: {} } }]
    });
    const tools = captured?.tools as { type: string; function: { name: string } }[];
    expect(tools?.[0]?.function?.name).toBe("read_file");
    expect(captured?.tool_choice).toBe("auto");
    expect(completion.toolCalls).toEqual([{ id: "call_1", name: "read_file", argumentsJson: "{\"path\":\"src/app.ts\"}" }]);
    expect(completion.finishReason).toBe("tool_calls");
  });

  it("工具循环历史映射：assistant toolCalls + reasoning_content 回传 + tool 结果", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(chatBody("最终回答", "stop"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    const completion = await provider.complete({
      system: "s",
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: "", reasoningContent: "思考链", toolCalls: [{ id: "call_9", name: "read_file", argumentsJson: "{}" }] },
        { role: "tool", toolCallId: "call_9", content: "文件内容" }
      ],
      tools: [{ name: "read_file", description: "d", parameters: {} }]
    });
    const messages = captured?.messages as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ role: "system", content: "s" });
    expect(messages[1]).toMatchObject({ role: "user", content: "问题" });
    expect(messages[2]).toMatchObject({ role: "assistant", reasoning_content: "思考链" });
    expect((messages[2].tool_calls as { id: string }[])[0]?.id).toBe("call_9");
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_9", content: "文件内容" });
    expect(completion.text).toBe("最终回答");
  });

  it("响应无 reasoning_content 时回传字段不出现（对真实 OpenAI 无多余字段）", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await provider.complete({
      system: "s",
      messages: [{ role: "assistant", content: "上轮", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: "{}" }] }, { role: "tool", toolCallId: "c1", content: "r" }]
    });
    expect(JSON.stringify(captured)).not.toContain("reasoning_content");
  });
});

describe("createLightLlmProvider", () => {
  const LIGHT_ENV_KEYS = ["TUTOR_LIGHT_PROVIDER", "TUTOR_LIGHT_MODEL", "TUTOR_LIGHT_OPENAI_URL", "TUTOR_LIGHT_API_KEY", "TUTOR_OPENAI_URL", "OPENAI_API_KEY"];

  afterEach(() => {
    for (const key of LIGHT_ENV_KEYS) delete process.env[key];
    vi.unstubAllGlobals();
  });

  function captureStub(captured: { url: string; auth: string; model: string }): void {
    vi.stubGlobal("fetch", (async (url: unknown, init?: RequestInit) => {
      captured.url = String(url);
      captured.auth = String(new Headers(init?.headers).get("authorization") ?? "");
      captured.model = (JSON.parse(String(init?.body)) as { model: string }).model;
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch);
  }

  it("独立端点/密钥优先于主力档共用变量（两档不同厂商场景）", async () => {
    process.env.TUTOR_LIGHT_PROVIDER = "openai-compatible";
    process.env.TUTOR_LIGHT_MODEL = "glm-4.7";
    process.env.TUTOR_LIGHT_OPENAI_URL = "https://light.example.com/v1";
    process.env.TUTOR_LIGHT_API_KEY = "light-key";
    process.env.TUTOR_OPENAI_URL = "https://shared.example.com/v1";
    process.env.OPENAI_API_KEY = "shared-key";
    const captured = { url: "", auth: "", model: "" };
    captureStub(captured);
    const provider = createLightLlmProvider();
    expect(provider).toBeDefined();
    await provider!.complete({ system: "s", user: "u" });
    expect(captured.url).toBe("https://light.example.com/v1/chat/completions");
    expect(captured.auth).toBe("Bearer light-key");
    expect(captured.model).toBe("glm-4.7");
  });

  it("未设独立变量时回落主力档共用变量（只填一套配置仍可用）", async () => {
    process.env.TUTOR_LIGHT_PROVIDER = "openai-compatible";
    process.env.TUTOR_LIGHT_MODEL = "glm-4.7";
    process.env.TUTOR_OPENAI_URL = "https://shared.example.com/v1";
    process.env.OPENAI_API_KEY = "shared-key";
    const captured = { url: "", auth: "", model: "" };
    captureStub(captured);
    const provider = createLightLlmProvider();
    await provider!.complete({ system: "s", user: "u" });
    expect(captured.url).toBe("https://shared.example.com/v1/chat/completions");
    expect(captured.auth).toBe("Bearer shared-key");
  });

  it("openai 协议无可用密钥时返回 undefined（由调用方回落主力档）", () => {
    process.env.TUTOR_LIGHT_PROVIDER = "openai";
    expect(createLightLlmProvider()).toBeUndefined();
  });

  it("模型名留空/空白视为 light 档未配置，返回 undefined（回落主力档）", () => {
    process.env.TUTOR_LIGHT_PROVIDER = "openai-compatible";
    process.env.TUTOR_LIGHT_MODEL = "";
    process.env.TUTOR_LIGHT_OPENAI_URL = "https://openrouter.ai/api/v1";
    expect(createLightLlmProvider()).toBeUndefined();
    process.env.TUTOR_LIGHT_MODEL = "   ";
    expect(createLightLlmProvider()).toBeUndefined();
  });
});

describe("ThinkingOverrideLlmProvider + thinking 参数", () => {
  function captureProvider(): { fetchImpl: typeof fetch; body: () => Record<string, unknown> | undefined } {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch;
    return { fetchImpl, body: () => captured };
  }

  it("off → thinking disabled 且不带 reasoning_effort（DeepSeek V4 模型）", async () => {
    const { fetchImpl, body } = captureProvider();
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, model: "deepseek-v4-flash", fetchImpl });
    await provider.complete({ system: "s", user: "u", thinking: "off" });
    expect(body()?.thinking).toEqual({ type: "disabled" });
    expect(body()?.reasoning_effort).toBeUndefined();
  });

  it("high → thinking enabled + reasoning_effort=high（DeepSeek V4 模型）", async () => {
    const { fetchImpl, body } = captureProvider();
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, model: "deepseek-v4-flash", fetchImpl });
    await provider.complete({ system: "s", user: "u", thinking: "high" });
    expect(body()?.thinking).toEqual({ type: "enabled" });
    expect(body()?.reasoning_effort).toBe("high");
  });

  it("未指定 thinking → 不发任何思考字段（其他端点行为不变）", async () => {
    const { fetchImpl, body } = captureProvider();
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await provider.complete({ system: "s", user: "u" });
    expect(body()?.thinking).toBeUndefined();
    expect(body()?.reasoning_effort).toBeUndefined();
  });

  it("包装器注入档位；auto 透传；调用点显式指定时不覆盖", async () => {
    const seen: Array<string | undefined> = [];
    const inner: LlmProvider = {
      name: "inner",
      modelVersion: "inner:model",
      async complete(input) {
        seen.push(input.thinking);
        return { text: "ok", finishReason: "stop" };
      }
    };
    await new ThinkingOverrideLlmProvider(inner, "high").complete({ system: "s", user: "u" });
    await new ThinkingOverrideLlmProvider(inner, "auto").complete({ system: "s", user: "u" });
    await new ThinkingOverrideLlmProvider(inner, "off").complete({ system: "s", user: "u", thinking: "low" });
    expect(seen).toEqual(["high", undefined, "low"]);
  });

  it("DeepSeek usage 的 prompt_cache_hit_tokens 透传进 LlmUsage；无该字段的端点保持 undefined", async () => {
    const withCache = new OpenAICompatibleProvider({
      ...OPTIONS,
      fetchImpl: (async () => jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 }
      })) as typeof fetch
    });
    const completion = await withCache.complete({ system: "s", user: "u" });
    expect(completion.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, promptCacheHitTokens: 64, promptCacheMissTokens: 36 });

    const withoutCache = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl: (async () => jsonResponse(chatBody("ok", "stop"))) as typeof fetch });
    const plain = await withoutCache.complete({ system: "s", user: "u" });
    expect(plain.usage?.promptCacheHitTokens).toBeUndefined();
    expect(plain.usage?.promptCacheMissTokens).toBeUndefined();
  });
});

describe("createTeachingProvider / createLightLlmProvider 模型覆盖", () => {
  const ENV = {
    TUTOR_TEACHING_PROVIDER: "openai-compatible",
    TUTOR_TEACHING_MODEL: "env-model",
    TUTOR_LIGHT_PROVIDER: "openai-compatible",
    TUTOR_OPENAI_URL: "https://llm.example.com/v1",
    OPENAI_API_KEY: "test-key"
  };

  it("覆盖模型生效；空串回落 .env", () => {
    const saved = { ...process.env };
    Object.assign(process.env, ENV);
    try {
      expect(createTeachingProvider({ model: "gui-model" })?.modelVersion).toContain("gui-model");
      expect(createTeachingProvider({ model: "  " })?.modelVersion).toContain("env-model");
      expect(createLightLlmProvider({ model: "gui-light" })?.modelVersion).toContain("gui-light");
      // 覆盖模型给了 light 档一个模型 → 不再视为「未配置」
      expect(createLightLlmProvider()).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});

describe("RetryLlmProvider", () => {
  const INPUT = { system: "s", user: "u" };

  function scripted(behaviors: Array<() => Promise<never> | Promise<{ text: string; finishReason: string }>>): { provider: RetryLlmProvider; calls: () => number } {
    let count = 0;
    const provider = new RetryLlmProvider({
      name: "scripted",
      modelVersion: "scripted:model",
      async complete() {
        const behavior = behaviors[Math.min(count, behaviors.length - 1)];
        count += 1;
        return behavior();
      }
    }, 3);
    return { provider, calls: () => count };
  }

  it("确定性 4xx（除 408/429）不重试：立即抛出且只调一次", async () => {
    const { provider, calls } = scripted([() => Promise.reject(new Error("LLM returned 400"))]);
    await expect(provider.complete(INPUT)).rejects.toThrow("LLM returned 400");
    expect(calls()).toBe(1);
  });

  it("429 限速重试后成功", async () => {
    const { provider, calls } = scripted([
      () => Promise.reject(new Error("LLM returned 429")),
      () => Promise.resolve({ text: "ok", finishReason: "stop" })
    ]);
    const result = await provider.complete(INPUT);
    expect(result.text).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("非 HTTP 状态的瞬态错误（网络/超时）仍按原策略重试", async () => {
    const { provider, calls } = scripted([
      () => Promise.reject(new Error("LLM request timeout")),
      () => Promise.reject(new Error("fetch failed")),
      () => Promise.resolve({ text: "late", finishReason: "stop" })
    ]);
    const result = await provider.complete(INPUT);
    expect(result.text).toBe("late");
    expect(calls()).toBe(3);
  });
});
