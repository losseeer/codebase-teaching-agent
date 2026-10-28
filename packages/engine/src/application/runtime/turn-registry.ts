/**
  在途回合注册表：「停止生成」按 turnId 找到该回合的 AbortController。
  SSE 断开不等于停止，回合继续算完并落库。
  生命周期：beginTurn 登记，dispose 摘除；表里只有进行中的回合。
*/
import type { TurnScene } from "@codebase-tutor/contract";

export type { TurnScene };

export interface TurnHandle {
  /** 校验后的 turnId；客户端没给或格式非法时缺省。 */
  readonly turnId?: string;
  /** 未登记（没传 turnId 或撞号）时为 undefined。 */
  readonly signal?: AbortSignal;
  dispose(): void;
}

interface ActiveTurn {
  controller: AbortController;
  scene: TurnScene;
  startedAt: number;
}

const active = new Map<string, ActiveTurn>();

export function sanitizeTurnId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? trimmed : undefined;
}

export function beginTurn(turnId: unknown, scene: TurnScene): TurnHandle {
  const id = sanitizeTurnId(turnId);
  // 撞号时不覆盖既有登记
  if (!id || active.has(id)) return { ...(id ? { turnId: id } : {}), dispose: () => undefined };
  const turn: ActiveTurn = { controller: new AbortController(), scene, startedAt: Date.now() };
  active.set(id, turn);
  return {
    turnId: id,
    signal: turn.controller.signal,
    dispose: () => { if (active.get(id) === turn) active.delete(id); }
  };
}

export type AbortResult = { aborted: false; reason: "not_found" } | { aborted: true; scene: TurnScene; waitedMs: number; turnId: string };

/** 中止已登记的在途回合，并摘除登记。 */
export function abortTurn(turnId: unknown): AbortResult {
  const id = sanitizeTurnId(turnId);
  const turn = id ? active.get(id) : undefined;
  if (!id || !turn) return { aborted: false, reason: "not_found" };
  active.delete(id);
  turn.controller.abort();
  return { aborted: true, scene: turn.scene, waitedMs: Date.now() - turn.startedAt, turnId: id };
}

