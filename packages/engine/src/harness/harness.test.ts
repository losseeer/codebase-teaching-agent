import { describe, expect, it } from "vitest";
import type { CourseNode } from "@codebase-tutor/shared";
import { createSession, respondWithProvider } from "./harness.js";
import type { LlmProvider } from "../llm/provider.js";

const node: CourseNode = { id: "unit", title: "入口", summary: "入口读取配置。", kind: "workflow", anchors: [{ path: "src/main.ts", line: 1, label: "入口" }], children: [] };

describe("provider-backed teaching harness", () => {
  it("injects bounded context and preserves the state-machine action", async () => {
    let prompt = "";
    const provider: LlmProvider = { name: "fake", modelVersion: "fake-v1", complete: async (input) => { prompt = `${input.system}\n${input.user}`; return { text: "请指出入口读取的配置。", usage: { inputTokens: 20, outputTokens: 7 } }; } };
    const result = await respondWithProvider(createSession("repo", "unit"), node, "我不清楚", provider, { sampleCompleteness: 1, hintDepth: 2, stylePlainness: 1, mastered: true, transition: "fade", reason: "掌握后减少样例。" });
    expect(result.event).toBe("hint");
    expect(result.hintDepth).toBe(1);
    expect(result.assistant.content).toBe("请指出入口读取的配置。");
    expect(result.provider).toBe("fake");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 7 });
    expect(prompt).toContain("课程节点: 入口");
    expect(prompt).toContain("当前阶段: orient；动作: step_down");
    expect(prompt).toContain("当前辅助等级（样例完整度/提示深度/通俗化表达）: 1/2/1");
  });

  it("falls back to deterministic teaching when the provider fails", async () => {
    const provider: LlmProvider = { name: "broken", modelVersion: "broken-v1", complete: async () => { throw new Error("offline"); } };
    const result = await respondWithProvider(createSession("repo", "unit"), node, "不知道", provider);
    expect(result.assistant.content).toContain("提示：先只看 src/main.ts:1");
    expect(result.provider).toBe("local-heuristic-v1");
  });
});
