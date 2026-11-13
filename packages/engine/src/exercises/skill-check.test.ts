import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkSkill, checkSkillPackage, checkSkillSet } from "./skill-check.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../skills");
const real = (name: string, file = "SKILL.md"): string | undefined => {
  try {
    return readFileSync(join(ROOT, name, file), "utf8");
  } catch {
    return undefined;
  }
};
const broken = (override: Record<string, string>) => (name: string, file = "SKILL.md"): string | undefined =>
  override[`${name}/${file}`] ?? real(name, file);
const missing = (path: string) => (name: string, file = "SKILL.md"): string | undefined =>
  `${name}/${file}` === path ? undefined : real(name, file);

describe("技能包结构校验", () => {
  it("出厂技能包无错误", () => {
    expect(checkSkillPackage(real).errors).toEqual([]);
  });

  it("frontmatter、考点表、孤儿概念、配置非法各自报错", () => {
    expect(checkSkillPackage(broken({ "exercise-code-concepts/SKILL.md": "# 无 frontmatter\n" })).errors.join()).toContain("frontmatter");
    const onlyMain = (name: string, file = "SKILL.md"): string | undefined =>
      file === "SKILL.md" ? real("exercise-code-concepts") : undefined;
    expect(checkSkillPackage(onlyMain).errors.join()).toContain("考点表");
    const orphan = JSON.stringify({ concepts: { 并发: ["并发"], 孤儿概念: ["孤儿概念"] } });
    expect(checkSkillPackage(broken({ "exercise-code-concepts/concepts.json": orphan })).errors.join()).toContain("孤儿概念");
    expect(checkSkillPackage(broken({ "exercise-code-concepts/config.json": '{"version":1,"exerciseStrategy":"turbo"}' })).errors.join()).toContain("exerciseStrategy");
  });

  it("单份附属文件的章节、表头或文件本身损坏时显式报错", () => {
    const noSection = real("exercise-code-concepts", "ds.md")!.replace("## 能摘出来考的", "## 别的");
    expect(checkSkillPackage(broken({ "exercise-code-concepts/ds.md": noSection })).errors.join()).toContain("ds.md 未解析出考点");
    const noId = real("exercise-code-concepts", "ds.md")!.replace("| id |", "| 编号 |");
    expect(checkSkillPackage(broken({ "exercise-code-concepts/ds.md": noId })).errors.join()).toContain("ds.md 未解析出考点");
    const noPoint = real("exercise-code-concepts", "ds.md")!.replace("| 考点 |", "| 说明 |");
    expect(checkSkillPackage(broken({ "exercise-code-concepts/ds.md": noPoint })).errors.join()).toContain("空「考点」列");
    expect(checkSkillPackage(missing("exercise-code-concepts/go.md")).errors.join()).toContain("附属文件缺失");
    expect(checkSkillPackage(missing("exercise-code-concepts/config.json")).errors.join()).toContain("config.json");
  });
});

describe("全量技能校验", () => {
  it("非出题技能只做基础校验，行数超限记警告", () => {
    const body = `---\nname: diagram-x\ndescription: 测试\n---\n\n${"规则行\n".repeat(45)}`;
    const bodyOf = (name: string, file = "SKILL.md"): string | undefined =>
      name === "diagram-x" && file === "SKILL.md" ? body : undefined;
    const result = checkSkill(bodyOf, { name: "diagram-x" });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join()).toContain("超过 40 行");
  });

  it("checkSkillSet 逐份汇报，被跳过的技能计入错误", () => {
    const report = checkSkillSet(real, ["exercise-code-concepts", "diagram-x"], [{ dir: "broken", reason: "frontmatter 缺 name" }]);
    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.strict).toBe(true);
    expect(report.results[1]?.strict).toBe(false);
    expect(report.results[0]?.result.errors).toEqual([]);
    expect(report.results[1]?.result.errors.join()).toContain("缺失或不可读");
    expect(report.errorCount).toBeGreaterThanOrEqual(2);
  });
});

describe("全量技能校验", () => {
  it("非出题技能只做基础校验，行数超限记警告", () => {
    const body = `---\nname: diagram-x\ndescription: 测试\n---\n\n${"规则行\n".repeat(45)}`;
    const bodyOf = (name: string, file = "SKILL.md"): string | undefined =>
      name === "diagram-x" && file === "SKILL.md" ? body : undefined;
    const result = checkSkill(bodyOf, { name: "diagram-x" });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join()).toContain("超过 40 行");
  });

  it("checkSkillSet 逐份汇报，被跳过的技能计入错误", () => {
    const report = checkSkillSet(real, ["exercise-code-concepts", "diagram-x"], [{ dir: "broken", reason: "frontmatter 缺 name" }]);
    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.strict).toBe(true);
    expect(report.results[1]?.strict).toBe(false);
    expect(report.results[0]?.result.errors).toEqual([]);
    expect(report.results[1]?.result.errors.join()).toContain("缺失或不可读");
    expect(report.errorCount).toBeGreaterThanOrEqual(2);
  });
});
