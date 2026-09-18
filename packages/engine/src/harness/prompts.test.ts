import { describe, expect, it } from "vitest";
import { styleBrief } from "./prompts.js";

/**
  语言风格是**离散三档**（通俗 100 / 普通 50 / 严肃 0，GUI 三选一、learner 推荐同）。
  0~100 的其他取值按 styleBand 归到最近一档——所以全值域只允许出现 3 种提示词，
  这组断言守的就是「不会因为怪值冒出第四种风格」。
  */
describe("styleBrief 的三档风格", () => {
  it("全值域只产生 3 种风格指令，且三档互不相同", () => {
    const briefs = new Set<string>();
    for (let style = 0; style <= 100; style += 1) briefs.add(styleBrief(style));
    expect(briefs.size).toBe(3);
    expect(styleBrief(0)).not.toBe(styleBrief(50));
    expect(styleBrief(50)).not.toBe(styleBrief(100));
  });

  it("三档基调由 styleBand 决定（0 严肃 / 50 普通 / 100 通俗，边界值归属一致）", () => {
    expect(styleBrief(0)).toBe(styleBrief(33));
    expect(styleBrief(34)).toBe(styleBrief(50));
    expect(styleBrief(66)).toBe(styleBrief(50));
    expect(styleBrief(67)).toBe(styleBrief(100));
    expect(styleBrief(0)).toContain("工程评审式严谨风格");
    expect(styleBrief(50)).toContain("普通风格");
    expect(styleBrief(100)).toContain("通俗讲解风格");
  });

  it("通俗档允许类比举例（不再要求给类比贴标注），并保留术语解释要求", () => {
    const plain = styleBrief(100);
    expect(plain).toContain("类比");
    expect(plain).not.toContain("必须明确标注");
    expect(plain).toContain("先用一句话解释");
  });

  it("严肃档强调专业严谨，并明确不用类比", () => {
    const rigorous = styleBrief(0);
    expect(rigorous).toContain("精确的工程术语");
    expect(rigorous).toContain("直接证据、间接线索与推测");
    expect(rigorous).toContain("不用类比");
  });

  it("越界值先被夹取再分档（不产生第四种基调）", () => {
    expect(styleBrief(-20)).toBe(styleBrief(0));
    expect(styleBrief(999)).toBe(styleBrief(100));
    expect(styleBrief(Number.NaN)).toBe(styleBrief(50));
  });
});
