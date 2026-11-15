/** 用户技能：列表、读写、新建、上传、删除。所有路径限定在用户技能目录下。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

import { skillsFs } from "../../infrastructure/composition-root.js";

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_FILE = 100_000;
const MAX_TOTAL = 1_000_000;
const TEXT_EXT = /\.(md|txt|json)$/i;

export interface SkillItem {
  name: string;
  description: string;
  bundled: boolean;
  files: string[];
}
export type SkillResult<T> = { ok: true; value: T } | { ok: false; error: string };

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function userRoot(): string {
  return resolve(skillsFs.skillDirectories()[0]);
}

function skillDir(name: string): string {
  if (!NAME.test(name) || name.includes("__")) throw new Error("技能名不合规：小写字母/数字/连字符/下划线，≤40 字");
  const dir = resolve(userRoot(), name);
  if (!dir.startsWith(userRoot() + sep)) throw new Error("技能路径越界");
  return dir;
}

export function listSkillsUseCase(): SkillItem[] {
  const root = userRoot();
  if (!existsSync(root)) return [];
  const source = skillsFs.bundledSkillSource();
  const bundled = new Set(source && existsSync(source)
    ? readdirSync(source).filter((entry) => statSync(join(source, entry)).isDirectory())
    : []);
  return skillsFs.listSkills([root]).skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    bundled: bundled.has(skill.name),
    files: skillsFs.listSkillFiles(skill.name, [root])
  }));
}

export function readSkillUseCase(name: string): SkillResult<{ text: string; files: string[] }> {
  try {
    const path = join(skillDir(name), "SKILL.md");
    if (!existsSync(path)) return { ok: false, error: "这份技能没有 SKILL.md" };
    return { ok: true, value: { text: readFileSync(path, "utf8"), files: skillsFs.listSkillFiles(name, [userRoot()]) } };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export function writeSkillUseCase(name: string, text: string): SkillResult<{ files: string[] }> {
  try {
    if (!text.trimStart().startsWith("---")) return { ok: false, error: "SKILL.md 开头要有 frontmatter（---）" };
    const dir = skillDir(name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    if (existsSync(path)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(`${path}.bak-${stamp}`, readFileSync(path));
    }
    writeFileSync(path, text, "utf8");
    return { ok: true, value: { files: skillsFs.listSkillFiles(name, [userRoot()]) } };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

const TEMPLATE = (name: string): string => `---
name: ${name}
description: 一句话说明什么时候用它
---

# ${name}

步骤：
1. 
`;

export function createSkillUseCase(name: string): SkillResult<{ text: string; files: string[] }> {
  try {
    const dir = skillDir(name);
    if (existsSync(join(dir, "SKILL.md"))) return { ok: false, error: "同名技能已存在" };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), TEMPLATE(name), "utf8");
    return { ok: true, value: { text: TEMPLATE(name), files: ["SKILL.md"] } };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export function deleteSkillUseCase(name: string): SkillResult<{ name: string }> {
  try {
    const dir = skillDir(name);
    if (!existsSync(dir)) return { ok: false, error: "技能不存在" };
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, value: { name } };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export function uploadSkillUseCase(name: string, fileName: string, base64: string): SkillResult<{ files: string[] }> {
  try {
    const dir = skillDir(name);
    const data = Buffer.from(base64, "base64");
    if (data.length > MAX_TOTAL) return { ok: false, error: "文件超过 1MB" };
    const files = new Map<string, Uint8Array>();
    if (/\.zip$/i.test(fileName)) {
      const entries = unzipSync(new Uint8Array(data));
      for (const [path, content] of Object.entries(entries)) {
        if (!TEXT_EXT.test(path) || path.endsWith("/")) continue;
        if (content.length > MAX_FILE) return { ok: false, error: `文件过大：${path}` };
        files.set(path, content);
      }
    } else if (/\.md$/i.test(fileName)) {
      files.set("SKILL.md", new Uint8Array(data));
    } else {
      return { ok: false, error: "只支持 .md 或 .zip" };
    }
    const paths = [...files.keys()];
    const prefix = paths.every((path) => path.includes("/")) ? paths[0].slice(0, paths[0].indexOf("/") + 1) : "";
    const main = files.get(`${prefix}SKILL.md`);
    if (!main) return { ok: false, error: "压缩包里找不到 SKILL.md" };
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of files) {
      const rel = path.slice(prefix.length);
      if (rel.startsWith("/") || rel.includes("..") || rel.includes("\\")) return { ok: false, error: `路径越界：${path}` };
      const target = resolve(dir, rel);
      if (!target.startsWith(dir + sep)) return { ok: false, error: `路径越界：${path}` };
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    return { ok: true, value: { files: skillsFs.listSkillFiles(name, [userRoot()]) } };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
