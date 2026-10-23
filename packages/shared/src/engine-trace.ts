/** 引擎工作日志（trace）里允许出现的标量——与 journal payload 同口径，避免结构化对象随版本漂移。 */
export type TraceScalar = string | number | boolean | null;

/**
  引擎工作日志的事件种类。只描述「引擎这个进程在干活」，不描述对话语义：
  - http     一次 HTTP 请求（method / url / status / 耗时）
  - import   导入任务（索引 → 摘要 → 建课 → LLM 润色的阶段推进与结果）
  - reindex  挂载仓库被写入触发的重分析
  - degrade  降级与预算熔断（不静默：降级必须留痕）
  - turn_stop 用户点「停止生成」命中在途回合（对话语义本身在 journal 的 turn_aborted）
  - boot     启动分段计时
  LLM 调用明细不在此列——它落在 `~/.codebase-tutor/llm.log`，两处靠 traceId 关联（单一事实来源，不双写）。
  */
export type EngineTraceKind = "http" | "import" | "reindex" | "degrade" | "turn_stop" | "boot" | "mount";

export interface EngineTraceEvent {
  at: string;
  kind: EngineTraceKind;
  /** 关联键：同一请求产生的 http / llm / journal 事件共享它；后台任务为 null。 */
  traceId: string | null;
  /**
    调用方身份（API key 的名字）。认证闸撤了之后新行恒 null，只有历史行里有值。
    字段保留只为两份日志线（`llm.log` 与本文件）的列形状一致，不要按它做按人对账。
  */
  actor?: string | null;
  durationMs?: number | null;
  detail: Record<string, TraceScalar>;
}
