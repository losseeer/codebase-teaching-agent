/** 是否断线类失败（AbortError 与 fetch 网络错误）；引擎可能仍会算完并落库。 */
export function lostInTransit(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === "AbortError") return true;
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.includes("连接中断") || text.includes("Failed to fetch") || text.includes("Load failed") || text.includes("NetworkError");
}
