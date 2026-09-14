import { describe, expect, it } from "vitest";
import type { Exercise, RepositoryAnalysis } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { mapChat, practiceChat } from "./service.js";

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
    imports: { "src/app.ts": ["src/config.ts"], "src/utils/normalize.ts": ["src/config.ts"] },
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
    expect(user).toContain("启动流程");
    expect(user).toContain("src/app.ts");
    expect(user).toContain("src/config.ts"); // imports 邻居
    expect(user).toContain("为什么要分层？");
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
