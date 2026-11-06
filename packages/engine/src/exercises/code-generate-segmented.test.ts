/** [DEV ONLY] 分段产出的形状校验、开关与「三段都必须带语言形状规范」这条硬要求。 */
import { afterEach, describe, expect, it } from "vitest";
import { TEST_CONTRACT } from "./code-generate.js";
import { codeSystem, promptSystem, segmentedExerciseEnabled, testsSystem } from "./code-generate-segmented.js";

describe("分段产出的 system 必须带着该语言的测试形状", () => {
  it("三段都含 TEST_CONTRACT 的原文：缺了它模型会写裸 assert，判分拿不到结论行", () => {
    expect(promptSystem("patch_edit"), "段 1 语言由它声明，四种都要带").toContain(TEST_CONTRACT.python);
    expect(promptSystem("patch_edit")).toContain(TEST_CONTRACT.go);
    expect(codeSystem("patch_edit", "python")).toContain(TEST_CONTRACT.python);
    expect(testsSystem("patch_edit", "python")).toContain(TEST_CONTRACT.python);
    expect(testsSystem("patch_edit", "go")).toContain(TEST_CONTRACT.go);
    // 判分只认最后那行结论，规范里的它不能被改写掉
    expect(testsSystem("patch_edit", "python")).toContain("TESTS {pass} {fail}");
  });

  it("段 2 与段 3 的 system 各自只带一种语言（语言在段 1 定了）", () => {
    expect(codeSystem("patch_edit", "python")).not.toContain(TEST_CONTRACT.go);
  });
});

describe("segmentedExerciseEnabled", () => {
  const original = process.env.TUTOR_EXERCISE_SEGMENTED;
  afterEach(() => {
    if (original === undefined) delete process.env.TUTOR_EXERCISE_SEGMENTED;
    else process.env.TUTOR_EXERCISE_SEGMENTED = original;
  });

  it("默认开着；显式关掉才回到整份产出", () => {
    delete process.env.TUTOR_EXERCISE_SEGMENTED;
    expect(segmentedExerciseEnabled()).toBe(true);
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      process.env.TUTOR_EXERCISE_SEGMENTED = off;
      expect(segmentedExerciseEnabled(), off).toBe(false);
    }
    process.env.TUTOR_EXERCISE_SEGMENTED = "1";
    expect(segmentedExerciseEnabled()).toBe(true);
  });
});
