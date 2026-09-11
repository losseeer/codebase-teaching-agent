export interface HookEvent {
  tool?: string;
  path?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
}

export interface HookFilterResult {
  accepted: boolean;
  reason: string;
  latencyMs: number;
}

/** Local rules keep hook classification below the latency budget and never call a model. */
export function filterTeachMoment(event: HookEvent): HookFilterResult {
  const start = performance.now();
  const output = event.output ?? "";
  const accepted = Boolean(event.exitCode && event.exitCode !== 0) || /\b(TODO|FIXME|TypeError|ReferenceError|AssertionError)\b/.test(output) || Boolean(event.path && /\.(ts|tsx|js|jsx|py)$/.test(event.path) && event.durationMs && event.durationMs > 8_000);
  const reason = event.exitCode && event.exitCode !== 0 ? "工具执行失败" : /\b(TODO|FIXME)\b/.test(output) ? "发现待处理标记" : accepted ? "长耗时源码操作需要回顾" : "事件与教学时机无关";
  return { accepted, reason, latencyMs: Number((performance.now() - start).toFixed(3)) };
}
