import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LlmTool } from "../../../application/port/llm-provider.js";
import { maskSecrets } from "../security/secrets.js";

/**
  技能加载（产品 agent 的「按需取做法」通道），照 Agent Skills 那套公开规格（`SKILL.md` + YAML frontmatter）：
  必填 `name`、`description`；`name` ≤64 字、小写字母/数字/单个连字符、首尾不是连字符，且必须等于目录名；
  `description` ≤1024 字。可选 `license` / `allowed-tools` / `metadata` 解析但不消费
  ——这个产品的权限落在代码那侧（作用域决定给不给工具），不写在别人的文案里。
  按规格而不是自造字段：装技能的目录可以直接指社区已经发布的那批（`~/.claude/skills` 里的东西原样读得懂）。

  三级加载（规格里的 progressive disclosure）在本产品里的落法：清单（名字 + 描述）每轮进上下文，
  正文与目录内的附属文件由 `read_skill` 按需取。

  ⚠️ 两处刻意的边界：
  - 不扫被学习仓里的 `skills/`：一个仓自带的指令文件会直接进 agent 上下文，那是提示注入面。只读用户自己装的目录。
  - 目录不存在 = 一条技能都不给，工具清单与上下文逐字不变。把「没装」读成「有个空清单」会诱导模型去猜一份不存在的做法。
*/

export interface SkillBrief {
  /** frontmatter 的 `name`（已验等于目录名）。 */
  name: string;
  description: string;
  /** 从哪个目录读到的：装了多处时「这份是哪来的」只能靠这一格回答。 */
  directory: string;
}

export interface SkillLoad {
  skills: SkillBrief[];
  /** 没被采纳的条目与原因：这是读数，`GET /api/external` 直接把它交回运维。 */
  skipped: { dir: string; reason: string }[];
}

/** 清单最多露几份：超出的不进气泡，避免每轮为一个可能没人用的清单付费。 */
const SKILL_MAX = 12;
/** 规格上限：`description` 超过 1024 字判为形状不合规（不是裁短）。 */
const DESCRIPTION_MAX = 1024;
/** 一次交回多少字（正文与附属文件同一条上限）；超出截断并留声明，不静默裁。 */
const PAYLOAD_CHARS = 12_000;
/** 规格：≤64、以小写字母或数字开头结尾、中间允许连字符（连续连字符另外单独判）。 */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** 技能目录：`TUTOR_SKILLS_DIR`（`:` 或 `,` 分隔多处）；没配就认家目录里那两处。 */
export function skillDirectories(): string[] {
  const configured = (process.env.TUTOR_SKILLS_DIR ?? "").split(/[:,]/).map((item) => item.trim()).filter(Boolean);
  if (configured.length) return configured;
  return [join(homedir(), ".codebase-tutor", "skills"), join(homedir(), ".claude", "skills")];
}

/**
  出厂预置技能在哪：引擎包内的 `skills/`。
  路径按 `package.json` 的包名往上找，不写层数——`tsx` 跑 `src/` 与 `tsc` 出 `dist/` 两种跑法都要认，
  写死的层数会静默指到别处。
*/
export function bundledSkillSource(): string | undefined {
  let directory = import.meta.dirname;
  for (let up = 0; up < 6; up += 1) {
    try {
      if (/"name":\s*"@codebase-tutor\/engine"/.test(readFileSync(join(directory, "package.json"), "utf8"))) {
        const candidate = join(directory, "skills");
        return statSync(candidate).isDirectory() ? candidate : undefined;
      }
    } catch {
      // 空 catch 是有意的：这一层没有 package.json，继续往上就是正常路径
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

/**
  把引擎包里的技能复制到 `TUTOR_SKILLS_DIR` 第一处（缺省即 `~/.codebase-tutor/skills`）。
  复制而不是让加载器多认一档出厂目录：加载路径只有一条，`GET /api/external` 报的 `directory`
  就是真出处，「同名谁的份生效」也变成「目录里那份」这个物理事实。

  两条规矩：绝不覆盖同名（装过一次那份就归用户，升级不该冲掉）；只搬合规格的
  （坏形状搬进用户目录 = 之后每轮多一条没人认领的 `skipped`）。
*/
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

/** 密钥在读取出口就隐去：出网那发另有 `screenOutbound`，但它管不到随检查点落进 `.tutor/` 的同一份正文。 */
function mask(text: string): string {
  return maskSecrets(text).text;
}

/** 名字合不合规格（连续连字符单独判，正则里表达这条约束太绕）。 */
function validName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes("--");
}

/**
  附属文件的读取守卫：只接技能目录内的相对路径。
  挡三种走法：绝对路径与 `~` 开头、`..` 段、以及经符号链接跳出目录（先 realpath 再比前缀）。
  二进制（正文含 NUL）一律不接：读出来是噪声，而噪声会被模型当成事实。
*/
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

/**
  按名字取一份技能的正文（默认 `SKILL.md`），或取该技能目录里的某个附属文件（`file` 给相对路径）。
  取不到回 `undefined`——调用方照实回一句，别让模型把「没有」读成「空文件」。
*/
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

/**
  上下文里那段清单。写成「先调 read_skill 再照做」：模型见过名字就倾向直接凭名字作答，
  那份做法里写死的命令与红线它一个字都没读到。
*/
export function skillsBriefing(skills: SkillBrief[]): string {
  if (!skills.length) return "";
  const lines = skills.map((skill) => `- ${skill.name}：${skill.description}`);
  return `可用技能（每份都是一套写好的做法，含命令与红线）：\n${lines.join("\n")}\n要用哪一份就先调 read_skill 取正文（做法里提到的附属文件用同一个工具的 file 参数取），别凭名字猜内容。`;
}

/** 技能正文的取用工具：清单常驻上下文，正文按需拉取，成本差一个数量级。 */
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
