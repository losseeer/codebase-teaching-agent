import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./provider.js";

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
  it("max_tokens 加上推理余量（默认 1500）", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(chatBody("ok", "stop"));
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({ ...OPTIONS, fetchImpl });
    await provider.complete({ system: "s", user: "u", maxTokens: 12 });
    expect(captured?.max_tokens).toBe(12 + 1_500);
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
      .rejects.toThrow(/max_tokens=1800.*推理模型/);
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
});
