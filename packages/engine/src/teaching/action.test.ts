import { describe, expect, it } from "vitest";
import { ACTION_CONTRACTS, isActionAllowed, proposeAction } from "./action.js";
import { initialTeachingState } from "./state-machine.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";

const state = initialTeachingState();

function fakeProvider(text: string, usage?: LlmUsage, fail = false): LlmProvider & { calls: () => number } {
  let count = 0;
  return {
    name: "fake-proposer",
    modelVersion: "fake-proposer-v1",
    calls: () => count,
    complete: async (input) => {
      count += 1;
      if (fail) throw new Error("offline");
      void input;
      return { text, ...(usage ? { usage } : {}) };
    }
  };
}

describe("action guardrails", () => {
  it("veto give_answer before the first hint, allow it once a hint was given", () => {
    expect(isActionAllowed(state, "give_answer")).toBe(false);
    const hinted = { ...state, fallbackCount: 1 };
    expect(isActionAllowed(hinted, "give_answer")).toBe(true);
  });

  it("gates confirm to the verify stage", () => {
    expect(isActionAllowed(state, "confirm")).toBe(false);
    const verify = { ...state, stage: "verify" as const };
    expect(isActionAllowed(verify, "confirm")).toBe(true);
  });

  it("always allows advance and step_down", () => {
    expect(isActionAllowed(state, "advance")).toBe(true);
    expect(isActionAllowed(state, "step_down")).toBe(true);
  });
});

describe("LLM action proposal", () => {
  it("parses a bare action label", async () => {
    const provider = fakeProvider("give_answer", { inputTokens: 21, outputTokens: 2 });
    const result = await proposeAction(state, "直接告诉我吧", [], "课程节点: 入口", provider);
    expect(result.action).toBe("give_answer");
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 2 });
  });

  it("extracts the action when the model wraps it in extra text", async () => {
    const provider = fakeProvider("我的选择：confirm。");
    const result = await proposeAction({ ...state, stage: "verify" }, "因此我明白了", [], "", provider);
    expect(result.action).toBe("confirm");
  });

  it("returns undefined for an out-of-menu answer, keeping usage for audit", async () => {
    const provider = fakeProvider("我先读一下源码。", { inputTokens: 15, outputTokens: 6 });
    const result = await proposeAction(state, "继续", [], "", provider);
    expect(result.action).toBeUndefined();
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 6 });
  });

  it("returns undefined without usage when the provider throws", async () => {
    const provider = fakeProvider("", undefined, true);
    const result = await proposeAction(state, "继续", [], "", provider);
    expect(result.action).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(provider.calls()).toBe(1);
  });

  it("exposes every menu action with a guardrail note in the prompt contract", () => {
    expect(Object.keys(ACTION_CONTRACTS)).toEqual(["advance", "step_down", "give_answer", "confirm"]);
    expect(ACTION_CONTRACTS.give_answer).toContain("才允许");
    expect(ACTION_CONTRACTS.confirm).toContain("verify");
  });
});
