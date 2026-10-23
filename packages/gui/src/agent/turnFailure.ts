/**
  回合失败是「断线」还是「引擎答砸了」：fetch 层面两者同形（都是抛错），但只有前者引擎仍会把这一轮
  算完并落库，回来时补得回——补账只对这一类开。AbortError 是连接被掐（断网时浏览器也这么抛），
  「连接中断，未收到完整回复」是流提前收尾，Failed to fetch / Load failed / NetworkError 是各家浏览器
  对 fetch 网络错误的文案。引擎显式回的 error 事件（模型失败、会话失效）不在其列。
  */
export function lostInTransit(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === "AbortError") return true;
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.includes("连接中断") || text.includes("Failed to fetch") || text.includes("Load failed") || text.includes("NetworkError");
}
