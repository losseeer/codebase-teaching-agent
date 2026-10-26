import { describe, expect, it } from "vitest";
import { foldProgress } from "./progressLines";

/**
  过程提示的累积口径。为什么要有这一份：读文件与检索都在本机几十毫秒内完成，
  单行覆盖式的提示下一帧就被「正在思考（第 N 轮）」盖掉，一整轮肉眼只剩 thinking——
  那一格该说的是「它做过什么」，不是「它在等」。
*/
describe("foldProgress（过程提示逐行累积）", () => {
  it("一行一件事，按到达顺序排，最新在末尾", () => {
    let lines: string[] = [];
    lines = foldProgress(lines, "正在检索代码：限流 …");
    lines = foldProgress(lines, "正在读取 src/main.ts …");
    expect(lines).toEqual(["正在检索代码：限流 …", "正在读取 src/main.ts …"]);
  });

  it("同一件事重复做折成计数，不把列表刷成流水账", () => {
    let lines = foldProgress([], "正在读取 src/main.ts …");
    lines = foldProgress(lines, "正在读取 src/main.ts …");
    lines = foldProgress(lines, "正在读取 src/main.ts …");
    expect(lines).toEqual(["正在读取 src/main.ts … ×3"]);
  });

  it("只留最近 6 行：长回合的过程提示不该把对话顶出屏", () => {
    let lines: string[] = [];
    for (let index = 1; index <= 9; index += 1) lines = foldProgress(lines, `正在思考（第 ${index} 轮）…`);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("正在思考（第 9 轮）…");
    expect(lines[0]).toBe("正在思考（第 4 轮）…");
  });

  it("计数折在原来那一行，不因为计数变了就多出一行", () => {
    let lines = foldProgress(["正在思考（第 1 轮）…"], "正在读取 a.ts …");
    lines = foldProgress(lines, "正在读取 a.ts …");
    expect(lines).toEqual(["正在思考（第 1 轮）…", "正在读取 a.ts … ×2"]);
  });
});
