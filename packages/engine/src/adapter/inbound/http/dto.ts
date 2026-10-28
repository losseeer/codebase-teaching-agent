/**
  请求体与查询串 → 领域值。外部输入形状不可信，所以逐字段核类型、截长、重建对象。
  这里只有守卫，没有任何业务判断。
*/

/** GUI 上送的 scopePaths（画布模块的文件清单）：它是提示而非裁决，未知路径由引擎交集丢弃。 */
export function sanitizeScopePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 400))];
  return paths.length ? paths.slice(0, 1_000) : undefined;
}

/** 线程 id 入参守卫；没给就是无会话线程。 */
export function sanitizeThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/** 「画布上正打开的那张图」入参守卫：只截长，不校验存在性。 */
export function sanitizeDiagramId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/** 认领句柄的入参守卫：只截长，能否认上由检查点那一层判。 */
export function sanitizeAskId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}
