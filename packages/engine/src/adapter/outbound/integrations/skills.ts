import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { maskSecrets } from "@codebase-tutor/domain";

import { legacyStrategyOf } from "../../../exercises/exercise-strategy.js";
import { appendVersion, ensureCurrentVersion } from "./skill-versions.js";
import { DESCRIPTION_MAX, SKILL_NAME_PATTERN, parseFrontmatter } from "../../../exercises/skill-spec.js";

/** 技能加载：读用户目录 SKILL.md 的 frontmatter，清单进上下文、正文与附属文件按需取；不扫被学习仓。 */

export interface SkillBrief {
  /** frontmatter 的 `name`（已验等于目录名）。 */
  name: string;
  description: string;
  /** 从哪个目录读到的。 */
  directory: string;
}

export interface SkillLoad {
  skills: SkillBrief[];
  /** 没被采纳的条目与原因。 */
  skipped: { dir: string; reason: string }[];
}

/** 清单最多露几份。 */
const SKILL_MAX = 12;

/** 由用户维护、同步不覆盖的文件；重置技能时随出厂版本恢复。 */
const USER_OWNED_FILES = new Set(["config.json"]);

/** 正文与 Markdown 附属文件的字数上限；.json 豁免，见 readAttached。 */
const PAYLOAD_CHARS = 12_000;


/** 技能目录：`TUTOR_SKILLS_DIR`（`path.delimiter` 或 `,` 分隔多处）；没配就认家目录里那两处。 */
export function skillDirectories(): string[] {
  const configured = (process.env.TUTOR_SKILLS_DIR ?? "").split(new RegExp(`[${delimiter},]`)).map((item) => item.trim()).filter(Boolean);
  if (configured.length) return configured;
  return [join(homedir(), ".codebase-tutor", "skills"), join(homedir(), ".claude", "skills")];
}

/** 出厂预置技能在引擎包内的 `skills/`，按 package.json 的包名往上找。 */
export function bundledSkillSource(): string | undefined {
  let directory = import.meta.dirname;
  for (let up = 0; up < 6; up += 1) {
    try {
      if (/"name":\s*"@codebase-tutor\/engine"/.test(readFileSync(join(directory, "package.json"), "utf8"))) {
        const candidate = join(directory, "skills");
        return statSync(candidate).isDirectory() ? candidate : undefined;
      }
    } catch {
    }
    directory = join(directory, "..");
  }
  return undefined;
}

/** 播种结果，kept 是目标目录里同名已存在的项。 */
export interface SkillSeed {
  target: string;
  installed: string[];
  kept: string[];
  skipped: { dir: string; reason: string }[];
}

/** 把引擎包里的技能复制到第一个技能目录；不覆盖同名，只搬合规格的。 */
export function installBundledSkills(input?: { sourceDir?: string; targetDir?: string }): SkillSeed {
  const target = input?.targetDir ?? skillDirectories()[0];
  const source = input?.sourceDir ?? bundledSkillSource();
  const seed: SkillSeed = { target, installed: [], kept: [], skipped: [] };
  if (!source) return seed;
  const load = listSkills([source]);
  seed.skipped = load.skipped;
  mkdirSync(target, { recursive: true });
  for (const skill of load.skills) {
    const destination = join(target, skill.name);
    if (existsSync(destination)) {
      seed.kept.push(skill.name);
      continue;
    }
    cpSync(join(source, skill.name), destination, { recursive: true });
    seed.installed.push(skill.name);
  }
  return seed;
}

/** 恢复出厂技能：逐文件覆盖同名目录，用户自建技能与多出的文件不动；出厂技能本身只读。 */
/** 一份出厂技能与用户目录的差异。 */
export interface SkillDiffEntry {
  skill: string;
  /** 与出厂内容不同的文件（用户改过，或用户目录里缺这个文件）。 */
  differs: string[];
  /** 只在用户目录里有的文件（恢复出厂不会删它）。 */
  extra: string[];
}

export interface SkillDiff {
  entries: SkillDiffEntry[];
  /** 出厂有、用户目录里完全没有的技能。 */
  missing: string[];
  /** 差异涉及的文件总数。 */
  files: number;
}

