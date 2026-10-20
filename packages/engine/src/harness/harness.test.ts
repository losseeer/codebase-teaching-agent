import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { TeachingScope } from "../source/scope.js";
import { createSession, respondWithProvider, type TeachingProgress } from "./harness.js";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { LlmAbortedError } from "../llm/provider.js";

const scope: TeachingScope = { kind: "file", path: "src/main.ts", ref: "file:src/main.ts" };
const index = {
  repositoryId: "repo", repositoryPath: "/fixture", scannedAt: "2026-10-18T00:00:00.000Z", totalFiles: 2, totalLines: 5,
  files: [
    { path: "src/main.ts", extension: ".ts", bytes: 1, lines: 2 },
    { path: "src/boot.ts", extension: ".ts", bytes: 1, lines: 3 }
  ],
  fileTree: [], hotspots: []
} as RepositoryIndex;

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

function fixtureRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "codebase-tutor-harness-"));
  repositories.push(repository);
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, "src/main.ts"), "export const main = () => readConfig();\nconst config = readConfig();\n", "utf8");
  return repository;
}

/**
  问答回合的用例：一条形状——装配上下文 → 工具循环 → 模型答一次 → 双边正文进会话。
  */
describe("provider-backed code Q&A harness", () => {
  it("把真实源码摘录与有界历史拼进提示词，且不再出现阶段与本轮动作", async () => {
    const repository = fixtureRepository();
    let prompt = "";
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { prompt = `${input.system}\n${input.user}`; return { text: "入口先读配置，再看它把什么交给下一步。", usage: { inputTokens: 20, outputTokens: 7 } }; } };
    const result = await respondWithProvider(createSession("repo", scope.ref), scope, "这段先跑哪一步？", provider, { sampleCompleteness: 1, hintDepth: 2, stylePlainness: 1, mastered: true, transition: "fade", reason: "掌握后减少样例。" }, repository, { index });
    expect(result.assistant.content).toBe("入口先读配置，再看它把什么交给下一步。");
    expect(result.provider).toBe("fake");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 7 });
    expect(result.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    // 会话形状里没有 stage / fallbackCount 这类回合状态字段
    expect(result.session).not.toHaveProperty("stage");
    expect(result.session).not.toHaveProperty("fallbackCount");
    expect(prompt).toContain("当前作用域: 文件 src/main.ts");
    expect(prompt).toContain("src/main.ts:1-3");
    expect(prompt).toContain("1: export const main = () => readConfig();");
    expect(prompt).toContain("通俗化 1/5");
    expect(prompt).not.toContain("当前阶段");
    expect(prompt).not.toContain("本轮动作");

    const second = await respondWithProvider(result.session, scope, "那配置从哪来？", provider, undefined, repository, { index });
    expect(second.provider).toBe("fake");
    expect(prompt).toContain("学习者: 这段先跑哪一步？");
    expect(prompt).toContain("导师: 入口先读配置，再看它把什么交给下一步。");
    expect(prompt).toContain("学习者本轮输入：那配置从哪来？");
  });

  it("模型调用失败就抛错：不回落成本地启发式文案", async () => {
    const provider: LlmProvider = { name: "broken", modelVersion: "broken-v1", complete: async () => { throw new Error("offline"); } };
    await expect(respondWithProvider(createSession("repo", scope.ref), scope, "这是什么？", provider)).rejects.toThrow("offline");
  });

  it("用户中止原样上抛，不伪造一轮成品", async () => {
    const repository = fixtureRepository();
    const controller = new AbortController();
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async () => { controller.abort(); throw new LlmAbortedError(); } };
    await expect(respondWithProvider(createSession("repo", scope.ref), scope, "先看哪里？", provider, undefined, repository, { signal: controller.signal }))
      .rejects.toBeInstanceOf(LlmAbortedError);
  });

  it("源码读不动也照样装配上下文", async () => {
    let prompt = "";
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { prompt = `${input.system}\n${input.user}`; return { text: "好", usage: { inputTokens: 5, outputTokens: 1 } }; } };
    await respondWithProvider(createSession("repo", scope.ref), scope, "继续", provider, undefined, join(tmpdir(), "codebase-tutor-harness-missing"));
    expect(prompt).not.toContain("--- src/main.ts:");
    expect(prompt).toContain("当前作用域: 文件 src/main.ts");
  });

  it("模型可以要求 read_file 补足摘录之外的实现细节，并回报读取审计", async () => {
    const repository = fixtureRepository();
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "src/main.ts" }) }], usage: { inputTokens: 40, outputTokens: 8 }, finishReason: "tool_calls" },
      { text: "入口先调用 readConfig 读取配置。", usage: { inputTokens: 60, outputTokens: 12 }, finishReason: "stop" }
    ];
    const calls: LlmCompletionInput[] = [];
    let index = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted-v1",
      complete: async (input) => {
        calls.push(input);
        return script[index++];
      }
    };
    const result = await respondWithProvider(createSession("repo", scope.ref), scope, "入口的输入是什么？", provider, undefined, repository);
    expect(result.assistant.content).toContain("readConfig");
    expect(result.fileReads?.map((read) => read.path)).toEqual(["src/main.ts"]);
    // 用量是工具循环各趟累计的那一份，不是最后一趟的
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    // 轮数按「工具轮」计：一次 read_file 往返算 1 轮（journal 的 loop_round.tool_rounds 就是它）
    expect(result.toolRounds).toBe(1);
    expect(calls[0].tools?.[0]?.name).toBe("read_file");
    expect(calls[0].system).toContain("read_file 只能读仓库内的源码与配置");
    expect(calls[1].messages?.[0].content).toContain("当前作用域: 文件 src/main.ts");
    expect(calls[1].messages?.[0].content).toContain("入口的输入是什么？");
    expect(calls[1].messages?.some((message) => message.role === "tool")).toBe(true);
  });

  it("没有仓库路径时不提供 read_file（工具读不到文件就不给）", async () => {
    let sawTools = true;
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { sawTools = Boolean(input.tools); return { text: "好" }; } };
    await respondWithProvider(createSession("repo", scope.ref), scope, "继续", provider);
    expect(sawTools).toBe(false);
  });

  it("把调用关系与同文件符号位置注入问答上下文", async () => {
    let prompt = "";
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { prompt = `${input.system}\n${input.user}`; return { text: "好" }; } };
    const analysis = {
      graph: {
        imports: {},
        calls: [{ callerPath: "src/boot.ts", callerSymbol: "symbol:src/boot.ts:main:1", calleePath: "src/main.ts", calleeSymbol: "symbol:src/main.ts:main:1", line: 3 }],
        symbols: [
          { id: "symbol:src/boot.ts:main:1", name: "main", kind: "function", path: "src/boot.ts", line: 1, endLine: 5, parameters: [], language: "typescript" },
          { id: "symbol:src/main.ts:main:1", name: "main", kind: "function", path: "src/main.ts", line: 1, endLine: 3, parameters: [], language: "typescript" }
        ],
        entrypoints: [],
        semanticBackend: "static",
        lspStatus: []
      },
      implementations: [],
      versionStamp: "v1",
      repositoryId: "repo",
      generatedAt: new Date().toISOString()
    } as unknown as RepositoryAnalysis;
    await respondWithProvider(createSession("repo", scope.ref), scope, "它被谁调用？", provider, undefined, undefined, { analysis, index });
    expect(prompt).toContain("调用关系（src/main.ts）");
    expect(prompt).toContain("调用它的：src/boot.ts:main");
    expect(prompt).toContain("同文件符号位置：main（function）:1-3");
  });

  it("过程事件按真实顺序回报「思考 → 读文件 → 再思考」（GUI 的过程提示来源，deciding 已随状态机撤掉）", async () => {
    const repository = fixtureRepository();
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "src/main.ts" }) }], finishReason: "tool_calls" },
      { text: "入口先调用 readConfig 读取配置。", finishReason: "stop" }
    ];
    let index = 0;
    const provider: LlmProvider = { name: "scripted", modelVersion: "scripted-v1", complete: async () => script[index++] };
    const progress: TeachingProgress[] = [];
    await respondWithProvider(createSession("repo", scope.ref), scope, "入口的输入是什么？", provider, undefined, repository, { onProgress: (event) => progress.push(event) });
    expect(progress).toEqual([
      { stage: "thinking", round: 1 },
      { stage: "reading", path: "src/main.ts" },
      { stage: "thinking", round: 2 }
    ]);
  });
});
