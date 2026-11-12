/** 技能包结构校验 CLI：默认校验用户目录，--source 校验出厂目录。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bundledSkillSource, skillDirectories } from "../../src/adapter/outbound/integrations/skills.js";
import { checkSkillPackage } from "../../src/exercises/skill-check.js";

const root = process.argv.includes("--source") ? bundledSkillSource() : skillDirectories()[0];
if (!root) {
  console.error("找不到技能目录");
  process.exit(1);
}
const bodyOf = (name: string, file = "SKILL.md"): string | undefined => {
  try {
    return readFileSync(join(root, name, file), "utf8");
  } catch {
    return undefined;
  }
};
const result = checkSkillPackage(bodyOf);
for (const error of result.errors) console.error(`错误  ${error}`);
for (const warning of result.warnings) console.warn(`警告  ${warning}`);
if (result.errors.length) process.exit(1);
console.log(`技能结构校验通过（${result.warnings.length} 条警告）。`);
