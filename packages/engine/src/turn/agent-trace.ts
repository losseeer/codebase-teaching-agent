import type { AgentTracePayload } from "@codebase-tutor/contract";

import { broadcast } from "../events.js";

/** 运行轨迹：补序号与时间后广播到全局事件流；不落盘。 */
let seq = 0;

export function emitAgentTrace(step: Omit<AgentTracePayload, "seq" | "at">): void {
  const { label, detail, ...rest } = step;
  broadcast({
    type: "agent.trace",
    payload: {
      ...rest,
      label: label.slice(0, 120),
      ...(detail ? { detail: detail.slice(0, 400) } : {}),
      seq: ++seq,
      at: new Date().toISOString()
    }
  });
}
