import { describe, expect, it } from "vitest";
import { foldProgress, interruptText, progressText } from "./progressLines";

/**
  过程提示的累积口径。为什么要有这一份：读文件与检索都在本机几十毫秒内完成，
  单行覆盖式的提示下一帧就被「正在思考」盖掉，一整轮肉眼只剩 thinking——
  那一格该说的是「它做过什么、现在在做哪一件」，不是「它在等」，也不是账单。
*/
describe("foldProgress（过程提示逐行累积）", () => {
  it("一行一件事，按到达顺序排，最新在末尾", () => {
    let lines: string[] = [];
    lines = foldProgress(lines, "正在检索代码：限流 …");
    lines = foldProgress(lines, "正在读取 src/main.ts …");
    expect(lines).toEqual(["正在检索代码：限流 …", "正在读取 src/main.ts …"]);
  });

  it("同一件事只留一行：连着几轮思考对用户是同一件事", () => {
    let lines: string[] = [];
    for (let round = 1; round <= 4; round += 1) lines = foldProgress(lines, progressText({ type: "thinking" }));
    expect(lines).toEqual(["正在思考…"]);
  });

  it("报过 ×N 就是自造指标：穿插过别的再回来，也只是把它挪回最后一行", () => {
    let lines = foldProgress([], "正在读取 a.ts …");
    lines = foldProgress(lines, "正在检索代码：限流 …");
    lines = foldProgress(lines, "正在读取 a.ts …");
    expect(lines).toEqual(["正在检索代码：限流 …", "正在读取 a.ts …"]);
  });

  it("只留最近 6 行：长回合的过程提示不该把对话顶出屏", () => {
    let lines: string[] = [];
    for (let index = 1; index <= 9; index += 1) lines = foldProgress(lines, `正在读取 f${index}.ts …`);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("正在读取 f9.ts …");
    expect(lines[0]).toBe("正在读取 f4.ts …");
  });

  it("两种中断两句话：预算用完不能写成「耗时过长」", () => {
    expect(interruptText("budget")).toBe("本月预算已用完，已中断");
    expect(interruptText("rounds")).toBe("执行耗时过长，已中断");
  });
});
