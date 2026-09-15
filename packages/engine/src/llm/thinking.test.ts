import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider, OpenAICompatibleProvider, OllamaTeachingProvider } from "./provider.js";
import { applyThinking, isThinkingEffortSupported, resetThinkingEnvCacheForTests, resolveThinkingCapability, supportedThinkingEfforts } from "./thinking.js";

afterEach(() => {
  delete process.env.TUTOR_THINKING_STYLES;
  resetThinkingEnvCacheForTests();
});

describe("resolveThinkingCapability", () => {
  it("DeepSeek V4：thinking 开关 + effort 三档", () => {
    expect(resolveThinkingCapability("deepseek-v4-flash")).toEqual({
      style: "deepseek",
      efforts: { off: "disabled", low: "low", high: "high", max: "max" }
    });
  });

  it("deepseek-flash（官方现役名，遗留别名 deepseek-v4-flash 的替代）同样是 V4 思考格式", () => {
    expect(resolveThinkingCapability("deepseek-flash")).toEqual({
      style: "deepseek",
      efforts: { off: "disabled", low: "low", high: "high", max: "max" }
    });
    expect(resolveThinkingCapability("deepseek-flash-vision-exp").style).toBe("deepseek");
  });

  it("OpenRouter 风格 vendor 前缀 slug 也能命中（取最后一段匹配）", () => {
    expect(resolveThinkingCapability("deepseek/deepseek-v4-pro").style).toBe("deepseek");
    expect(resolveThinkingCapability("anthropic/claude-sonnet-4-6").style).toBe("anthropic");
  });

  it("旧 DeepSeek 模型无思考参数", () => {
    expect(resolveThinkingCapability("deepseek-chat")).toEqual({ style: "none", efforts: {} });
    expect(resolveThinkingCapability("deepseek-v3.2").style).toBe("none");
  });

  it("GPT-5.6：none/max 是真实取值；GPT-5.2~5.5 的 max 映射 xhigh", () => {
    expect(resolveThinkingCapability("gpt-5.6")?.efforts.max).toBe("max");
    expect(resolveThinkingCapability("gpt-5.6")?.efforts.off).toBe("none");
    expect(resolveThinkingCapability("gpt-5.2")?.efforts.max).toBe("xhigh");
    expect(resolveThinkingCapability("gpt-5.4-mini")?.efforts.off).toBe("none");
  });

  it("GPT-5 初代与 o 系：不支持关闭与 max", () => {
    expect(resolveThinkingCapability("gpt-5")).toEqual({ style: "openai", efforts: { low: "low", high: "high" } });
    expect(resolveThinkingCapability("gpt-5-mini").efforts).toEqual({ low: "low", high: "high" });
    expect(resolveThinkingCapability("o3").efforts).toEqual({ low: "low", high: "high" });
  });

  it("Claude 兼容层只有开关；Gemini 3 不能关思考、2.5 可以", () => {
    expect(resolveThinkingCapability("claude-opus-5")).toEqual({ style: "anthropic", efforts: { off: "disabled" } });
    expect(resolveThinkingCapability("gemini-3-flash").efforts).toEqual({ low: "low", high: "high" });
    expect(resolveThinkingCapability("gemini-2.5-flash").efforts).toEqual({ off: "none", low: "low", high: "high" });
    expect(resolveThinkingCapability("gemini-2.5-pro").efforts).toEqual({ low: "low", high: "high" });
  });

  it("GLM：5.3 不能关闭、5.2 全档、5.0/4.x 只有开关（前缀顺序不被 glm-5 抢先）", () => {
    expect(resolveThinkingCapability("glm-5.3").efforts).toEqual({ low: "low", high: "high", max: "max" });
    expect(resolveThinkingCapability("glm-5.2").efforts).toEqual({ off: "disabled", low: "low", high: "high", max: "max" });
    expect(resolveThinkingCapability("glm-5.1").efforts).toEqual({ off: "disabled" });
    expect(resolveThinkingCapability("glm-4.6").efforts).toEqual({ off: "disabled" });
    expect(resolveThinkingCapability("glm-4.5-air").efforts).toEqual({ off: "disabled" });
    expect(resolveThinkingCapability("zhipu/glm-5.3").style).toBe("deepseek");
  });

  it("Kimi：只有开关；k2.5/k2.6 可关闭，k2.7-code/k3 强制思考", () => {
    expect(resolveThinkingCapability("kimi-k2.5")).toEqual({ style: "anthropic", efforts: { off: "disabled" } });
    expect(resolveThinkingCapability("kimi-k2.6")).toEqual({ style: "anthropic", efforts: { off: "disabled" } });
    expect(resolveThinkingCapability("kimi-k2.7-code")).toEqual({ style: "anthropic", efforts: {} });
    expect(resolveThinkingCapability("kimi-k3")).toEqual({ style: "anthropic", efforts: {} });
    expect(resolveThinkingCapability("moonshot/kimi-k2.6").style).toBe("anthropic");
  });

  it("表外模型 → unknown；TUTOR_THINKING_STYLES 可声明能力且优先于内置表", () => {
    expect(resolveThinkingCapability("qwen3.7-max")).toEqual({ style: "unknown", efforts: {} });
    process.env.TUTOR_THINKING_STYLES = "qwen3.7=deepseek, deepseek-v4=openai";
    resetThinkingEnvCacheForTests();
    expect(resolveThinkingCapability("qwen3.7-max")).toEqual({
      style: "deepseek",
      efforts: { off: "disabled", low: "low", high: "high", max: "max" }
    });
    // 环境声明覆盖内置表（deepseek-v4 → openai 样式）
    expect(resolveThinkingCapability("deepseek-v4-flash").style).toBe("openai");
  });

  it("TUTOR_THINKING_STYLES 非法条目被跳过并告警", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      process.env.TUTOR_THINKING_STYLES = "bad-entry, mymodel=nonsense, mymodel2=none";
      resetThinkingEnvCacheForTests();
      expect(resolveThinkingCapability("mymodel2-x")).toEqual({ style: "none", efforts: {} });
      expect(warnings).toHaveLength(2);
    } finally {
      console.warn = original;
    }
  });

  it("supportedThinkingEfforts：unknown 模型为空数组", () => {
    expect(supportedThinkingEfforts(resolveThinkingCapability("mystery-model"))).toEqual([]);
    expect(supportedThinkingEfforts(resolveThinkingCapability("deepseek-v4-flash"))).toEqual(["off", "low", "high", "max"]);
  });

  it("isThinkingEffortSupported：off 对 none/unknown 恒可用，与 applyThinking 豁免一致", () => {
    // unknown 模型：off 可用（= 不发字段），强度档不可用
    expect(isThinkingEffortSupported("mystery-model", "off")).toBe(true);
    expect(isThinkingEffortSupported("mystery-model", "low")).toBe(false);
    expect(isThinkingEffortSupported("mystery-model", "auto")).toBe(true);
    // none 样式同款豁免；表内模型按 efforts 判定
    expect(isThinkingEffortSupported("deepseek-chat", "off")).toBe(true);
    expect(isThinkingEffortSupported("deepseek-chat", "high")).toBe(false);
    expect(isThinkingEffortSupported("deepseek-v4-flash", "max")).toBe(true);
    // 关不掉思考的模型 off 仍然拒绝
    expect(isThinkingEffortSupported("gpt-5", "off")).toBe(false);
    expect(isThinkingEffortSupported("kimi-k3", "off")).toBe(false);
  });
});

