/** 技能包结构校验 CLI：默认校验用户目录，--source 校验出厂目录；遍历全部技能。 */
import { bundledSkillSource, listSkills, skillDirectories } from "../../src/adapter/outbound/integrations/skills.js";
import { checkSkillSet } from "../../src/exercises/skill-check.js";
import { fileReaderAt } from "./read-at.js";

const root = process.argv.includes("--source") ? bundledSkillSource() : skillDirectories()[0];
if (!root) {
  console.error("找不到技能目录");
  process.exit(1);
}
const loaded = listSkills([root]);
const report = checkSkillSet(fileReaderAt(root), loaded.skills.map((skill) => skill.name), loaded.skipped);
for (const item of report.results) {
  const label = `${item.name}${item.strict ? "（严格）" : ""}`;
  for (const error of item.result.errors) console.error(`错误  ${label}  ${error}`);
  for (const warning of item.result.warnings) console.warn(`警告  ${label}  ${warning}`);
  if (!item.result.errors.length) console.log(`通过  ${label}`);
}
for (const entry of report.skipped) console.error(`错误  ${entry.dir}  未被装载：${entry.reason}`);
const warnings = report.results.reduce((total, item) => total + item.result.warnings.length, 0);
console.log(`共 ${report.results.length} 份技能、${report.errorCount} 条错误、${warnings} 条警告。`);
if (report.errorCount) process.exit(1);
