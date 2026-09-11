import { describe, expect, it } from "vitest";
import { initialTeachingState, transition } from "./state-machine.js";

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