describe("applyThinking", () => {
  it("deepseek 样式：off → thinking disabled；low/high/max → enabled + reasoning_effort", () => {
    const off: Record<string, unknown> = {};
    applyThinking(off, "deepseek-v4-flash", "off");
    expect(off).toEqual({ thinking: { type: "disabled" } });
    const max: Record<string, unknown> = {};
    applyThinking(max, "deepseek-v4-flash", "max");
    expect(max).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
  });

  it("openai 样式：一律顶层 reasoning_effort（off→none、max→xhigh 按模型映射）", () => {
    const gpt52off: Record<string, unknown> = {};
    applyThinking(gpt52off, "gpt-5.2", "off");
    expect(gpt52off).toEqual({ reasoning_effort: "none" });
    const gpt52max: Record<string, unknown> = {};
    applyThinking(gpt52max, "gpt-5.2", "max");
    expect(gpt52max).toEqual({ reasoning_effort: "xhigh" });
    const gpt56max: Record<string, unknown> = {};
    applyThinking(gpt56max, "gpt-5.6", "max");
    expect(gpt56max).toEqual({ reasoning_effort: "max" });
  });

  it("anthropic 样式：off → thinking disabled；无 effort 档位", () => {
    const off: Record<string, unknown> = {};
    applyThinking(off, "claude-opus-5", "off");
    expect(off).toEqual({ thinking: { type: "disabled" } });
  });

  it("GLM-5.2：off → thinking disabled；max → enabled + reasoning_effort；GLM-5.3 off 报错", () => {
    const off: Record<string, unknown> = {};
    applyThinking(off, "glm-5.2", "off");
    expect(off).toEqual({ thinking: { type: "disabled" } });
    const max: Record<string, unknown> = {};
    applyThinking(max, "glm-5.2", "max");
    expect(max).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(() => applyThinking({}, "glm-5.3", "off")).toThrow(/glm-5.3 不支持思考档位 "off"[\s\S]*支持：low\/high\/max/);
  });

  it("Kimi：k2.6 off → thinking disabled；k3 强制思考 off 报错且支持档位为空", () => {
    const off: Record<string, unknown> = {};
    applyThinking(off, "kimi-k2.6", "off");
    expect(off).toEqual({ thinking: { type: "disabled" } });
    expect(() => applyThinking({}, "kimi-k3", "off")).toThrow(/kimi-k3 不支持思考档位 "off"/);
    expect(() => applyThinking({}, "kimi-k3", "off")).not.toThrow(/TUTOR_THINKING_STYLES/);
    expect(supportedThinkingEfforts(resolveThinkingCapability("kimi-k3"))).toEqual([]);
  });

  it("none 样式：off = 不发字段；unknown 模型显式档位抛错", () => {
    const off: Record<string, unknown> = {};
    applyThinking(off, "deepseek-chat", "off");
    expect(off).toEqual({});
    expect(() => applyThinking({}, "mystery-model", "low")).toThrow(/mystery-model 不支持思考档位 "low"[\s\S]*TUTOR_THINKING_STYLES/);
    expect(() => applyThinking({}, "deepseek-chat", "high")).toThrow(/deepseek-chat 不支持思考档位 "high"/);
  });

  it("显式下发不支持的档位（gpt-5 初代 off）报错并给出支持档位", () => {
    expect(() => applyThinking({}, "gpt-5", "off")).toThrow(/不支持思考档位 "off"[\s\S]*支持：low\/high/);
    expect(() => applyThinking({}, "o3", "max")).toThrow(/不支持思考档位 "max"/);
  });
});

