import type { ChatScope } from "@codebase-tutor/shared";

/**
  Agent 侧栏的本地持久化（localStorage / sessionStorage）与补账节奏常量。
  真源在引擎库，这里只记「这个浏览器上次停在哪」与「断线那轮的欠账」——从 useScopedChat 抽出来，
  让单一状态源那一个 Hook 只管编排，不管存储读写。
  */

/** 会话线程记忆的键（localStorage）：`repositoryId → 作用域 → { currentId, ids }`。 */
const SESSION_STORAGE_KEY = "codebase-tutor.teaching-sessions";
/** 断线补账欠账的键（sessionStorage）：`repositoryId → 作用域 → { threadId, count }`。 */
const DEBT_STORAGE_KEY = "codebase-tutor.turn-debt";

/** 断线那一轮的欠账：threadId + 记账时库里的正文条数。 */
export interface TurnDebt {
  threadId: string;
  count: number;
}

/**
  补账的回读节奏（毫秒）：断线那一刻引擎多半还在算，第一次回读「正文没多」是常态，不能据此宣布失败。
  12s / 30s / 60s 三趟仍没等到才说明白——那一轮确实没落库。总等待约 100s，够一轮教学回合算完。
  */
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

/** 欠账写回 sessionStorage；存不下（禁用存储或格式坏）就退回「本轮不补账」，发送本身不受影响。 */
export function writeDebtMap(map: Record<string, Partial<Record<ChatScope, TurnDebt>>>): void {
  try {
    sessionStorage.setItem(DEBT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 存不下就退回「本轮不补账」 */
  }
}

export function readThreadMemory(): ThreadMemoryMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: ThreadMemoryMap = {};
    for (const [repositoryId, scopes] of Object.entries(parsed)) {
      if (typeof scopes !== "object" || scopes === null) continue; // 旧形状在这一层露馅：值是字符串
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

/** 写线程记忆（localStorage 不可用时静默跳过：记忆只是「上次停在哪」的便利，真源在引擎库里）。 */
export function writeThreadMemory(repositoryId: string, scope: ChatScope, next: ThreadMemory): void {
  try {
    const map = readThreadMemory();
    map[repositoryId] = { ...map[repositoryId], [scope]: next };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* localStorage 不可用时记忆只在当前页面内有效，不影响发送 */
  }
}
