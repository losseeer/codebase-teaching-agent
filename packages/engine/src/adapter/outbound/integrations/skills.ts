import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LlmTool } from "../../../application/port/llm-provider.js";
import { maskSecrets } from "@codebase-tutor/domain";

/**
  技能加载：按 Agent Skills 规格读 `SKILL.md` + YAML frontmatter（必填 `name`、`description`；`name` ≤64 且等于目录名，`description` ≤1024）。
  三级加载：清单每轮进上下文，正文与目录内附属文件由 `read_skill` 按需取。
  只读用户自己装的目录，不扫被学习仓；目录不存在就一条技能都不给。
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

/** 技能目录：`TUTOR_SKILLS_DIR`（`:` 或 `,` 分隔多处）；没配就认家目录里那两处。 */
export function skillDirectories(): string[] {
  const configured = (process.env.TUTOR_SKILLS_DIR ?? "").split(/[:,]/).map((item) => item.trim()).filter(Boolean);
  if (configured.length) return configured;
  return [join(homedir(), ".codebase-tutor", "skills"), join(homedir(), ".claude", "skills")];
}

/** 出厂预置技能在引擎包内的 `skills/`；按 `package.json` 的包名往上找，不写死层数。 */
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

/** 播种结果，`kept` = 目标目录里同名已存在、因此没动的那几份。 */
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

/** 取 frontmatter（文件开头两条 `---` 之间）里的单层 `key: value`。只支持这个形状，多余的一律当没写。 */
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
  if (!target.startsWith(skillRoot + "/")) return undefined;
  let real: string;
  let base: string;
  try {
    real = realpathSync(target);
    base = realpathSync(skillRoot);
  } catch {
    return undefined;
  }
  if (!real.startsWith(`${base}/`)) return undefined;
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
    return { skills, skipped }; // 这处目录不存在/读不了：没装，不报错也不编一份空清单
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

/** 上下文里那段技能清单，附「先调 `read_skill` 取正文再照做」。 */
export function skillsBriefing(skills: SkillBrief[]): string {
  if (!skills.length) return "";
  const lines = skills.map((skill) => `- ${skill.name}：${skill.description}`);
  return `可用技能（每份都是一套写好的做法，含命令与红线）：\n${lines.join("\n")}\n要用哪一份就先调 read_skill 取正文（做法里提到的附属文件用同一个工具的 file 参数取），别凭名字猜内容。`;
}

/** 技能正文与附属文件的取用工具；清单常驻上下文，正文按需拉取。 */
export const READ_SKILL_TOOL: LlmTool = {
  name: "read_skill",
  description: "按名字取一份技能的完整正文（系统提示词里那张清单上的名字）。做法、命令与红线都在正文里——只凭名字猜内容会猜错。正文提到的附属文件（脚本、参照表之类）用 file 参数按相对该技能目录的路径取。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "清单上的技能名字" },
      file: { type: "string", description: "可选：技能目录内的相对路径，省略就取 SKILL.md 正文" }
    },
    required: ["name"]
  }
};
