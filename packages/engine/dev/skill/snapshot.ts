/** 记录技能当前状态为一版（用户手改后用）；无变化时不追加。 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { skillDirectories } from "../../src/adapter/outbound/integrations/skills.js";
import { ensureCurrentVersion, readSkillVersions } from "../../src/adapter/outbound/integrations/skill-versions.js";

const dir = join(skillDirectories()[0], "exercise-code-concepts");
if (!existsSync(dir)) {
  console.error("用户目录没有 exercise-code-concepts：先安装或同步一次技能。");
  process.exit(1);
}
const before = readSkillVersions(dir).length;
const version = ensureCurrentVersion(dir, { reason: "手动记录当前状态" });
if (readSkillVersions(dir).length === before && before > 0) {
  console.log(`无变化，当前 v${version.version}（${version.source}，${version.fingerprint}）。`);
} else {
  console.log(`已记录 v${version.version}（${version.source}，变更 ${version.changed.join(" / ") || "无"}）。`);
}
