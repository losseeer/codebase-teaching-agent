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

/** 提示词用的版本：空画像返回 undefined，避免多一段空标题。 */
export function profileForPrompt(): string | undefined {
  const text = readProfile().trim();
  return text ? text.slice(0, PROFILE_LIMIT) : undefined;
}