describe("Anthropic / Ollama provider 显式思考档位", () => {
  it("AnthropicProvider 显式档位抛错；off/auto 正常", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }), { status: 200 })) as typeof fetch;
    const provider = new AnthropicProvider({ endpoint: "https://api.anthropic.com", apiKey: "k", model: "claude-opus-5", fetchImpl });
    await expect(provider.complete({ system: "s", user: "u", thinking: "high" })).rejects.toThrow(/Anthropic 原生协议暂不支持思考档位 "high"/);
    const ok = await provider.complete({ system: "s", user: "u", thinking: "off" });
    expect(ok.text).toBe("ok");
  });

  it("OllamaTeachingProvider 显式档位抛错", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: { content: "ok" }, done_reason: "stop" }), { status: 200 })) as typeof fetch;
    const provider = new OllamaTeachingProvider({ endpoint: "http://127.0.0.1:11434", model: "llama3.2", fetchImpl });
    await expect(provider.complete({ system: "s", user: "u", thinking: "low" })).rejects.toThrow(/Ollama provider 暂不支持思考档位 "low"/);
  });
});

describe("OpenAICompatibleProvider 按模型能力组装思考参数（端到端）", () => {
  function captureProvider(model: string): { provider: OpenAICompatibleProvider; body: () => Record<string, unknown> | undefined } {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    }) as typeof fetch;
    return { provider: new OpenAICompatibleProvider({ endpoint: "https://llm.example.com/v1", apiKey: "k", model, fetchImpl }), body: () => captured };
  }

  it("GPT-5.2 off → reasoning_effort=none（不发 thinking 对象）", async () => {
    const { provider, body } = captureProvider("gpt-5.2");
    await provider.complete({ system: "s", user: "u", thinking: "off" });
    expect(body()?.reasoning_effort).toBe("none");
    expect(body()?.thinking).toBeUndefined();
  });

  it("DeepSeek V4 off → thinking disabled（不发 reasoning_effort）", async () => {
    const { provider, body } = captureProvider("deepseek/deepseek-v4-flash");
    await provider.complete({ system: "s", user: "u", thinking: "off" });
    expect(body()?.thinking).toEqual({ type: "disabled" });
    expect(body()?.reasoning_effort).toBeUndefined();
  });

  it("未知模型显式档位在发请求前抛错", async () => {
    const { provider, body } = captureProvider("mystery-model");
    await expect(provider.complete({ system: "s", user: "u", thinking: "high" })).rejects.toThrow(/mystery-model 不支持思考档位 "high"/);
    expect(body()).toBeUndefined();
  });
});