/** 只读预览出厂技能与用户目录的差异，供 CLI/界面报告；实际覆盖走 restoreBundledSkills。 */
export function diffBundledSkills(input?: { sourceDir?: string; targetDir?: string }): SkillDiff {
  const target = input?.targetDir ?? skillDirectories()[0];
  const source = input?.sourceDir ?? bundledSkillSource();
  if (!source) return { entries: [], missing: [], files: 0 };
  const entries: SkillDiffEntry[] = [];
  const missing: string[] = [];
  let files = 0;
  for (const skill of listSkills([source]).skills) {
    const from = join(source, skill.name);
    const to = join(target, skill.name);
    if (!existsSync(to)) {
      missing.push(skill.name);
      files += filesUnder(from).length;
      continue;
    }
    const keep = (name: string): boolean => !USER_OWNED_FILES.has(name);
    const fromFiles = filesUnder(from).filter(keep);
    const toFiles = new Set(filesUnder(to).filter(keep));
    const differs = fromFiles.filter((name) => !toFiles.has(name) || !sameFileContent(join(from, name), join(to, name)));
    const extra = [...toFiles].filter((name) => !fromFiles.includes(name));
    if (!differs.length && !extra.length) continue;
    entries.push({ skill: skill.name, differs, extra });
    files += differs.length;
  }
  return { entries, missing, files };
}

/** 两个文件内容是否一致。 */
function sameFileContent(left: string, right: string): boolean {
  try { return readFileSync(left, "utf8") === readFileSync(right, "utf8"); } catch { return false; }
}

export function restoreBundledSkills(input?: { sourceDir?: string; targetDir?: string; includeUserOwned?: boolean }): { restored: string[]; files: number } {
  const target = input?.targetDir ?? skillDirectories()[0];
  const source = input?.sourceDir ?? bundledSkillSource();
  if (!source) return { restored: [], files: 0 };
  const load = listSkills([source]);
  mkdirSync(target, { recursive: true });
  const restored: string[] = [];
  let files = 0;
  for (const skill of load.skills) {
    const from = join(source, skill.name);
    const to = join(target, skill.name);
    if (!existsSync(to)) {
      cpSync(from, to, { recursive: true });
      files += filesUnder(from).length;
      appendVersion(to, { source: "migration", reason: "首次安装", check: { errors: 0, warnings: 0 } });
      restored.push(skill.name);
      continue;
    }
    ensureCurrentVersion(to, { reason: "写入前记录当前状态" });
    for (const name of filesUnder(from)) {
      const targetFile = join(to, name);
      if (input?.includeUserOwned !== true && USER_OWNED_FILES.has(name)) {
        if (existsSync(targetFile)) continue;
        mkdirSync(dirname(targetFile), { recursive: true });
        const legacy = name === "config.json" && existsSync(join(to, "SKILL.md"))
          ? legacyStrategyOf(readFileSync(join(to, "SKILL.md"), "utf8"))
          : undefined;
        if (legacy) writeFileSync(targetFile, JSON.stringify({ version: 1, exerciseStrategy: legacy }, null, 2) + "\n", "utf8");
        else cpSync(join(from, name), targetFile);
        files += 1;
        continue;
      }
      mkdirSync(dirname(targetFile), { recursive: true });
      cpSync(join(from, name), targetFile);
      files += 1;
    }
    appendVersion(to, { source: "reset", reason: "恢复出厂技能", check: { errors: 0, warnings: 0 } });
    restored.push(skill.name);
  }
  return { restored, files };
}

/** 目录下所有文件的相对路径。 */
function filesUnder(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === ".versions") continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}



/** `SKILL.md` 的正文 = frontmatter 之后那一段。 */
function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

function clip(text: string, label: string): string {
  return text.length > PAYLOAD_CHARS ? `${text.slice(0, PAYLOAD_CHARS)}\n…（${label}已截断，共 ${text.length} 字。）` : text;
}

/** 在读取出口隐去密钥。 */
function mask(text: string): string {
  return maskSecrets(text).text;
}

/** 名字是否合规格；连续连字符单独判。 */
function validName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && !name.includes("--");
}

/** 附属文件只接技能目录内的相对路径：拒绝对等路径、`~`、`..` 段与跳出目录的符号链接；含 NUL 的不接。 */
function readAttached(skillRoot: string, file: string): string | undefined {
  if (resolve(file) === file || file.startsWith("~")) return undefined;
  const target = join(skillRoot, file);
  if (!target.startsWith(skillRoot + sep)) return undefined;
  let real: string;
  let base: string;
  try {
    real = realpathSync(target);
    base = realpathSync(skillRoot);
  } catch {
    return undefined;
  }
  if (!real.startsWith(`${base}${sep}`)) return undefined;
  try {
    if (!statSync(real).isFile()) return undefined;
    const text = readFileSync(real, "utf8");
    if (text.includes("\0")) return undefined;
    if (file.endsWith(".json")) return mask(text);
    return mask(clip(text, "附属文件"));
  } catch {
    return undefined;
  }
}

