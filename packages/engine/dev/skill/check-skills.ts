/** 技能包结构校验 CLI：默认校验用户目录，--source 校验出厂目录。 */
import { bundledSkillSource, skillDirectories } from "../../src/adapter/outbound/integrations/skills.js";
import { checkSkillPackage } from "../../src/exercises/skill-check.js";
import { fileReaderAt } from "./read-at.js";

const root = process.argv.includes("--source") ? bundledSkillSource() : skillDirectories()[0];
if (!root) {
  console.error("找不到技能目录");
  process.exit(1);
}
const result = checkSkillPackage(fileReaderAt(root));
for (const error of result.errors) console.error(`错误  ${error}`);
for (const warning of result.warnings) console.warn(`警告  ${warning}`);
if (result.errors.length) process.exit(1);
console.log(`技能结构校验通过（${result.warnings.length} 条警告）。`);
