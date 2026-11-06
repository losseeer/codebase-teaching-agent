/** [DEV ONLY] 分段产出的形状校验与「该重出哪一段」的判断。 */
import { describe, expect, it } from "vitest";
import type { HarnessRun } from "../../src/exercises/code-generate.js";

import { parseCode, parsePlan, parseTests, repairSegmentOf } from "./segmented-generate.js";

describe("分段形状校验", () => {
  it("题面段缺标题或目标文件就拒", () => {
    expect(() => parsePlan({ title: "题", prompt: "面", language: "go", targets: [] })).toThrow(/targets/);
    expect(() => parsePlan({ title: "", prompt: "面", language: "go", targets: ["a.go"] })).toThrow(/title/);
  });

  it("代码段两份文件的 path 集合必须一致", () => {
    expect(() => parseCode({ given: [{ path: "a.go", contents: "x" }], solution: [{ path: "b.go", contents: "y" }] })).toThrow(/path 集合/);
    const ok = parseCode({ given: [{ path: "a.go", contents: "x" }], solution: [{ path: "a.go", contents: "y" }] });
    expect(ok.given[0]!.contents).toBe("x");
  });

  it("测试段缺 entry 就拒", () => {
    expect(() => parseTests({ hidden: [{ path: "a_test.go", contents: "x" }] })).toThrow(/entry/);
  });
});

describe("repairSegmentOf", () => {
  const run = (label: "solution" | "given", failed: number): HarnessRun =>
    ({ label, verdict: { passed: 1, failed }, exitCode: 1, timedOut: false, ran: true });

  it("参考解自己没全过 → 重出代码段", () => {
    expect(repairSegmentOf([run("solution", 2), run("given", 1)])).toBe("code");
  });

  it("参考解全过但给定件也全过 → 重出测试段", () => {
    expect(repairSegmentOf([run("solution", 0), run("given", 0)])).toBe("tests");
  });

  it("参考解全过、给定件挂 → 测试段本身没错，但保险起见重出测试", () => {
    expect(repairSegmentOf([run("solution", 0), run("given", 1)])).toBe("tests");
  });
});

describe("三段的 system 必须带着该语言的测试形状", () => {
  it("段 1/2/3 都含 TEST_CONTRACT 的原文：缺了它模型会写裸 assert，判分拿不到结论行", async () => {
    const { TEST_CONTRACT } = await import("../../src/exercises/code-generate.js");
    const { codeSystem, promptSystem, testsSystem } = await import("./segmented-generate.js");
    expect(promptSystem("patch_edit"), "段 1 语言由它声明，四种都要带").toContain(TEST_CONTRACT.python);
    expect(codeSystem("patch_edit", "python")).toContain(TEST_CONTRACT.python);
    expect(testsSystem("patch_edit", "python")).toContain(TEST_CONTRACT.python);
    expect(testsSystem("patch_edit", "go")).toContain(TEST_CONTRACT.go);
    // 形状规范里那句「结论行」是判分唯一认的东西，不能被改写掉
    expect(testsSystem("patch_edit", "python")).toContain("TESTS {pass} {fail}");
  });
});
