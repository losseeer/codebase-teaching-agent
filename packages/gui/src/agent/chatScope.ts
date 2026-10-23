import type { ChatScope } from "@codebase-tutor/shared/wire";

/**
  Agent 侧栏的 3 个作用域。
  - `map`      宏观设计（绑定文件树，可见画布/关系，动作只读）
  - `teaching` 代码教学（绑定当前文件或目录，可见源码/锚点，动作可写入 session）
  - `practice` 练习评估（绑定当前练习，可见题目/进度，动作可写入学习日志）
  */
export type Scope = "map" | "teaching" | "practice";
export const SCOPES: ReadonlyArray<Scope> = ["map", "teaching", "practice"] as const;

/** 宏观设计绑定的两种合法情形：项目目录选文件 / 画布模块（+其关联文件）。 */
export type MapBinding = { kind: "file" | "module"; title?: string; path?: string };

export const SCOPE_LABEL: Record<Scope, string> = {
  map: "宏观设计",
  teaching: "代码教学",
  practice: "练习评估",
};

export const SCOPE_STORAGE_KEY = "codebase-tutor.scope";

/** GUI 作用域（teaching）→ 引擎作用域取值（teach）：两套口径的对应关系只在这一处表里换算。 */
export const CHAT_SCOPE: Record<Scope, ChatScope> = { map: "map", teaching: "teach", practice: "practice" };

function isScope(value: string): value is Scope {
  return value === "map" || value === "teaching" || value === "practice";
}

export function loadInitialScope(): Scope {
  try {
    const saved = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (saved && isScope(saved)) return saved;
  } catch {
    /* localStorage 不可用时 fallback */
  }
  return "teaching";
}