function scan(directory: string, taken: Set<string>): { skills: SkillBrief[]; skipped: { dir: string; reason: string }[] } {
  const skills: SkillBrief[] = [];
  const skipped: { dir: string; reason: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory).filter((name) => {
      try {
        return statSync(join(directory, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return { skills, skipped };
  }
  for (const dir of entries.sort()) {
    // 备份目录不是技能，跳过
    if (dir.includes(".bak-")) continue;
    if (taken.size >= SKILL_MAX) { skipped.push({ dir, reason: `清单已满 ${SKILL_MAX} 份` }); continue; }
    if (taken.has(dir)) { skipped.push({ dir, reason: "同名技能已在更靠前的目录里装过" }); continue; }
    let text: string;
    try {
      text = readFileSync(join(directory, dir, "SKILL.md"), "utf8");
    } catch {
      skipped.push({ dir, reason: "目录里没有可读的 SKILL.md" });
      continue;
    }
    const fields = parseFrontmatter(text);
    if (!fields.name) { skipped.push({ dir, reason: "frontmatter 缺 name" }); continue; }
    if (!validName(fields.name)) { skipped.push({ dir, reason: `name 不合规格（≤${64} 字、小写字母/数字/单个连字符、首尾不能是连字符）` }); continue; }
    if (fields.name !== dir) { skipped.push({ dir, reason: `frontmatter 的 name「${fields.name}」与目录名不一致` }); continue; }
    if (!fields.description) { skipped.push({ dir, reason: "frontmatter 缺 description" }); continue; }
    if (fields.description.length > DESCRIPTION_MAX) { skipped.push({ dir, reason: `description 超过规格上限 ${DESCRIPTION_MAX} 字` }); continue; }
    skills.push({ name: fields.name, description: mask(fields.description), directory });
    taken.add(fields.name);
  }
  return { skills, skipped };
}

export function listSkills(directories: string[] = skillDirectories()): SkillLoad {
  const skills: SkillBrief[] = [];
  const skipped: { dir: string; reason: string }[] = [];
  const taken = new Set<string>();
  for (const directory of directories) {
    const found = scan(directory, taken);
    skills.push(...found.skills);
    skipped.push(...found.skipped.map((entry) => ({ ...entry, dir: `${entry.dir}（在 ${directory}）` })));
    if (taken.size >= SKILL_MAX) break;
  }
  return { skills: skills.slice(0, SKILL_MAX), skipped };
}

/** 列出某个技能目录下的 Markdown 文件：read_skill 读错文件名时，把这份清单回给模型。 */
export function listSkillFiles(name: string, directories: string[] = skillDirectories()): string[] {
  if (!validName(name)) return [];
  for (const directory of directories) {
    const skillRoot = join(directory, name);
    try {
      if (!statSync(skillRoot).isDirectory()) continue;
      return readdirSync(skillRoot).sort();
    } catch {
      continue;
    }
  }
  return [];
}

/** 按名字取一份技能的正文或目录内附属文件；取不到返回 `undefined`。 */
export function readSkill(name: string, file = "SKILL.md", directories: string[] = skillDirectories()): string | undefined {
  if (!validName(name)) return undefined;
  for (const directory of directories) {
    const skillRoot = join(directory, name);
    try {
      if (!statSync(skillRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    if (file === "SKILL.md") {
      try {
        return mask(clip(stripFrontmatter(readFileSync(join(skillRoot, "SKILL.md"), "utf8")), "正文"));
      } catch {
        return undefined;
      }
    }
    const attached = readAttached(skillRoot, file);
    if (attached !== undefined) return attached;
  }
  return undefined;
}

/** 上下文里那段技能清单，附「先调 `read_skill` 取正文」。 */
export function skillsBriefing(skills: SkillBrief[]): string {
  if (!skills.length) return "";
  const lines = skills.map((skill) => {
    const attached = listSkillFiles(skill.name).filter((file) => file.endsWith(".md") && file !== "SKILL.md");
    return `- ${skill.name}：${skill.description}${attached.length ? `（附属：${attached.join(" / ")}）` : ""}`;
  });
  return `可用技能（每份都是一套写好的做法，含命令与红线）：\n${lines.join("\n")}\n要用哪一份就先调 read_skill 取正文（附属文件用同一个工具的 file 参数取），别凭名字猜内容。`;
}
