/** agent 消息除正文外的可选格：card 图卡片、options+askId 提问候选与认领句柄、retry 重发原文、lines 过程行。 */
export type MessageExtra = { card?: { diagramId: string; name: string }; options?: string[]; askId?: string; retry?: string; lines?: string[] };

/** 线程一条消息的形态；agent 存原文，variant 标记非正文消息。 */
export type ThreadItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string; variant?: "error" | "hint" | "ask" | "warn" } & MessageExtra;

/** 线程正文一行的最小形状；断线回读只比条数。 */
export type ThreadRow = { id: string; role: string; content: string };

/** 线程正文 → 侧栏展示项；本地提示不落库、也读不回来。 */
export function threadItemsFrom(messages: readonly ThreadRow[]): ThreadItem[] {
  return messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content)
    .map((message) => ({ kind: message.role === "user" ? "user" as const : "agent" as const, id: message.id, text: message.content }));
}
