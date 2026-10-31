/** 练习页的选择状态：考察主题（浏览器本地标签）与题型。 */

import type { ExerciseType } from "@codebase-tutor/domain";

export interface PracticeTheme {
  id: string;
  label: string;
  hint: string;
  /** 用户自建主题（可删除）；「全仓」不是自建。 */
  custom?: boolean;
}

/** 「全仓」＝不限定考察主题；理解题与设计题允许不选题。 */
export const ALL_THEME_ID = "all";

export const PRACTICE_DEFAULT_THEMES: PracticeTheme[] = [
  { id: ALL_THEME_ID, label: "全仓", hint: "不限定考察主题，按掌握度选题" }
];

const PRACTICE_KEY = "codebase-tutor.practice-modules";
const ACTIVE_KEY_PREFIX = "codebase-tutor.module.";
const TYPE_KEY = "codebase-tutor.practice-type";
/** 旧清单里「程序理解题」那张卡曾兼任题型开关，改造后等价于「全仓」。 */
const LEGACY_ANY_THEME = "comprehension";

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 持久化失败不影响本次会话 */ }
};

export function loadPracticeThemes(): PracticeTheme[] {
  const stored = readJson<PracticeTheme[]>(PRACTICE_KEY, []);
  const custom = Array.isArray(stored) ? stored.filter((item) => item?.custom === true && typeof item.id === "string" && typeof item.label === "string") : [];
  return [...PRACTICE_DEFAULT_THEMES.map((item) => ({ ...item })), ...custom];
}

export function savePracticeThemes(modules: PracticeTheme[]): void {
  writeJson(PRACTICE_KEY, modules.filter((item) => item.custom === true));
}

/** 上次停在哪个主题；主题已不存在（或旧口径）时回落「全仓」。 */
export function loadActiveTheme(repositoryId: string, modules: PracticeTheme[]): string {
  const saved = readJson<string | null>(ACTIVE_KEY_PREFIX + "practice." + repositoryId, null);
  const normalized = saved === LEGACY_ANY_THEME ? ALL_THEME_ID : saved;
  if (normalized && modules.some((item) => item.id === normalized)) return normalized;
  return modules[0]?.id ?? ALL_THEME_ID;
}

export function saveActiveTheme(repositoryId: string, id: string): void {
  writeJson(ACTIVE_KEY_PREFIX + "practice." + repositoryId, id);
}

/** 题型三档是全局偏好：换仓库不必重选。 */
export function loadPracticeType(): ExerciseType {
  const saved = readJson<string>(TYPE_KEY, "comprehension");
  return saved === "analysis" || saved === "design" ? saved : "comprehension";
}

export function savePracticeType(type: ExerciseType): void {
  writeJson(TYPE_KEY, type);
}
