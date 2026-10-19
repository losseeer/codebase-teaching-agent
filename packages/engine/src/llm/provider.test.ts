import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmProvider, LlmAbortedError, OpenAICompatibleProvider, RetryLlmProvider, screenOutbound, ThinkingOverrideLlmProvider, type LlmProvider } from "./provider.js";

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
  it("出网前的总闸口：装配点漏筛的密钥在发送边被隐去，请求体里不留明文", async () => {
    let raw = "";
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      raw = String(init?.body);
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    // 这道闸防的正是「新增装配路径忘了过筛」——出题的源码摘录原文就是这类载荷
    await provider.complete({
      system: "你是代码教学产品",
      messages: [{ role: "user", content: "const awsKey = \"AKIAIOSFODNN7EXAMPLE\";" }]
    });
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(raw).toContain("已隐去");
  });

  it("screenOutbound：没命中密钥时原样返回同一个对象（缓存前缀不能因为过筛而逐次变）", () => {
    const clean = { system: "系统", user: "这一段没有任何密钥形态的串" };
    expect(screenOutbound(clean)).toBe(clean);
    const dirty = { system: "系统", user: "token = sk-abcdefghijklmnopqrstuvwxyz0123456789" };
    const screened = screenOutbound(dirty);
    expect(screened).not.toBe(dirty);
    expect(screened.user).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    // 已经筛过的再过一次必须完全不动：掩码串不会被二次命中
    expect(screenOutbound(screened)).toBe(screened);
  });


  it("max_tokens 加上推理余量（默认 6000）", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await provider.complete({ system: "s", user: "u", maxTokens: 12 });
    expect(captured?.max_tokens).toBe(12 + 6_000);
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

  it("finish=length 且 content 为空：先抬一档重发，两发都空才抛，报的是最后一发的预算", async () => {
    const sent: number[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent.push((JSON.parse(String((init as RequestInit).body)) as { max_tokens: number }).max_tokens);
      return jsonResponse(chatBody("", "length"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await expect(provider.complete({ system: "s", user: "u", maxTokens: 300 }))
      .rejects.toThrow(/两发都被 max_tokens=12300 截断.*推理模型/);
    expect(sent, "6300 与 12300：第一次被截断之后余量翻倍再发一次，不是原样重发").toEqual([6300, 12300]);
  });

  it("非 length 的空 content 保持通用错误", async () => {
    const fetchImpl = (async () => jsonResponse(chatBody("  ", "stop"))) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow("LLM returned an empty completion");
  });

  it("请求中止时抛显式超时错误", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
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

  it("外部 signal 挂到 fetch 的 signal 上，中止抛 LlmAbortedError 而不是超时文案", async () => {
    const controller = new AbortController();
    let handedSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      handedSignal = init?.signal ?? undefined;
      handedSignal?.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as typeof fetch;
    // timeoutMs 故意给足：这里要证明的是「外部中止 ≠ 超时」，不是竞态
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl, timeoutMs: 5_000 });
    const pending = provider.complete({ system: "s", user: "u", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
    expect(handedSignal?.aborted).toBe(true);
  });
});

describe("createLlmProvider（单一配置）", () => {
  const ENV_KEYS = ["TUTOR_LLM_PROVIDER", "TUTOR_LLM_MODEL", "TUTOR_TEACHING_PROVIDER", "TUTOR_TEACHING_MODEL", "TUTOR_OPENAI_URL", "TUTOR_OPENAI_API_KEY", "OPENAI_API_KEY", "TUTOR_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "TUTOR_OLLAMA_URL"];

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
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

  /**
    钉住「只认 TUTOR_LLM_* 与通用密钥名」：已删的别名不再是配置来源，防止将来为兼容旧 .env 把别名接回去。
    */
  it("只认 TUTOR_LLM_* 与通用密钥名；已删的别名一个都不读", async () => {
    process.env.TUTOR_TEACHING_PROVIDER = "openai-compatible";
    process.env.TUTOR_TEACHING_MODEL = "legacy-model";
    process.env.TUTOR_OPENAI_API_KEY = "alias-key";
    expect(createLlmProvider(), "别名再也不是配置来源").toBeUndefined();

    process.env.TUTOR_LLM_PROVIDER = "openai-compatible";
    const captured = { url: "", auth: "", model: "" };
    captureStub(captured);
    await createLlmProvider()!.complete({ system: "s", user: "u" });
    expect(captured.model, "legacy-model 不该从别名漏进来").toBe("gpt-4o-mini");
    expect(captured.auth, "TUTOR_OPENAI_API_KEY 不该被当成密钥").toBe("");
  });

  it("TUTOR_LLM_* 生效，密钥只认通用名 OPENAI_API_KEY", async () => {
    process.env.TUTOR_LLM_PROVIDER = "openai-compatible";
    process.env.TUTOR_LLM_MODEL = "glm-4.7";
    process.env.TUTOR_OPENAI_URL = "https://llm.example.com/v1";
    process.env.OPENAI_API_KEY = "shared-key";
    const captured = { url: "", auth: "", model: "" };
    captureStub(captured);
    await createLlmProvider()!.complete({ system: "s", user: "u" });
    expect(captured.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(captured.model).toBe("glm-4.7");
    expect(captured.auth).toBe("Bearer shared-key");
  });

  it("provider 未配置时返回 undefined（调用方回落本地启发式，不静默造空模型实例）", () => {
    expect(createLlmProvider()).toBeUndefined();
  });

  it("GUI 覆盖模型生效；空白覆盖回落 .env", () => {
    process.env.TUTOR_LLM_PROVIDER = "openai-compatible";
    process.env.TUTOR_LLM_MODEL = "env-model";
    process.env.TUTOR_OPENAI_URL = "https://llm.example.com/v1";
    process.env.OPENAI_API_KEY = "test-key";
    expect(createLlmProvider({ model: "gui-model" })?.modelVersion).toContain("gui-model");
    expect(createLlmProvider({ model: "  " })?.modelVersion).toContain("env-model");
  });

  it("GUI 覆盖服务商/端点/密钥：整条链路换掉，.env 的 provider 与 OPENAI_API_KEY 都不参与", async () => {
    process.env.TUTOR_LLM_PROVIDER = "ollama";
    process.env.OPENAI_API_KEY = "env-key";
    const captured = { url: "", auth: "", model: "" };
    captureStub(captured);
    const provider = createLlmProvider({ provider: "openai-compatible", baseUrl: "https://gui.example.com/v1", apiKey: "gui-key", model: "gui-model" });
    expect(provider?.name).toContain("OpenAI-compatible");
    await provider!.complete({ system: "s", user: "u" });
    expect(captured.url).toBe("https://gui.example.com/v1/chat/completions");
    expect(captured.auth).toBe("Bearer gui-key");
    expect(captured.model).toBe("gui-model");
  });

  it("覆盖项留空 = 逐项回落 .env（可以只换密钥不换服务商）", () => {
    process.env.TUTOR_LLM_PROVIDER = "openai-compatible";
    process.env.TUTOR_LLM_MODEL = "env-model";
    process.env.TUTOR_OPENAI_URL = "https://llm.example.com/v1";
    process.env.OPENAI_API_KEY = "env-key";
    expect(createLlmProvider({ provider: "  ", model: "", baseUrl: "", apiKey: "" })?.modelVersion).toContain("env-model");
    // 服务商仍是 .env 的 openai-compatible，但密钥换成 GUI 填的
    expect(createLlmProvider({ apiKey: "gui-key" })).toBeDefined();
  });

  it("anthropic 走 GUI 密钥与默认端点；两边都没有密钥就不建实例", () => {
    // 显式清空两侧密钥：这台机器上 export 了 ANTHROPIC_API_KEY 时「缺 key 不建实例」的断言仍要成立
    for (const key of ["ANTHROPIC_API_KEY", "TUTOR_ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TUTOR_OPENAI_API_KEY"]) delete process.env[key];
    const provider = createLlmProvider({ provider: "anthropic", apiKey: "gui-anthropic-key" });
    expect(provider?.name).toContain("Anthropic");
    expect(createLlmProvider({ provider: "anthropic" })).toBeUndefined();
    // 官方 openai 同理：没 key 必然 401，宁可不建实例让调用方走本地启发式
    expect(createLlmProvider({ provider: "openai" })).toBeUndefined();
    // 兼容端点允许无 key（本地 Ollama/LM Studio 的 OpenAI 层）
    expect(createLlmProvider({ provider: "openai-compatible" })).toBeDefined();
  });

  it("ollama 端点覆盖生效（本地服务改端口/改主机是常见配置）", () => {
    delete process.env.TUTOR_LLM_MODEL;
    delete process.env.TUTOR_OLLAMA_URL;
    const provider = createLlmProvider({ provider: "ollama", baseUrl: "http://192.168.1.9:11434" });
    expect(provider?.name).toContain("Ollama");
    expect(provider?.modelVersion).toContain("llama3.2");
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

  it("重试过的读数带得出来：attempts=2，attemptMs 一条一次（这就是超时率的真读数来源）", async () => {
    const { provider, calls } = scripted([
      () => Promise.reject(new Error("LLM 请求超时（60000ms）")),
      () => Promise.resolve({ text: "ok", finishReason: "stop" })
    ]);
    const result = await provider.complete(INPUT);
    expect(result.text).toBe("ok");
    expect(calls()).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.attemptMs).toHaveLength(2);
  });

  it("一次成的也要写 attempts=1：缺这个字段的是历史行，不能把「没记」读成 1", async () => {
    const { provider } = scripted([() => Promise.resolve({ text: "first try", finishReason: "stop" })]);
    const result = await provider.complete(INPUT);
    expect(result.attempts).toBe(1);
    expect(result.attemptMs).toHaveLength(1);
  });

  it("最终失败也带次数，且挂在错误上的这两个字段不可枚举（不改错误对象的对外形状）", async () => {
    const { provider, calls } = scripted([
      () => Promise.reject(new Error("LLM returned 500")),
      () => Promise.reject(new Error("LLM returned 503")),
      () => Promise.reject(new Error("LLM returned 503"))
    ]);
    const caught = await provider.complete(INPUT).catch((error: Error) => error);
    expect(calls()).toBe(3);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as unknown as { attempts?: number }).attempts).toBe(3);
    expect(JSON.stringify({ e: caught })).toBe('{"e":{}}'); // 只有 message/stack 是惯例可枚举的：这两个字段读数不该混进去
    expect(Object.keys(caught)).toEqual([]);
  });

  it("中止不重试：哨兵错误立即上抛，只调一次", async () => {
    const controller = new AbortController();
    let count = 0;
    const provider = new RetryLlmProvider({
      name: "scripted",
      modelVersion: "scripted:model",
      async complete() {
        count += 1;
        controller.abort();
        throw new LlmAbortedError();
      }
    }, 3);
    await expect(provider.complete({ ...INPUT, signal: controller.signal })).rejects.toBeInstanceOf(LlmAbortedError);
    expect(count).toBe(1);
  });

  it("裸 AbortError（响应体读取阶段被打断）也不重试，并归一成 LlmAbortedError", async () => {
    const controller = new AbortController();
    let count = 0;
    const provider = new RetryLlmProvider({
      name: "scripted",
      modelVersion: "scripted:model",
      async complete() {
        count += 1;
        controller.abort();
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      }
    }, 3);
    await expect(provider.complete({ ...INPUT, signal: controller.signal })).rejects.toBeInstanceOf(LlmAbortedError);
    expect(count).toBe(1);
  });
});

/**
  推理预算升档：这一族失败是思考量把输出预算挤空，不是超时，值得「换一档预算再发一次」而不是原样重发。
  Response 的 body 只能读一次，所以这里给的是工厂函数而不是现成响应。
  */
describe("OpenAICompatibleProvider 的推理预算升档", () => {
  function scripted(bodies: Array<() => Response>) {
    const sent: number[] = [];
    let call = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String((init as RequestInit).body)) as { max_tokens: number };
      sent.push(payload.max_tokens);
      const factory = bodies[Math.min(call, bodies.length - 1)];
      call += 1;
      return factory();
    }) as unknown as typeof fetch;
    return { fetchImpl, sent };
  }

  it("第一发被思考挤空 ⇒ 第二发把 max_tokens 抬高一档再发，并在结果上留痕", async () => {
    process.env.TUTOR_LLM_REASONING_HEADROOM = "6000";
    const { fetchImpl, sent } = scripted([() => jsonResponse(chatBody("", "length")), () => jsonResponse(chatBody("这次有正文", "stop"))]);
    const done = await new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl }).complete({ system: "s", user: "u", maxTokens: 700 });
    expect(sent, "第一发 700+6000，第二发 700+2×6000：抬的是思考余量的预算，不是随便加码").toEqual([6700, 12700]);
    expect(done.text).toBe("这次有正文");
    expect(done.headroomEscalated).toBe(true);
  });

  it("两发都被截断才抛：话说清最后一发的预算与当前余量", async () => {
    process.env.TUTOR_LLM_REASONING_HEADROOM = "6000";
    const { fetchImpl, sent } = scripted([() => jsonResponse(chatBody("", "length"))]);
    await expect(new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl }).complete({ system: "s", user: "u", maxTokens: 700 }))
      .rejects.toThrow(/两发都被 max_tokens=12700 截断.*TUTOR_LLM_REASONING_HEADROOM=6000/);
    expect(sent).toEqual([6700, 12700]);
  });

  it("余量关成 0 ⇒ 只发一发就抛：原样重发同一份预算只是赌运气，不做", async () => {
    process.env.TUTOR_LLM_REASONING_HEADROOM = "0";
    const { fetchImpl, sent } = scripted([() => jsonResponse(chatBody("", "length"))]);
    await expect(new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl }).complete({ system: "s", user: "u" })).rejects.toThrow("max_tokens=700");
    expect(sent).toEqual([700]);
  });

  it("正文没被截断时行为一字不变：单发、不升档、不留痕", async () => {
    process.env.TUTOR_LLM_REASONING_HEADROOM = "6000";
    const { fetchImpl, sent } = scripted([() => jsonResponse(chatBody("正常正文", "stop"))]);
    const done = await new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl }).complete({ system: "s", user: "u", maxTokens: 700 });
    expect(sent).toEqual([6700]);
    expect(done.headroomEscalated).toBeUndefined();
  });
});
