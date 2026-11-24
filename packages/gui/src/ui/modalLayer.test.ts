import { beforeEach, describe, expect, it } from "vitest";

import { closeTopLayer, pushLayer, resetLayers } from "./modalLayer";

describe("弹层栈", () => {
  beforeEach(() => {
    resetLayers();
  });

  it("Esc 只关最后打开的那层，父层不受牵连", () => {
    const closed: string[] = [];
    pushLayer(() => closed.push("父弹窗"));
    pushLayer(() => closed.push("确认框"));
    closeTopLayer();
    expect(closed).toEqual(["确认框"]);
    closeTopLayer();
    expect(closed, "确认框关掉后，第二次 Esc 才轮到父弹窗").toEqual(["确认框", "父弹窗"]);
  });

  it("上层卸载后弹层栈回落，Esc 交回父层", () => {
    const closed: string[] = [];
    pushLayer(() => closed.push("父弹窗"));
    const pop = pushLayer(() => closed.push("下拉菜单"));
    pop();
    closeTopLayer();
    expect(closed).toEqual(["父弹窗"]);
  });

  it("栈空时 Esc 什么都不关", () => {
    expect(closeTopLayer()).toBe(false);
    const pop = pushLayer(() => undefined);
    pop();
    expect(closeTopLayer()).toBe(false);
  });
});
