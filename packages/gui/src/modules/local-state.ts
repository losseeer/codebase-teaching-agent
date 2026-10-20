/**
  练习页的自建出题主题：只是浏览器本地的标签，不来自课程树，也不参与画布。
  入口固定「程序理解题」；用户自建主题由 LLM 按主题出题。
*/

export interface KnowledgeModule {
  id: string;
  label: string;
  hint: string;
  /** 用户自建主题（可删除）；默认「程序理解题」不是自建。 */
  custom?: boolean;
}

export const PRACTICE_DEFAULT_MODULES: KnowledgeModule[] = [
  { id: "comprehension", label: "程序理解题", hint: "规则出题 · 改代码 / 修改定位 / 影响分析，判分确定" }
];

export const COMPREHENSION_MODULE_ID = "comprehension";

const PRACTICE_KEY = "codebase-tutor.practice-modules";
const ACTIVE_KEY_PREFIX = "codebase-tutor.module.";

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

export function loadPracticeModules(): KnowledgeModule[] {
  const stored = readJson<KnowledgeModule[]>(PRACTICE_KEY, []);
  const custom = Array.isArray(stored) ? stored.filter((item) => item?.custom === true && typeof item.id === "string" && typeof item.label === "string") : [];
  return [...PRACTICE_DEFAULT_MODULES.map((item) => ({ ...item })), ...custom];
}

export function savePracticeModules(modules: KnowledgeModule[]): void {
  writeJson(PRACTICE_KEY, modules.filter((item) => item.custom === true));
}

/** 上次停在哪个主题；主题已不存在时回落第一个。 */
export function loadActiveModule(repositoryId: string, modules: KnowledgeModule[]): string {
  const saved = readJson<string | null>(ACTIVE_KEY_PREFIX + "practice." + repositoryId, null);
  if (saved && modules.some((item) => item.id === saved)) return saved;
  return modules[0]?.id ?? "";
}

export function saveActiveModule(repositoryId: string, id: string): void {
  writeJson(ACTIVE_KEY_PREFIX + "practice." + repositoryId, id);
}
