import type { ChatScope } from "@codebase-tutor/contract";

/** Agent 侧栏工作区：map=架构全景、teaching=代码问答、practice=练习。 */
export type Scope = "map" | "teaching" | "practice";
export const SCOPES: ReadonlyArray<Scope> = ["map", "teaching", "practice"] as const;

/** 架构全景的绑定情形：项目目录选文件 / 画布节点。 */
export type MapBinding = { kind: "file" | "module"; title?: string; path?: string };

export const SCOPE_LABEL: Record<Scope, string> = {
  map: "架构全景",
  teaching: "代码问答",
  practice: "练习",
};

export const SCOPE_STORAGE_KEY = "codebase-tutor.scope";

/** GUI 工作区与引擎工作区取值的换算表。 */
export const CHAT_SCOPE: Record<Scope, ChatScope> = { map: "map", teaching: "teach", practice: "practice" };

function isScope(value: string): value is Scope {
  return value === "map" || value === "teaching" || value === "practice";
}

export function loadInitialScope(): Scope {
  try {
    const saved = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (saved && isScope(saved)) return saved;
  } catch {
    /* 存储不可用则用默认工作区 */
  }
  return "teaching";
}
