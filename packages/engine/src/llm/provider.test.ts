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
