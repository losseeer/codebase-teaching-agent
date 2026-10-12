/**
  在途回合注册表——「停止生成」的落点（2026-09-30）。

  为什么不能只靠 SSE 连接断开来中止：客户端消失对引擎来说有两种截然相反的原因——
  - 用户点了「停止」：要立刻掐掉 LLM 调用，别再烧完这一轮 token；
  - 网络波动 / 刷新页面：要**继续算完并落库**，用户回到应用时才能补上这一轮的回复。
  连接层分不出这两者（点停止同样会把 fetch 断掉），所以「停止」是一条带外的显式请求，
  按客户端生成的 turnId 找到这一轮的 AbortController；SSE 断开本身一律按第二种处理。

  生命周期：路由 beginTurn → finally dispose；abortTurn 命中即摘除。表里只有进行中的回合，不会累积。
  */

export type TurnScene = "teach" | "map_chat" | "practice_chat";

export interface TurnHandle {
  /** 校验后的 turnId（journal 留痕用）；客户端没给或格式非法时为 undefined。 */
  readonly turnId?: string;
  /** 未登记（没传 turnId 或撞号）时为 undefined——该回合照常执行，只是不可中止。 */
  readonly signal?: AbortSignal;
  dispose(): void;
}

interface ActiveTurn {
  controller: AbortController;
  scene: TurnScene;
  startedAt: number;
  /**
    发起这张回合的身份（key 的 `name`；本机模式没有身份，留 undefined）。
    「停止」是一条能烧掉别人已付 token 的动作，共享部署下不能谁拿着有效 key 都能按。
    */
  actor?: string;
}

const active = new Map<string, ActiveTurn>();

/** turnId 是客户端给的：只接受 8~64 位 URL-safe 串（GUI 用 crypto.randomUUID）才当 map key 用。 */
export function sanitizeTurnId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? trimmed : undefined;
}

export function beginTurn(turnId: unknown, scene: TurnScene, actor?: string): TurnHandle {
  const id = sanitizeTurnId(turnId);
  // 撞号（同一 turnId 已有在途回合）不覆盖：两个并发回合共享一个 id 时，宁可让后一个不可中止，
  // 也不能让它的 dispose 把前一个的登记摘掉——那会让先起的回合再也停不下来。
  if (!id || active.has(id)) return { ...(id ? { turnId: id } : {}), dispose: () => undefined };
  const turn: ActiveTurn = { controller: new AbortController(), scene, startedAt: Date.now(), ...(actor ? { actor } : {}) };
  active.set(id, turn);
  return {
    turnId: id,
    signal: turn.controller.signal,
    dispose: () => { if (active.get(id) === turn) active.delete(id); }
  };
}

export type AbortResult = { aborted: false; reason: "not_found" } | { aborted: false; reason: "forbidden"; scene: TurnScene } | { aborted: true; scene: TurnScene; waitedMs: number; turnId: string };

/**
  中止指定回合。两种「没中止」要分得开：
  - `not_found` = 这一轮已经结束或本来就没登记，调用方回 404（GUI 照常收尾，不报错）；
  - `forbidden` = 这一轮是**别人**的，路由回 403——它还在跑，token 还在烧，中止不了这件事必须看得见。
  登记时没身份（闸门没开）的回合不做归属校验，否则本机模式下「停止生成」会莫名失效。
  */
export function abortTurn(turnId: unknown, actor?: string): AbortResult {
  const id = sanitizeTurnId(turnId);
  const turn = id ? active.get(id) : undefined;
  if (!id || !turn) return { aborted: false, reason: "not_found" };
  if (turn.actor && turn.actor !== actor) return { aborted: false, reason: "forbidden", scene: turn.scene };
  active.delete(id);
  turn.controller.abort();
  return { aborted: true, scene: turn.scene, waitedMs: Date.now() - turn.startedAt, turnId: id };
}

