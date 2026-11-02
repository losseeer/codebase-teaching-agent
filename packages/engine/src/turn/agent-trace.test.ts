import { expect, it } from "vitest";
import type { ServerEvent } from "@codebase-tutor/contract";

import { subscribeEvents, unsubscribeEvents } from "../events.js";
import { emitAgentTrace } from "./agent-trace.js";

it("轨迹帧补序号与时间后广播，正文与模型回复超长只留一段", () => {
  const seen: ServerEvent[] = [];
  subscribeEvents({ connectionId: "agent-trace-test", send: (event) => seen.push(event) });
  try {
    emitAgentTrace({ repositoryId: "r", runId: "run", scene: "map.chat", kind: "tool", status: "ok", label: "读取 a.ts", detail: "x".repeat(1000) });
    emitAgentTrace({ repositoryId: "r", runId: "run", scene: "map.chat", kind: "model", status: "ok", label: "模型回复", reply: "答".repeat(2500) });
    emitAgentTrace({ repositoryId: "r", runId: "run", scene: "map.chat", kind: "turn", status: "ok", label: "回合完成" });
  } finally {
    unsubscribeEvents("agent-trace-test");
  }
  expect(seen.map((event) => event.type)).toEqual(["agent.trace", "agent.trace", "agent.trace"]);
  const first = seen[0].payload as { seq: number; at: string; detail: string };
  const second = seen[1].payload as { seq: number; reply: string };
  const third = seen[2].payload as { seq: number };
  expect(second.seq).toBe(first.seq + 1);
  expect(third.seq).toBe(second.seq + 1);
  expect(Number.isNaN(Date.parse(first.at))).toBe(false);
  expect(first.detail).toHaveLength(400);
  expect(second.reply).toHaveLength(2001);
  expect(second.reply.endsWith("…")).toBe(true);
});
