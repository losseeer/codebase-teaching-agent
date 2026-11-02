import type { AgentTracePayload } from "@codebase-tutor/contract";
import { maskSecrets } from "@codebase-tutor/domain";

import { broadcast } from "../events.js";

/** 运行轨迹：补序号与时间后广播到全局事件流；不落盘。 */
let seq = 0;

/** 模型回复在轨迹里只留一段，够看出这一轮说了什么。 */
const REPLY_CHARS = 2_000;

export function emitAgentTrace(step: Omit<AgentTracePayload, "seq" | "at">): void {
  const { label, detail, reply, ...rest } = step;
  const clipped = reply && reply.trim() ? (reply.length > REPLY_CHARS ? `${reply.slice(0, REPLY_CHARS)}…` : reply) : undefined;
  const replyText = clipped ? maskSecrets(clipped).text : undefined;
  broadcast({
    type: "agent.trace",
    payload: {
      ...rest,
      label: label.slice(0, 120),
      ...(detail ? { detail: detail.slice(0, 400) } : {}),
      ...(replyText ? { reply: replyText } : {}),
      seq: ++seq,
      at: new Date().toISOString()
    }
  });
}
