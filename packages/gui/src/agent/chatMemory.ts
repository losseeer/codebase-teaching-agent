import type { ChatScope } from "@codebase-tutor/contract";

/**
  Agent 侧栏的 localStorage/sessionStorage 持久化与断线回读节奏常量。
  真源在引擎库，这里只记浏览器上次的位置与待回读记录。
  */

/** 会话线程记忆键（localStorage）：`repositoryId → 作用域 → { currentId, ids }`。 */
const SESSION_STORAGE_KEY = "codebase-tutor.teaching-sessions";
/** 待回读记录键（sessionStorage）：`repositoryId → 作用域 → { threadId, count }`。 */
const DEBT_STORAGE_KEY = "codebase-tutor.turn-debt";

/** 断线轮的待回读记录：threadId + 记账时的正文条数。 */
export interface TurnDebt {
  threadId: string;
  count: number;
}

/** 断线回读的延迟表（毫秒），逐档重试。 */
export const RECHECK_DELAYS = [12_000, 30_000, 60_000] as const;

export interface ThreadMemory {
  currentId: string | null;
  ids: string[];
}
export type ThreadMemoryMap = Record<string, Partial<Record<ChatScope, ThreadMemory>>>;

export function readDebtMap(): Record<string, Partial<Record<ChatScope, TurnDebt>>> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DEBT_STORAGE_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, Partial<Record<ChatScope, TurnDebt>>> = {};
    for (const [repositoryId, scopes] of Object.entries(parsed)) {
      if (typeof scopes !== "object" || scopes === null) continue;
      const entry: Partial<Record<ChatScope, TurnDebt>> = {};
      for (const scope of ["teach", "map", "practice"] as const) {
        const value = (scopes as Record<string, unknown>)[scope];
        if (typeof value !== "object" || value === null) continue;
        const { threadId, count } = value as { threadId?: unknown; count?: unknown };
        if (typeof threadId === "string" && typeof count === "number") entry[scope] = { threadId, count };
      }
      out[repositoryId] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** 欠账写回 sessionStorage；存不下即无回读记录。 */
export function writeDebtMap(map: Record<string, Partial<Record<ChatScope, TurnDebt>>>): void {
  try {
    sessionStorage.setItem(DEBT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 存不下即无回读记录 */
  }
}

export function readThreadMemory(): ThreadMemoryMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: ThreadMemoryMap = {};
    for (const [repositoryId, scopes] of Object.entries(parsed)) {
      if (typeof scopes !== "object" || scopes === null) continue;
      const entry: Partial<Record<ChatScope, ThreadMemory>> = {};
      for (const scope of ["teach", "map", "practice"] as const) {
        const value = (scopes as Record<string, unknown>)[scope];
        if (typeof value !== "object" || value === null) continue;
        const { currentId, ids } = value as { currentId?: unknown; ids?: unknown };
        entry[scope] = {
          currentId: typeof currentId === "string" ? currentId : null,
          ids: Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : []
        };
      }
      out[repositoryId] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写线程记忆；localStorage 不可用时静默跳过。 */
export function writeThreadMemory(repositoryId: string, scope: ChatScope, next: ThreadMemory): void {
  try {
    const map = readThreadMemory();
    map[repositoryId] = { ...map[repositoryId], [scope]: next };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 存储失败时记忆仅本页有效 */
  }
}
