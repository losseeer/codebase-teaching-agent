import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkSkillPackage } from "./skill-check.js";

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
});
