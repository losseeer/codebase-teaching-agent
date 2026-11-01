import { useEffect, useState } from "react";
import { agentTracePayloadSchema, type AgentTracePayload } from "@codebase-tutor/contract";

import { subscribeServerEvents } from "../api/client";

/** 一次运行的轨迹：按 runId 汇总模型与工具调用。 */
export interface TraceRun {
  runId: string;
  scene: string;
  threadId?: string;
  status: "running" | "ok" | "error" | "aborted";
  startedAt: string;
  endedAt?: string;
  summary?: string;
  steps: AgentTracePayload[];
}

export type TraceStep = AgentTracePayload;

/** 只留最近几次运行，避免一次长会话把内存撑大。 */
const MAX_RUNS = 12;
const MAX_STEPS = 240;

function statusOf(status: AgentTracePayload["status"]): TraceRun["status"] {
  return status === "start" ? "running" : status;
}

function mergeStep(run: TraceRun, step: AgentTracePayload): TraceRun {
  if (!step.stepId) return { ...run, steps: [...run.steps, step].slice(-MAX_STEPS) };
  const at = run.steps.findIndex((item) => item.stepId === step.stepId);
  if (at < 0) return { ...run, steps: [...run.steps, step].slice(-MAX_STEPS) };
  // 后到的 start 不覆盖已完成的结果：断线重连可能乱序
  if (step.status === "start" && run.steps[at].status !== "start") return run;
  const steps = [...run.steps];
  steps[at] = step;
  return { ...run, steps };
}

function applyTrace(runs: TraceRun[], step: AgentTracePayload): TraceRun[] {
  const index = runs.findIndex((run) => run.runId === step.runId);
  if (step.kind === "turn" && step.status === "start") {
    if (index >= 0) return runs;
    const created: TraceRun = { runId: step.runId, scene: step.scene, ...(step.threadId ? { threadId: step.threadId } : {}), status: "running", startedAt: step.at, steps: [step] };
    return [created, ...runs].slice(0, MAX_RUNS);
  }
  if (index < 0) {
    const run: TraceRun = {
      runId: step.runId,
      scene: step.scene,
      ...(step.threadId ? { threadId: step.threadId } : {}),
      status: step.kind === "turn" ? statusOf(step.status) : "running",
      startedAt: step.at,
      steps: []
    };
    return [mergeStep(run, step), ...runs].slice(0, MAX_RUNS);
  }
  const run = runs[index];
  const next: TraceRun = step.kind === "turn"
    ? { ...run, status: statusOf(step.status), endedAt: step.at, summary: step.detail, steps: run.steps.map((item): TraceStep => item.status === "start" ? { ...item, status: step.status } : item) }
    : mergeStep(run, step);
  const copy = [...runs];
  copy[index] = next;
  return copy;
}

export function useAgentTrace(repositoryId: string | null): { runs: TraceRun[] } {
  const [runs, setRuns] = useState<TraceRun[]>([]);
  useEffect(() => {
    setRuns([]);
    if (!repositoryId) return;
    return subscribeServerEvents((event) => {
      if (event.type !== "agent.trace") return;
      const parsed = agentTracePayloadSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.repositoryId !== repositoryId) return;
      setRuns((prev) => applyTrace(prev, parsed.data));
    });
  }, [repositoryId]);
  return { runs };
}
