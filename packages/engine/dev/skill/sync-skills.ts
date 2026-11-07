/**
  同步出厂技能到用户技能目录（dev 用）。

  **覆盖逻辑只有一份**：engine 的 `restoreBundledSkills()`。界面上那个「恢复初始技能」按钮
  走的是同一个函数，这里只是多一层「先看差异、确认再动」的报告。两个入口的行为永远一致。

  设计约束：出厂技能（packages/engine/skills）只读；出厂在首次启动时把技能 copy 到用户目录，
  之后用户可以自由覆盖那份副本，引擎不自动回灌 —— 所以「出厂改了怎么生效」只能是一个显式动作。

  用法：
    tsx dev/skill/sync-skills.ts            # 只报告差异，不动文件
    tsx dev/skill/sync-skills.ts --force    # 真同步：覆盖出厂技能的副本（用户自建技能不动）
*/
import { diffBundledSkills, restoreBundledSkills } from "../../src/adapter/outbound/integrations/skills.js";

const force = process.argv.includes("--force");
const diff = diffBundledSkills();

if (!diff.entries.length && !diff.missing.length) {
  console.log("出厂技能与用户目录已经一致。");
  process.exit(0);
}

for (const entry of diff.entries) {
  console.log(`更新  ${entry.skill}`);
  for (const name of entry.differs) console.log(`  ~ ${name}`);
  for (const name of entry.extra) console.log(`  + 仅用户目录有：${name}（同步不会删它）`);
}
for (const name of diff.missing) console.log(`新增  ${name}`);
console.log(`\n共 ${diff.entries.length + diff.missing.length} 份技能有差异，涉及 ${diff.files} 个文件。`);

if (!force) {
  console.log("加 --force 真同步。");
  process.exit(0);
}

const result = restoreBundledSkills();
console.log(`已恢复 ${result.restored.length} 份出厂技能（覆盖 ${result.files} 个文件）。`);
console.log("注意：SKILL.md 里的「当前策略」也在出厂文件里，会一并恢复成出厂默认。");
