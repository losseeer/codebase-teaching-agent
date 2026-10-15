import { describe, expect, it } from "vitest";
import { abortTurn, beginTurn, sanitizeTurnId } from "./registry.js";

const TURN_ID = "11111111-2222-4333-8444-555555555555";

describe("sanitizeTurnId", () => {
  it("只接受 8~64 位 URL-safe 串（客户端给的东西不能直接当 map key）", () => {
    expect(sanitizeTurnId(TURN_ID)).toBe(TURN_ID);
    expect(sanitizeTurnId(`  ${TURN_ID}  `)).toBe(TURN_ID);
    expect(sanitizeTurnId("short")).toBeUndefined();
    expect(sanitizeTurnId("../etc/passwd")).toBeUndefined();
    expect(sanitizeTurnId(undefined)).toBeUndefined();
    expect(sanitizeTurnId({ turnId: TURN_ID })).toBeUndefined();
  });
});

describe("在途回合注册表", () => {
  it("beginTurn 给出去中止信号，abortTurn 命中后信号置位并返回场景", () => {
    const handle = beginTurn(TURN_ID, "teach");
    expect(handle.turnId).toBe(TURN_ID);
    expect(handle.signal?.aborted).toBe(false);
    const stopped = abortTurn(TURN_ID);
    expect(stopped).toMatchObject({ aborted: true, scene: "teach" });
    expect(handle.signal?.aborted).toBe(true);
    handle.dispose();
  });

  it("dispose 之后不再可中止（回合已结束，停止请求该回 404）", () => {
    const handle = beginTurn(TURN_ID, "map_chat");
    handle.dispose();
    expect(abortTurn(TURN_ID).aborted).toBe(false);
    expect(handle.signal?.aborted).toBe(false);
  });

  it("重复 turnId：后一个不登记也不覆盖前一个，前一个仍可中止", () => {
    const first = beginTurn(TURN_ID, "practice_chat");
    const second = beginTurn(TURN_ID, "practice_chat");
    expect(second.signal).toBeUndefined();
    second.dispose(); // 绝不能把 first 的登记摘掉
    expect(abortTurn(TURN_ID)).toMatchObject({ aborted: true, scene: "practice_chat" });
    expect(first.signal?.aborted).toBe(true);
    first.dispose();
  });

  it("归属：A 发起的回合 B 停不了（共享部署下这是一条能掐掉别人 token 的动作）", () => {
    const handle = beginTurn(TURN_ID, "teach", "甲的 key");
    expect(abortTurn(TURN_ID, "乙的 key")).toEqual({ aborted: false, reason: "forbidden", scene: "teach" });
    // 被别人试过不等于中止：这一轮还在跑，登记也还在
    expect(handle.signal?.aborted).toBe(false);
    expect(abortTurn(TURN_ID, "甲的 key")).toMatchObject({ aborted: true, scene: "teach" });
    expect(handle.signal?.aborted).toBe(true);
    handle.dispose();
  });

  it("登记时没有身份就不判归属（后台任务那条路），否则「停止生成」会莫名失效", () => {
    const handle = beginTurn(TURN_ID, "map_chat");
    expect(abortTurn(TURN_ID, "随便谁")).toMatchObject({ aborted: true, scene: "map_chat" });
    handle.dispose();
  });

  it("没传 turnId 的调用照常执行，只是不可中止", () => {
    const handle = beginTurn(undefined, "teach");
    expect(handle.signal).toBeUndefined();
    expect(handle.turnId).toBeUndefined();
    expect(() => handle.dispose()).not.toThrow();
  });
});
