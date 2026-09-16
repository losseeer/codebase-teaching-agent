import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CourseNode, RepositoryAnalysis } from "@codebase-tutor/shared";
import { createSession, respondWithProvider, type TeachingProgress } from "./harness.js";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";

const node: CourseNode = { id: "unit", title: "入口", summary: "入口读取配置。", kind: "workflow", anchors: [{ path: "src/main.ts", line: 1, label: "入口" }], children: [] };

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

describe("provider-backed teaching harness", () => {
  it("injects real source excerpts and the bounded transcript into the prompt", async () => {
    const repository = fixtureRepository();
    let prompt = "";
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { prompt = `${input.system}\n${input.user}`; return { text: "请指出入口读取的配置。", usage: { inputTokens: 20, outputTokens: 7 } }; } };
    const result = await respondWithProvider(createSession("repo", "unit"), node, "我不清楚", provider, { sampleCompleteness: 1, hintDepth: 2, stylePlainness: 1, mastered: true, transition: "fade", reason: "掌握后减少样例。" }, repository);
    expect(result.event).toBe("hint");
    expect(result.hintDepth).toBe(1);
    expect(result.assistant.content).toBe("请指出入口读取的配置。");
    expect(result.provider).toBe("fake");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 7 });
    expect(prompt).toContain("课程节点: 入口");
    expect(prompt).toContain("src/main.ts:1-3");
    expect(prompt).toContain("1: export const main = () => readConfig();");
    expect(prompt).toContain("当前阶段：orient");
    expect(prompt).toContain("本轮动作=降低脚手架");
    expect(prompt).toContain("通俗化 1/5");

    const second = await respondWithProvider(result.session, node, "还是不明白入口的输入", provider, undefined, repository);
    expect(second.provider).toBe("fake");
    expect(prompt).toContain("学习者: 我不清楚");
    expect(prompt).toContain("导师: 请指出入口读取的配置。");
    expect(prompt).toContain("学习者本轮输入：还是不明白入口的输入");
  });

  it("falls back to deterministic teaching when the provider fails", async () => {
    const provider: LlmProvider = { name: "broken", modelVersion: "broken-v1", complete: async () => { throw new Error("offline"); } };
    const result = await respondWithProvider(createSession("repo", "unit"), node, "不知道", provider);
    expect(result.assistant.content).toContain("提示：先只看 src/main.ts:1");
    expect(result.provider).toBe("local-heuristic-v1");
  });

  it("keeps assembling context when source files are unreadable", async () => {
    let prompt = "";
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { prompt = `${input.system}\n${input.user}`; return { text: "好", usage: { inputTokens: 5, outputTokens: 1 } }; } };
    await respondWithProvider(createSession("repo", "unit"), node, "继续", provider, undefined, join(tmpdir(), "codebase-tutor-harness-missing"));
    expect(prompt).not.toContain("--- src/main.ts:");
    expect(prompt).toContain("课程节点: 入口");
  });

  it("classifies intent with the light provider and sums both calls into the usage", async () => {
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async () => ({ text: "请说明这个变量被谁消费。", usage: { inputTokens: 10, outputTokens: 5 } }) };
    let classifierPrompt = "";
    const classifier: LlmProvider = { name: "fake-light", modelVersion: "fake-light-v1", complete: async (input) => { classifierPrompt = `${input.system}\n${input.user}`; return { text: "needs_help", usage: { inputTokens: 30, outputTokens: 2 } }; } };
    const midway = { ...createSession("repo", "unit"), fallbackCount: 1 };
    const result = await respondWithProvider(midway, node, "这个变量后来还被谁用到了？", provider, undefined, undefined, { classifier });
    expect(result.event).toBe("dependency");
    expect(result.hintDepth).toBe(3);
    expect(result.intentSource).toBe("llm");
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 7 });
    expect(classifierPrompt).toContain("学习者本轮输入：这个变量后来还被谁用到了？");
    expect(classifierPrompt).toContain("教学阶段：orient");
  });

  it("falls back to the regex intent when the classifier output is invalid", async () => {
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async () => ({ text: "请先定位入口。" }) };
    const classifier: LlmProvider = { name: "fake-light", modelVersion: "fake-light-v1", complete: async () => ({ text: "这个问题超出了我的职责范围。" }) };
    const result = await respondWithProvider(createSession("repo", "unit"), node, "这个变量后来还被谁用到了？", provider, undefined, undefined, { classifier });
    expect(result.event).toBe("hint");
    expect(result.session.stage).toBe("procedure");
    expect(result.intentSource).toBe("regex");
  });

  it("accepts a valid action proposal in the restricted loop", async () => {
    // 提议调用（system 含"动作决策器"）返回 step_down；措辞调用返回正文
    const provider: LlmProvider = {
      name: "fake",
      modelVersion: "fake-v1",
      complete: async (input) => input.system.includes("动作决策器")
        ? { text: "step_down", usage: { inputTokens: 25, outputTokens: 2 } }
        : { text: "提示：先只看入口读取的输入。", usage: { inputTokens: 10, outputTokens: 5 } }
    };
    // 正则意图是 progress（会 advance），模型有权选 step_down——这正是动作选择灵活性
    const result = await respondWithProvider(createSession("repo", "unit"), node, "这个函数的返回值是什么类型？", provider, undefined, undefined, { actionLoop: true });
    expect(result.actionSource).toBe("proposed");
    expect(result.proposedAction).toBe("step_down");
    expect(result.action).toBe("step_down");
    expect(result.event).toBe("hint");
    expect(result.hintDepth).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 35, outputTokens: 7 });
    expect(result.intentSource).toBeUndefined();
  });

  it("vetoes an early give_answer and enforces the deterministic decision", async () => {
    const provider: LlmProvider = {
      name: "fake",
      modelVersion: "fake-v1",
      complete: async (input) => input.system.includes("动作决策器")
        ? { text: "give_answer", usage: { inputTokens: 20, outputTokens: 2 } }
        : { text: "解释性措辞。", usage: { inputTokens: 10, outputTokens: 5 } }
    };
    // fallbackCount=0 时模型提 give_answer → 守门否决 → 正则意图 progress → advance
    const result = await respondWithProvider(createSession("repo", "unit"), node, "这个函数的返回值是什么类型？", provider, undefined, undefined, { actionLoop: true });
    expect(result.actionSource).toBe("vetoed");
    expect(result.proposedAction).toBe("give_answer");
    expect(result.action).toBe("advance");
    expect(result.event).toBe("hint");
    expect(result.session.stage).toBe("procedure");
  });

  it("falls back to the deterministic decision when the proposal is unparseable", async () => {
    const provider: LlmProvider = {
      name: "fake",
      modelVersion: "fake-v1",
      complete: async (input) => input.system.includes("动作决策器")
        ? { text: "我需要先看一下源码再决定。", usage: { inputTokens: 15, outputTokens: 6 } }
        : { text: "推进措辞。", usage: { inputTokens: 10, outputTokens: 5 } }
    };
    const result = await respondWithProvider(createSession("repo", "unit"), node, "它先读取配置吗？", provider, undefined, undefined, { actionLoop: true });
    expect(result.actionSource).toBe("deterministic");
    expect(result.proposedAction).toBeUndefined();
    expect(result.action).toBe("advance");
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 11 });
  });

  it("keeps tripping the circuit breaker when the loop proposes give_answer after a hint", async () => {
    const provider: LlmProvider = {
      name: "fake",
      modelVersion: "fake-v1",
      complete: async (input) => input.system.includes("动作决策器")
        ? { text: "give_answer", usage: { inputTokens: 20, outputTokens: 2 } }
        : { text: "答案：入口读取配置。", usage: { inputTokens: 10, outputTokens: 5 } }
    };
    const midway = { ...createSession("repo", "unit"), fallbackCount: 1 };
    const result = await respondWithProvider(midway, node, "直接告诉我吧", provider, undefined, undefined, { actionLoop: true });
    expect(result.actionSource).toBe("proposed");
    expect(result.action).toBe("give_answer");
    expect(result.event).toBe("dependency");
    expect(result.session.stage).toBe("verify");
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
    const result = await respondWithProvider(createSession("repo", "unit"), node, "入口的输入是什么？", provider, undefined, repository);
    expect(result.assistant.content).toContain("readConfig");
    expect(result.fileReads?.map((read) => read.path)).toEqual(["src/main.ts"]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    // 首轮带工具定义，且 system 声明了 read_file 的用法与护栏
    expect(calls[0].tools?.[0]?.name).toBe("read_file");
    expect(calls[0].system).toContain("read_file 只能读仓库内的源码与配置");
    // 第二轮完整携带首轮 user 消息（上下文 + 学习者提问）与 tool 结果
    expect(calls[1].messages?.[0].content).toContain("课程节点: 入口");
    expect(calls[1].messages?.[0].content).toContain("入口的输入是什么？");
    expect(calls[1].messages?.some((message) => message.role === "tool")).toBe(true);
  });

  it("没有仓库路径时不提供 read_file（工具读不到文件就不给）", async () => {
    let sawTools = true;
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { sawTools = Boolean(input.tools); return { text: "好" }; } };
    await respondWithProvider(createSession("repo", "unit"), node, "继续", provider);
    expect(sawTools).toBe(false);
  });

  it("把调用关系与同文件符号位置注入教学上下文", async () => {
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
      quality: {},
      versionStamp: "v1",
      repositoryId: "repo",
      generatedAt: new Date().toISOString()
    } as unknown as RepositoryAnalysis;
    await respondWithProvider(createSession("repo", "unit"), node, "它被谁调用？", provider, undefined, undefined, { analysis });
    expect(prompt).toContain("调用关系（src/main.ts）");
    expect(prompt).toContain("调用它的：src/boot.ts:main");
    expect(prompt).toContain("同文件符号位置：main（function）:1-3");
  });

  it("过程事件按真实顺序回报「判断动作 → 思考 → 读文件 → 再思考」（GUI 的过程提示来源）", async () => {
    const repository = fixtureRepository();
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "src/main.ts" }) }], finishReason: "tool_calls" },
      { text: "入口先调用 readConfig 读取配置。", finishReason: "stop" }
    ];
    let index = 0;
    const provider: LlmProvider = { name: "scripted", modelVersion: "scripted-v1", complete: async () => script[index++] };
    const classifier: LlmProvider = { name: "fake-light", modelVersion: "fake-light-v1", complete: async () => ({ text: "needs_help" }) };

    const progress: TeachingProgress[] = [];
    await respondWithProvider(createSession("repo", "unit"), node, "入口的输入是什么？", provider, undefined, repository, { classifier, onProgress: (event) => progress.push(event) });

    expect(progress).toEqual([
      { stage: "deciding" },
      { stage: "thinking", round: 1 },
      { stage: "reading", path: "src/main.ts" },
      { stage: "thinking", round: 2 }
    ]);
  });
});
