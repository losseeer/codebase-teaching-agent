/**
  同步出厂技能到用户技能目录（dev 用）。

  设计约束：出厂技能（packages/engine/skills）**只读**；出厂在首次启动时把技能 copy 到
  ~/.codebase-tutor/skills，之后**用户可以自由覆盖**那份副本，引擎不自动回灌。
  所以「出厂改了怎么生效」只能是一个**显式动作**——就是这条命令。

  用法：
    tsx dev/skill/sync-skills.ts            # 只报告差异，不动文件
    tsx dev/skill/sync-skills.ts --force    # 真同步：先整目录备份，再覆盖出厂技能同名目录
  用户自建的技能（出厂没有的）永远不动。
*/
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const source = join(import.meta.dirname ?? "", "../../skills");
const target = join(homedir(), ".codebase-tutor", "skills");
const force = process.argv.includes("--force");

if (!existsSync(source)) {
  console.error(`找不到出厂技能目录：${source}`);
  process.exit(1);
}

const skills = readdirSync(source).filter((name) => statSync(join(source, name)).isDirectory());

/** 相对路径下的文件内容是否相同。 */
function sameContent(a: string, b: string): boolean {
  try { return readFileSync(a, "utf8") === readFileSync(b, "utf8"); } catch { return false; }
}

function filesOf(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...filesOf(path, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

let changed = 0;
for (const skill of skills) {
  const from = join(source, skill);
  const to = join(target, skill);
  if (!existsSync(to)) {
    console.log(`新增  ${skill}`);
    changed += 1;
    if (force) {
      cpSync(from, to, { recursive: true });
      console.log(`  已写入 ${to}`);
    }
    continue;
  }
  const fromFiles = filesOf(from);
  const toFiles = new Set(filesOf(to));
  const differs = fromFiles.filter((name) => !toFiles.has(name) || !sameContent(join(from, name), join(to, name)));
  const extra = [...toFiles].filter((name) => !fromFiles.includes(name));
  if (!differs.length && !extra.length) continue;
  console.log(`更新  ${skill}`);
  for (const name of differs) console.log(`  ~ ${name}`);
  for (const name of extra) console.log(`  + 仅用户目录有：${name}（同步不会删它）`);
  changed += 1;
  if (!force) continue;
  // 逐文件覆盖：出厂有的文件用出厂版本，用户多出来的文件原样保留（用户可以自由扩展）。
  for (const name of differs) {
    const targetFile = join(to, name);
    mkdirSync(dirname(targetFile), { recursive: true });
    cpSync(join(from, name), targetFile);
  }
}

if (!changed) {
  console.log("出厂技能与用户目录已经一致。");
} else if (!force) {
  console.log(`\n有 ${changed} 个技能存在差异。加 --force 真同步（会先整目录备份）。`);
} else {
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  cpSync(target, backup, { recursive: true });
  console.log(`\n已备份原用户技能目录到：${backup}`);
  console.log("注意：同步会覆盖用户对出厂技能的修改（含 SKILL.md 里的「当前策略」声明），需要时从备份里改回来。");
}
