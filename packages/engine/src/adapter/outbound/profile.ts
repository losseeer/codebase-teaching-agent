/** 跨仓库的用户画像：用户手动编辑的 markdown，不进任何仓库、不写 journal。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 注入上限：画像再长也不该挤掉本轮上下文。 */
export const PROFILE_LIMIT = 4000;

export function profilePath(): string {
  return join(homedir(), ".codebase-tutor", "profile.md");
}

export function readProfile(): string {
  try {
    return readFileSync(profilePath(), "utf8");
  } catch {
    return "";
  }
}

/** 写入即整份替换；空白内容视为清空画像。 */
export function writeProfile(text: string): void {
  const trimmed = text.slice(0, PROFILE_LIMIT).trim();
  const path = profilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, trimmed ? `${trimmed}\n` : "", "utf8");
}

const AUTO_SECTION = "## 自动记录";
const AUTO_LIMIT = 20;

function autoRange(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => line.trim() === AUTO_SECTION);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) { end = index; break; }
  }
  return { start, end };
}

/** 追加一条自动记忆：去重、只裁「自动记录」小节，手写内容不动。 */
export function appendAutoMemory(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const current = readProfile().trim();
  if (current.includes(trimmed)) return false;
  const lines = current ? current.split("\n") : [];
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = `- ${stamp} · ${trimmed}`;
  const range = autoRange(lines);
  if (!range) {
    lines.push("", AUTO_SECTION, entry);
  } else {
    const entries = lines.slice(range.start + 1, range.end).filter((line) => line.startsWith("- "));
    const kept = [...entries, entry].slice(-AUTO_LIMIT);
    lines.splice(range.start + 1, range.end - range.start - 1, ...kept);
  }
  writeProfile(lines.join("\n"));
  return true;
}

/** 提示词用的版本：空画像返回 undefined，避免多一段空标题。 */
export function profileForPrompt(): string | undefined {
  const text = readProfile().trim();
  return text ? text.slice(0, PROFILE_LIMIT) : undefined;
}
