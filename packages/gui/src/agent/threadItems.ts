/** thread 一条消息的形态：用户/Agent。
  agent 消息存原文，由 AgentRail 按需走 Markdown 渲染；`variant` 标记非正文消息（错误提示 / 本地提示）。
  位置/状态变化（切换作用域、切换节点、选中文件等）不以分割线入线程——上下文变化由绑定区展示，
  线程只留真实的对话内容。 */
export type ThreadItem =
  | { kind: "user"; id: string; text: string }
  /**
    `card`：这一回合 agent 画（或改）了一张图，消息下面挂一张可点开的图卡片。
    挂在消息上而不是全局提示条上——用户事后回来还能找到「哪句话画出了哪张图」。
  */
  | { kind: "agent"; id: string; text: string; variant?: "error" | "hint"; card?: { diagramId: string; name: string } };

/** 线程正文一行的最小形状：teaching 的 TutorMessage 与 map/practice 的 ChatThreadMessage 都能对上（断线补账只比条数）。 */
export type ThreadRow = { id: string; role: string; content: string };

/** 线程正文 → 侧栏展示项：库里只有 user/assistant 两种角色，hint/error 这类本地提示不落库、也读不回来。 */
export function threadItemsFrom(messages: readonly ThreadRow[]): ThreadItem[] {
  return messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content)
    .map((message) => ({ kind: message.role === "user" ? "user" as const : "agent" as const, id: message.id, text: message.content }));
}
