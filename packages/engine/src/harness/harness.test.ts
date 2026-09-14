import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CourseNode } from "@codebase-tutor/shared";
import { createSession, respondWithProvider } from "./harness.js";
import type { LlmProvider } from "../llm/provider.js";

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
});
