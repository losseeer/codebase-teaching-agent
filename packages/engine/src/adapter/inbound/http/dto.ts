/**
  请求体与查询串 → 领域值的守卫：逐字段核类型、截长、重建对象。
  这里只有守卫，没有业务判断。
*/

/** scopePaths 是提示而非裁决，未知路径由引擎丢弃。 */
export function sanitizeScopePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 400))];
  return paths.length ? paths.slice(0, 1_000) : undefined;
}

/** 线程 id 入参守卫；未提供表示无会话线程。 */
export function sanitizeThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/** 画布当前打开图的 id 入参守卫；不校验存在性。 */
export function sanitizeDiagramId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/** 认领句柄的入参守卫；能否认领由检查点层判定。 */
export function sanitizeAskId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}
