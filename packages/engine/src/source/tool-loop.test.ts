import { describe, expect, it } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { buildSearchCorpus } from "./search-code.js";
import { completeWithReadTool } from "./tool-loop.js";

/** repoPath 指向本目录：目录内 read-file.ts 是稳定存在的真实文件 */
const repoPath = import.meta.dirname;

function scriptedProvider(script: LlmCompletion[]): { provider: LlmProvider; calls: LlmCompletionInput[] } {
  const calls: LlmCompletionInput[] = [];
  let index = 0;
  return {
    calls,
    provider: {
      name: "scripted",
      modelVersion: "scripted:v1",
      async complete(input) {
        calls.push(input);
        return script[index++];
      }
    }
  };
}

const readCall = (id: string, path: string): LlmCompletion => ({ text: "", toolCalls: [{ id, name: "read_file", argumentsJson: JSON.stringify({ path }) }], usage: { inputTokens: 100, outputTokens: 10 }, finishReason: "tool_calls" });

describe("completeWithReadTool", () => {
  it("轮数预算用尽时明确回绝未应答的 tool_call，再做一轮不带工具的收尾", async () => {
    const { provider, calls } = scriptedProvider([
      readCall("c1", "read-file.ts"),
      readCall("c2", "read-file.ts"),
      { text: "基于已有上下文回答。", usage: { inputTokens: 50, outputTokens: 20 }, finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "问题原文", maxTokens: 700, temperature: 0, maxRounds: 1, maxCalls: 5 });
    expect(result.completion.text).toContain("基于已有上下文回答");
    expect(result.fileReads.map((read) => read.path)).toEqual(["read-file.ts"]);
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 40 });
    // 收尾轮不再带工具，并以回绝文本应答第二次调用
    expect(calls[2].tools).toBeUndefined();
    const refusal = calls[2].messages?.find((message) => message.role === "tool" && message.content.includes("读文件上限"));
    expect(refusal).toBeDefined();
    // 首轮 user 消息始终在 messages[0]（工具轮次后不丢上下文与提问）
    expect(calls[1].messages?.[0]).toMatchObject({ role: "user" });
    expect(calls[1].messages?.[0].content).toBe("问题原文");
  });

  it("累计文件数用尽时同样收尾；未知工具回喂明确提示", async () => {
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }, { id: "c2", name: "write_file", argumentsJson: "{}" }], finishReason: "tool_calls" },
      readCall("c3", "read-file.ts"),
      { text: "收尾。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 5, maxCalls: 1 });
    expect(result.completion.text).toBe("收尾。");
    const unknown = calls[2].messages?.find((message) => message.role === "tool" && message.content.includes("未知工具"));
    expect(unknown?.content).toContain("只支持 read_file");
    expect(result.fileReads).toHaveLength(1); // 未知工具不计入读取审计
  });

  it("被护栏拒绝的读取计入审计（denied），不中断对话", async () => {
    const { provider } = scriptedProvider([
      readCall("c1", ".env"),
      { text: "改看别的文件。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 3 });
    expect(result.fileReads).toHaveLength(1);
    expect(result.fileReads[0]).toMatchObject({ path: ".env", denied: true });
    expect(result.completion.text).toContain("改看别的文件");
  });

  it("被拒绝的读取不占文件额度：额度 1 也能在被拒后继续读真文件", async () => {
    const { provider, calls } = scriptedProvider([
      readCall("c1", ".env"),
      readCall("c2", "read-file.ts"),
      { text: "看完了。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 1 });
    expect(result.completion.text).toBe("看完了。");
    // 两次都进审计（拒绝也要留痕），但只有成功那次占用额度
    expect(result.fileReads.map((read) => read.denied)).toEqual([true, false]);
    expect(calls[2].tools).toBeDefined();
    const readBack = calls[2].messages?.find((message) => message.role === "tool" && message.content.startsWith("文件 "));
    expect(readBack?.content).toContain("read-file.ts");
  });
});

describe("completeWithReadTool 的用量汇总", () => {
  it("跨轮相加带上前缀缓存命中字段（教学线 journal 的 cache_hit 口径靠它）", async () => {
    const { provider } = scriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }], usage: { inputTokens: 8_000, outputTokens: 10, promptCacheHitTokens: 7_000 }, finishReason: "tool_calls" },
      { text: "读完的回答。", usage: { inputTokens: 9_000, outputTokens: 20, promptCacheHitTokens: 8_000 }, finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5 });
    // miss 字段两边都没上报 → 整个缺席，而不是 0（「没上报」≠「没命中」）
    expect(result.usage).toEqual({ inputTokens: 17_000, outputTokens: 30, promptCacheHitTokens: 15_000 });
  });
});

describe("completeWithReadTool 的 search_code 集成", () => {
  const corpus = buildSearchCorpus(
    { files: [{ path: "read-file.ts", extension: ".ts", bytes: 1, lines: 100 }] } as unknown as RepositoryIndex,
    { graph: { imports: { "read-file.ts": [] }, symbols: [{ id: "s1", name: "executeReadFile", kind: "function", path: "read-file.ts", line: 5 }] } } as unknown as RepositoryAnalysis,
    new Map([["read-file.ts", "读取仓库内文件的行窗口"]])
  );
  const searchCall = (id: string, query: string): LlmCompletion => ({ text: "", toolCalls: [{ id, name: "search_code", argumentsJson: JSON.stringify({ query }) }], finishReason: "tool_calls" });

  it("传入语料时开放两个工具；检索结果回喂、不占文件额度、不记 file_read", async () => {
    const { provider, calls } = scriptedProvider([
      searchCall("c1", "read"),
      readCall("c2", "read-file.ts"),
      { text: "先搜后读的回答。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 1, search: corpus });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file", "search_code"]);
    const searchResult = calls[1].messages?.find((message) => message.role === "tool");
    expect(searchResult?.content).toContain('search_code "read"');
    expect(searchResult?.content).toContain("read-file.ts");
    // maxCalls=1 只被那次成功的 read 用掉——检索没读任何文件
    expect(result.codeSearches).toEqual([{ query: "read", hits: 1, topPaths: ["read-file.ts"] }]);
    expect(result.fileReads).toHaveLength(1);
    expect(result.completion.text).toBe("先搜后读的回答。");
  });

  it("未传语料时 search_code 是未知工具（工具清单与提示都只认 read_file）", async () => {
    const { provider, calls } = scriptedProvider([
      searchCall("c1", "read"),
      { text: "收尾。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 3 });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    const unknown = calls[1].messages?.find((message) => message.role === "tool");
    expect(unknown?.content).toContain("未知工具 search_code");
    expect(unknown?.content).toContain("只支持 read_file。");
    expect(result.codeSearches).toEqual([]);
  });
});
