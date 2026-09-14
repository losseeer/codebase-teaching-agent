import { describe, expect, it } from "vitest";
import type { Exercise, RepositoryAnalysis } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { mapChat, practiceChat, type MapChatProgress } from "./service.js";

function fakeProvider(): { provider: LlmProvider; calls: LlmCompletionInput[] } {
  const calls: LlmCompletionInput[] = [];
  const provider: LlmProvider = {
    name: "fake-provider",
    modelVersion: "fake:model",
    async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
      calls.push(input);
      return { text: "好的，基于上下文回答。", usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" };
    }
  };
  return { provider, calls };
}

const analysis = {
  repositoryId: "repo_test",
  generatedAt: new Date().toISOString(),
  graph: {
    imports: {
      "src/app.ts": ["src/config.ts"],
      "src/config.ts": ["src/paths.ts"],
      "src/boot.ts": ["src/app.ts"],
      "src/ui/theme.ts": ["src/boot.ts"],
      "src/utils/normalize.ts": ["src/config.ts"]
    },
    calls: [], symbols: [], entrypoints: [],
    semanticBackend: "static", lspStatus: []
  },
  implementations: [],
  quality: {},
  versionStamp: "v1"
} as unknown as RepositoryAnalysis;

const exercise = {
  id: "ex1",
  kind: "change_localization",
  title: "修改定位",
  prompt: "需要修改 bootstrap 的局部行为，选择必须首先修改的源码文件。",
  inputMode: "multi_select",
  gradingMode: "set_match",
  options: [
    { id: "a", label: "src/app.ts" },
    { id: "b", label: "src/config.ts" }
  ],
  anchors: [{ path: "src/app.ts", line: 4 }],
  contentVersion: "v1",
  targetUnitId: "u1",
  createdAt: new Date().toISOString()
} as unknown as Exercise;

describe("mapChat", () => {
  it("上下文包含节点摘要与依赖关系，回复与 usage 透传", async () => {
    const { provider, calls } = fakeProvider();
    const result = await mapChat({
      repoPath: import.meta.dirname,
      analysis,
      node: { id: "n1", title: "启动流程", summary: "应用入口的装配顺序", kind: "workflow", anchors: [], children: [] },
      path: "src/app.ts",
      content: "为什么要分层？",
      provider
    });
    expect(result.reply).toContain("基于上下文");
    expect(result.provider).toBe("fake-provider");
    expect(result.usage?.inputTokens).toBe(10);
    const user = calls[0].user;
    expect(user).toContain("项目结构全景");
    expect(user).toContain("src/utils/（1）：normalize.ts"); // 全景按目录分组列出已分析文件
    expect(user).toContain("启动流程");
    expect(user).toContain("src/app.ts");
    expect(user).toContain("src/config.ts"); // 一度邻居
    expect(user).toContain("src/paths.ts"); // 二度下游：config.ts 的 import
    expect(user).toContain("src/boot.ts"); // 一度上游
    expect(user).toContain("src/ui/theme.ts"); // 二度上游：boot.ts 的被 import
    expect(user).toContain("为什么要分层？");
  });

  it("工具循环：模型请求 read_file → 引擎执行并回喂 → 汇总 usage 与 fileReads", async () => {
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "call_a", name: "read_file", argumentsJson: JSON.stringify({ path: "service.ts" }) }], usage: { inputTokens: 100, outputTokens: 20 }, finishReason: "tool_calls" },
      { text: "读完文件后的回答。", usage: { inputTokens: 200, outputTokens: 30 }, finishReason: "stop" }
    ];
    const calls: LlmCompletionInput[] = [];
    const progressEvents: MapChatProgress[] = [];
    let index = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted:model",
      async complete(input) {
        calls.push(input);
        return script[index++] ?? script[script.length - 1];
      }
    };
    const result = await mapChat({
      repoPath: import.meta.dirname,
      analysis,
      path: "src/app.ts",
      content: "service.ts 里定义了什么？",
      provider,
      onProgress: (progress) => progressEvents.push(progress)
    });
    expect(result.reply).toContain("读完文件后的回答");
    expect(progressEvents).toEqual([
      { type: "thinking", round: 1 },
      { type: "reading", path: "service.ts" },
      { type: "thinking", round: 2 }
    ]);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 50 });
    expect(result.fileReads).toEqual([{ path: "service.ts", lines: 150, bytes: expect.any(Number), truncated: true, denied: false }]); // 默认窗口 150 行 < 文件总行数 → truncated
    // 第二轮请求携带完整历史：原始 user 消息（上下文+问题）+ assistant toolCalls + tool 结果（带行号的真实文件内容）
    const second = calls[1];
    expect(second.messages?.[0]).toMatchObject({ role: "user" });
    expect(second.messages?.[0].content).toContain("项目结构全景"); // 回归：工具轮次后不得丢失代码上下文
    expect(second.messages?.[0].content).toContain("service.ts 里定义了什么？"); // 回归：不得丢失原始提问
    expect(second.messages?.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "read_file")).toBe(true);
    const toolResult = second.messages?.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("1| ");
    expect(toolResult?.content).toContain("export");
    // 首轮请求带 tools 定义
    expect(calls[0].tools?.[0]?.name).toBe("read_file");
  });
});

describe("practiceChat", () => {
  it("上下文包含题面与选项，但不含判分答案", async () => {
    const { provider, calls } = fakeProvider();
    const result = await practiceChat({
      repoPath: import.meta.dirname,
      exercise,
      content: "为什么不是 config.ts？",
      provider
    });
    const user = calls[0].user;
    expect(user).toContain("修改定位");
    expect(user).toContain("src/app.ts");
    expect(user).toContain("为什么不是 config.ts？");
    // 学习者安全：expected / answerKey 不允许进入 prompt
    expect(user).not.toContain("expectedIds");
    expect(user).not.toContain("answerKey");
    expect(result.reply).toContain("基于上下文");
  });
});
