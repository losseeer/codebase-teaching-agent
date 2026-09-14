import { describe, expect, it } from "vitest";
import { classifyIntent } from "./intent.js";
import { initialTeachingState } from "./state-machine.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";

const state = initialTeachingState();

function fakeProvider(text: string, usage?: LlmUsage, fail = false): LlmProvider & { calls: () => number } {
  let count = 0;
  return {
    name: "fake-classifier",
    modelVersion: "fake-classifier-v1",
    calls: () => count,
    complete: async (input) => {
      count += 1;
      if (fail) throw new Error("offline");
      void input;
      return { text, ...(usage ? { usage } : {}) };
    }
  };
}

describe("LLM intent classification", () => {
  it("prefers the LLM label even when the regex would disagree", async () => {
    // "我不清楚" 命中正则 needs_help，但 LLM 判定为实质性尝试——以 LLM 为准
    const provider = fakeProvider("progress", { inputTokens: 11, outputTokens: 1 });
    const result = await classifyIntent(state, "我不清楚", [], provider);
    expect(result).toEqual({ intent: "progress", source: "llm", usage: { inputTokens: 11, outputTokens: 1 } });
  });

  it("extracts the label when the model wraps it in extra text", async () => {
    const provider = fakeProvider("分类结果：needs_help。");
    const result = await classifyIntent(state, "帮我做", [], provider);
    expect(result.intent).toBe("needs_help");
    expect(result.source).toBe("llm");
  });

  it("falls back to the regex classifier when the label is invalid, keeping usage for audit", async () => {
    const provider = fakeProvider("抱歉我不明白你的要求", { inputTokens: 9, outputTokens: 6 });
    const verify = { stage: "verify" as const, fallbackCount: 0, attempts: 3 };
    const result = await classifyIntent(verify, "因为路由初始化依赖这个步骤", [], provider);
    expect(result).toEqual({ intent: "confirmation", source: "regex", usage: { inputTokens: 9, outputTokens: 6 } });
  });

  it("falls back to the regex classifier when the provider throws", async () => {
    const provider = fakeProvider("", undefined, true);
    const result = await classifyIntent(state, "不知道", [], provider);
    expect(result).toEqual({ intent: "needs_help", source: "regex" });
    expect(provider.calls()).toBe(1);
  });
});
