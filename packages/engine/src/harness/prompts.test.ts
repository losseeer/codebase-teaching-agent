import { describe, expect, it } from "vitest";
import { styleBrief } from "./prompts.js";

/**
  语言风格滑块 0~100 必须在提示词层面真的有区别。
  三档时代（≤33 / 34-66 / ≥67）只有 3 种提示词，滑块在档内拖动毫无效果——
  这组断言就是「滑块奏效」的回归防线。
  */
describe("styleBrief 的渐进档位", () => {
  it("0~100 至少产生 8 种不同的风格指令", () => {
    const briefs = new Set<string>();
    for (let style = 0; style <= 100; style += 1) briefs.add(styleBrief(style));
    expect(briefs.size).toBeGreaterThanOrEqual(8);
  });

  it("跨过每个生效阈值指令都会变（阈值两侧不同）", () => {
    // 通俗侧 at 的语义是 `level >= at` 生效 → 边界落在 at-1 / at；严肃侧是 `level <= at` 生效 → 边界落在 at / at+1
    for (const at of [40, 55, 70, 85]) expect(styleBrief(at)).not.toBe(styleBrief(at - 1));
    for (const at of [15, 30, 45, 60]) expect(styleBrief(at)).not.toBe(styleBrief(at + 1));
    // 三档基调的边界（33/34 与 66/67）
    expect(styleBrief(34)).not.toBe(styleBrief(33));
    expect(styleBrief(67)).not.toBe(styleBrief(66));
  });

  it("style 越大通俗要求越多、严谨要求越少（两条曲线各自单调）", () => {
    const plainMarkers = ["具体例子", "生活类比", "每句只含一个信息点", "先用一句话解释"];
    const rigorousMarkers = ["长句与并列结构", "直接证据、间接线索", "精确的工程术语", "文件:行号"];
    const count = (style: number, markers: string[]): number => markers.filter((marker) => styleBrief(style).includes(marker)).length;
    const rising = [30, 40, 55, 70, 85, 100];
    const plainCounts = rising.map((style) => count(style, plainMarkers));
    expect(plainCounts).toEqual([...plainCounts].sort((a, b) => a - b));
    expect(plainCounts.at(-1)).toBe(plainMarkers.length);
    const rigorousCounts = rising.map((style) => count(style, rigorousMarkers));
    expect(rigorousCounts).toEqual([...rigorousCounts].sort((a, b) => b - a));
    expect(rigorousCounts.at(-1)).toBe(0);
  });

  it("三档基调仍由 styleBand 决定（0 严肃 / 50 中性 / 100 通俗）", () => {
    expect(styleBrief(0)).toContain("工程评审式严谨风格");
    expect(styleBrief(33)).toContain("工程评审式严谨风格");
    expect(styleBrief(50)).toContain("中性风格");
    expect(styleBrief(67)).toContain("通俗讲解风格");
    expect(styleBrief(100)).toContain("通俗讲解风格");
  });

  it("越界值先被夹取再分档（不产生第四种基调）", () => {
    expect(styleBrief(-20)).toBe(styleBrief(0));
    expect(styleBrief(999)).toBe(styleBrief(100));
    expect(styleBrief(Number.NaN)).toBe(styleBrief(50));
  });
});
