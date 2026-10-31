/** 练习页的选择状态：考察主题（浏览器本地标签）与题型。 */

import type { ExerciseType } from "@codebase-tutor/domain";

export interface PracticeTheme {
  id: string;
  label: string;
  hint: string;
  custom?: boolean;
}

const PRACTICE_KEY = "codebase-tutor.practice-modules";
const ACTIVE_KEY_PREFIX = "codebase-tutor.module.";
const TYPE_KEY = "codebase-tutor.practice-type";
/** 旧清单里的两张「默认主题」卡都不是考察知识：一张曾兼任题型开关，一张是「全仓」。 */
const LEGACY_THEME_IDS = ["comprehension", "all"];

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
  return Array.isArray(stored) ? stored.filter((item) => item?.custom === true && typeof item.id === "string" && typeof item.label === "string") : [];
}

export function savePracticeThemes(modules: PracticeTheme[]): void {
  writeJson(PRACTICE_KEY, modules.filter((item) => item.custom === true));
}

/** 上次停在哪个主题；主题已删（或停在旧默认卡上）就是不选主题。 */
export function loadActiveTheme(repositoryId: string, modules: PracticeTheme[]): string {
  const saved = readJson<string | null>(ACTIVE_KEY_PREFIX + "practice." + repositoryId, null);
  if (saved && !LEGACY_THEME_IDS.includes(saved) && modules.some((item) => item.id === saved)) return saved;
  return modules[0]?.id ?? "";
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
