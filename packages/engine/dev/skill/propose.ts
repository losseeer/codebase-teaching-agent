/** 技能变更提议：校验候选包并与用户目录比对；--apply 才写入，config.json 保持用户所有。 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { skillDirectories } from "../../src/adapter/outbound/integrations/skills.js";
import { checkSkillPackage } from "../../src/exercises/skill-check.js";
import { appendVersion, ensureCurrentVersion } from "../../src/adapter/outbound/integrations/skill-versions.js";
import { listFilesUnder } from "../../src/adapter/outbound/integrations/file-walk.js";
import { fileReaderAt } from "./read-at.js";

const SKILL = "exercise-code-concepts";
const candidate = process.argv[2];
const apply = process.argv.includes("--apply");
if (!candidate) {
  console.error("用法：tsx dev/skill/propose.ts <候选根目录> [--apply]");
  process.exit(1);
}

const target = join(skillDirectories()[0], SKILL);
if (!existsSync(target)) {
  console.error(`用户目录没有 ${SKILL}：先安装或同步一次技能。`);
  process.exit(1);
}
const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const check = checkSkillPackage(fileReaderAt(candidate));
for (const error of check.errors) console.error(`错误  ${error}`);
for (const warning of check.warnings) console.warn(`警告  ${warning}`);
if (check.errors.length) {
  console.error("校验未通过，未做任何写入。");
  process.exit(1);
}

const packageFiles = listFilesUnder(join(candidate, SKILL));
const currentFiles = listFilesUnder(target).filter((name) => name !== "config.json");
const changed = packageFiles.filter((name) => name !== "config.json" && read(join(candidate, SKILL, name)) !== read(join(target, name)));
const removed = currentFiles.filter((name) => !packageFiles.includes(name));
console.log(`包内文件：${packageFiles.join(" / ")}`);
console.log(`待变更：${changed.length ? changed.join(" / ") : "无"}`);
console.log(`待删除：${removed.length ? removed.join(" / ") : "无"}`);
if (!changed.length && !removed.length) process.exit(0);
if (!apply) {
  console.log("只读检查完成；--apply 会写入待变更文件并删除待删除文件（config.json 不覆盖）。");
  process.exit(0);
}
ensureCurrentVersion(target, { reason: "提议落地前的当前状态", check: { errors: check.errors.length, warnings: check.warnings.length } });
for (const name of removed) rmSync(join(target, name), { force: true });
for (const name of changed) {
  const path = join(target, name);
  mkdirSync(dirname(path), { recursive: true });
  cpSync(join(candidate, SKILL, name), path);
}
const version = appendVersion(target, {
  source: "agent-proposal",
  reason: `候选包 ${candidate}`,
  check: { errors: check.errors.length, warnings: check.warnings.length }
});
console.log(`已写入 ${changed.length} 个、删除 ${removed.length} 个文件，记为 v${version.version}。`);
