import { describe, expect, it } from "vitest";
import { initialTeachingState, transition, transitionFromIntent } from "./state-machine.js";

describe("Socratic teaching state machine", () => {
  it("progresses through every teaching stage using learner attempts", () => {
    const orient = initialTeachingState();
    const procedure = transition(orient, "入口读取配置，然后创建服务");
    const concept = transition(procedure.next, "它把配置传给了路由层");
    const verify = transition(concept.next, "因此路由初始化依赖这个步骤");
    const confirmed = transition(verify.next, "我明白了，因为入口负责建立这个依赖");
    expect(procedure.next.stage).toBe("procedure");
    expect(concept.next.stage).toBe("concept");
    expect(verify.next.stage).toBe("verify");
    expect(confirmed.kind).toBe("confirm");
    expect(confirmed.next.stage).toBe("confirmed");
  });

  it("gives a smaller hint once, then trips the answer circuit breaker", () => {
    const first = transition(initialTeachingState(), "不知道");
    const second = transition(first.next, "直接告诉我答案");
    expect(first.kind).toBe("step_down");
    expect(second.kind).toBe("give_answer");
    expect(second.next.stage).toBe("verify");
    expect(second.next.fallbackCount).toBe(2);
  });

  it("resets fallback after a substantive learner attempt", () => {
    const first = transition(initialTeachingState(), "不会");
    const retried = transition(first.next, "它看起来先读取环境变量");
    expect(retried.kind).toBe("advance");
    expect(retried.next.fallbackCount).toBe(0);
  });
});

describe("deterministic intent transitions", () => {
  it("maps needs_help through the fallback ladder", () => {
    const first = transitionFromIntent(initialTeachingState(), "needs_help");
    expect(first.kind).toBe("step_down");
    const second = transitionFromIntent(first.next, "needs_help");
    expect(second.kind).toBe("give_answer");
    expect(second.next.stage).toBe("verify");
  });

  it("gates confirmation to the verify stage only", () => {
    const advance = transitionFromIntent(initialTeachingState(), "confirmation");
    expect(advance.kind).toBe("advance");
    const verify = { stage: "verify" as const, fallbackCount: 0, attempts: 3 };
    const confirmed = transitionFromIntent(verify, "confirmation");
    expect(confirmed.kind).toBe("confirm");
    expect(confirmed.next.stage).toBe("confirmed");
  });

  it("matches the regex transition output for every intent", () => {
    const state = initialTeachingState();
    expect(transitionFromIntent(state, "progress")).toEqual(transition(state, "它先读取配置"));
    expect(transitionFromIntent(state, "needs_help")).toEqual(transition(state, "不知道"));
    const verify = { stage: "verify" as const, fallbackCount: 0, attempts: 3 };
    expect(transitionFromIntent(verify, "confirmation")).toEqual(transition(verify, "因为这个步骤建立了依赖"));
  });
});
