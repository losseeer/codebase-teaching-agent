/** [DEV ONLY] 分段产出的形状校验、开关与「三段都必须带语言形状规范」这条硬要求。 */
import { afterEach, describe, expect, it } from "vitest";
import { TEST_CONTRACT } from "./code-generate.js";
import { codeSystem, parseCode, parsePlan, promptSystem, segmentedExerciseEnabled, testsSystem } from "./code-generate-segmented.js";

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

  it("题面要求三节齐全，且说明不要写「相关文件」小节", () => {
    const system = promptSystem("patch_edit");
    for (const section of ["## 问题描述", "## 示例", "## 注意事项"]) expect(system).toContain(section);
    expect(system).toContain("不要写「相关文件");
  });

  it("段 2 与段 3 的 system 各自只带一种语言（语言在段 1 定了）", () => {
    expect(codeSystem("patch_edit", "python")).not.toContain(TEST_CONTRACT.go);
  });
});

describe("代码段的取材锚点（界面的「相关文件」靠它）", () => {
  it("system 里要求模型声明 anchors", () => {
    expect(codeSystem("patch_edit", "python")).toContain("anchors");
  });

  it("模型给了就照收；不合法的条目丢掉而不是整段作废", () => {
    const parsed = parseCode({
      given: [{ path: "a.py", contents: "x" }],
      solution: [{ path: "a.py", contents: "y" }],
      anchors: [{ path: "a.py", line: 3, endLine: 9, why: "取用了判定顺序" }, { path: "", line: 1 }, { line: 2 }]
    });
    expect(parsed.anchors).toEqual([{ path: "a.py", line: 3, endLine: 9, why: "取用了判定顺序" }]);
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

describe("段 1 的语言白名单", () => {
  const valid = {
    title: "定稿题",
    prompt: "## 问题描述\n…\n## 示例\n…\n## 注意事项\n…",
    targets: ["src/A.java"]
  };
  it("四种沙箱语言放行，越界语言在段 1 就抛形状错（PR #15 回归）", () => {
    for (const language of ["typescript", "python", "java", "go"]) {
      expect(parsePlan({ ...valid, language }).language).toBe(language);
    }
    // 大小写不符、别名、误报都会让段 2/3 按退化提示词各烧一次付费调用，必须在段 1 拦下
    expect(() => parsePlan({ ...valid, language: "TypeScript" })).toThrow(/语言不在沙箱支持范围内：TypeScript/);
    expect(() => parsePlan({ ...valid, language: "c++" })).toThrow(/语言不在沙箱支持范围内/);
  });
});
