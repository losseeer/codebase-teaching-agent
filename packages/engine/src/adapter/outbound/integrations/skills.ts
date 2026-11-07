import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { maskSecrets } from "@codebase-tutor/domain";

/**
  技能加载：读 SKILL.md 的 YAML frontmatter，name ≤64 且等于目录名，description ≤1024。
  清单每轮进上下文，正文与附属文件由 read_skill 按需取。
  只读用户自己装的目录，不扫被学习仓。
*/

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
/** `description` 超过 1024 字判为形状不合规，不裁短。 */
const DESCRIPTION_MAX = 1024;
/** 一次交回的字数上限，正文与附属文件共用；超出截断并留声明。 */
const PAYLOAD_CHARS = 12_000;
/** 规格：≤64、以小写字母或数字开头结尾、中间允许连字符（连续连字符另外单独判）。 */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

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
      // 这一层没有 package.json，继续往上找
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

/** 取 frontmatter（开头两条 `---` 之间）的单层 `key: value`；其余形状当没写。 */
/**
  恢复出厂技能：把用户技能目录里「出厂技能」的副本逐文件覆盖回出厂版本。
  - 只动出厂技能同名目录；用户自建的技能（出厂没有的）不碰；
  - 用户在出厂技能里多放的文件保留（覆盖只针对出厂也有的那些文件）；
  - 覆盖前把被动的技能目录备份到 `<目录>.bak-<时间戳>/`。
  出厂技能本身只读，永不被这个流程写入。
*/
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

/**
  出厂技能与用户目录的差异（只读，不写盘）。
  供 CLI 报告与界面提示用；实际覆盖走 restoreBundledSkills。
*/
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
    const fromFiles = filesUnder(from);
    const toFiles = new Set(filesUnder(to));
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

export function restoreBundledSkills(input?: { sourceDir?: string; targetDir?: string }): { restored: string[]; backupDirs: string[]; files: number } {
  const target = input?.targetDir ?? skillDirectories()[0];
  const source = input?.sourceDir ?? bundledSkillSource();
  if (!source) return { restored: [], backupDirs: [], files: 0 };
  const load = listSkills([source]);
  mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const restored: string[] = [];
  let files = 0;
  const backupDirs: string[] = [];
  for (const skill of load.skills) {
    const from = join(source, skill.name);
    const to = join(target, skill.name);
    if (!existsSync(to)) {
      cpSync(from, to, { recursive: true });
      restored.push(skill.name);
      continue;
    }
    const backup = `${to}.bak-${stamp}`;
    cpSync(to, backup, { recursive: true });
    backupDirs.push(backup);
    for (const name of filesUnder(from)) {
      const targetFile = join(to, name);
      mkdirSync(dirname(targetFile), { recursive: true });
      cpSync(join(from, name), targetFile);
      files += 1;
    }
    restored.push(skill.name);
  }
  return { restored, backupDirs, files };
}

/** 目录下所有文件的相对路径。 */
function filesUnder(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+?)\s*$/.exec(line);
    if (entry && !fields[entry[1]]) fields[entry[1]] = entry[2];
  }
  return fields;
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
  return NAME_PATTERN.test(name) && !name.includes("--");
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
    if (taken.size >= SKILL_MAX) { skipped.push({ dir, reason: `清单已满 ${SKILL_MAX} 份` }); continue; }
    if (taken.has(dir)) { skipped.push({ dir, reason: "同名技能已在更靠前的目录里装过" }); continue; }
    let text: string;
    try {
      text = readFileSync(join(directory, dir, "SKILL.md"), "utf8");
    } catch {
      skipped.push({ dir, reason: "目录里没有可读的 SKILL.md" });
      continue;
    }
    const fields = frontmatter(text);
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

/** 按名字取一份技能的正文或目录内附属文件；取不到返回 `undefined`。 */
/** 列出某个技能目录下的 Markdown 文件：read_skill 读错文件名时，把这份清单回给模型。 */
export function listSkillFiles(name: string, directories: string[] = skillDirectories()): string[] {
  if (!validName(name)) return [];
  for (const directory of directories) {
    const skillRoot = join(directory, name);
    try {
      if (!statSync(skillRoot).isDirectory()) continue;
      return readdirSync(skillRoot).filter((entry) => entry.endsWith(".md")).sort();
    } catch {
      continue;
    }
  }
  return [];
}

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
  // 把附属文件也列出来：不列的话模型只能猜文件名（曾经猜 java.md / checklist.md，
  // 实际目录里是 cn.md / ds.md / backend.md / os.md，白调两次工具）。
  const lines = skills.map((skill) => {
    const attached = listSkillFiles(skill.name).filter((file) => file !== "SKILL.md");
    return `- ${skill.name}：${skill.description}${attached.length ? `（附属：${attached.join(" / ")}）` : ""}`;
  });
  return `可用技能（每份都是一套写好的做法，含命令与红线）：\n${lines.join("\n")}\n要用哪一份就先调 read_skill 取正文（附属文件用同一个工具的 file 参数取），别凭名字猜内容。`;
}
