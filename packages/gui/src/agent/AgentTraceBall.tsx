import { useEffect, useState, type ReactElement } from "react";

import { Icon } from "../ui/icons";
import { useAgentTrace, type TraceRun, type TraceStep } from "./useAgentTrace";

const SCENE_LABEL: Record<string, string> = { "teaching.turn": "教学", "map.chat": "画布", "practice.chat": "练习" };
const STATUS_LABEL: Record<TraceRun["status"], string> = { running: "进行中", ok: "完成", error: "失败", aborted: "提前结束" };
const FINISH_LABEL: Record<string, string> = { stop: "结束", length: "截断", tool_calls: "调工具" };

const sceneLabel = (scene: string): string => SCENE_LABEL[scene] ?? scene;

function shortTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function duration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tokenCount(step: TraceStep): string {
  return step.inputTokens === undefined && step.outputTokens === undefined ? "" : `${step.inputTokens ?? 0}→${step.outputTokens ?? 0}`;
}

function stepMeta(step: TraceStep): string {
  if (step.kind === "turn") return [step.model ?? "", STATUS_LABEL[step.status === "start" ? "running" : step.status]].filter(Boolean).join(" · ");
  return [
    step.kind === "model" ? `第 ${step.round ?? 1} 次` : `第 ${step.round ?? 1} 轮`,
    duration(step.ms),
    tokenCount(step),
    step.finishReason ? FINISH_LABEL[step.finishReason] ?? step.finishReason : ""
  ].filter(Boolean).join(" · ");
}

/** 悬浮球：打开当前仓的运行轨迹。 */
export function AgentTraceBall({ repositoryId }: { repositoryId: string | null }): ReactElement | null {
  const { runs } = useAgentTrace(repositoryId);
  const [open, setOpen] = useState(false);
  if (!repositoryId) return null;
  const running = runs[0]?.status === "running";
  return (
    <>
      <button type="button" className={`trace-ball${running ? " running" : ""}`} aria-label="运行轨迹" title="运行轨迹" onClick={() => setOpen(true)}>
        <Icon name="zap" size={18} />
        {running ? <span className="trace-ball-dot" /> : null}
      </button>
      {open ? <TraceModal runs={runs} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function TraceModal({ runs, onClose }: { runs: TraceRun[]; onClose: () => void }): ReactElement {
  const [selectedId, setSelectedId] = useState(runs[0]?.runId);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);
  const selected = runs.find((run) => run.runId === selectedId) ?? runs[0];
  return (
    <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal wide trace-modal" role="dialog" aria-modal="true" aria-label="运行轨迹">
        <div className="modal-head">
          <h3>运行轨迹</h3>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          {runs.length > 1 ? (
            <div className="trace-runs" aria-label="最近几次运行">
              {runs.map((run) => (
                <button key={run.runId} type="button" className={`trace-run-chip${run.runId === selected?.runId ? " active" : ""}`} title={run.summary ?? ""} onClick={() => setSelectedId(run.runId)}>
                  {sceneLabel(run.scene)} · {shortTime(run.startedAt)}
                </button>
              ))}
            </div>
          ) : null}
          {selected ? <RunView run={selected} /> : <p className="field-note">还没有运行记录。</p>}
        </div>
        <div className="modal-foot">
          <span className="modal-note">仅本次打开期间</span>
          <button type="button" className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function RunView({ run }: { run: TraceRun }): ReactElement {
  const input = run.steps.filter((step) => step.kind === "turn");
  const models = run.steps.filter((step) => step.kind === "model");
  const tools = run.steps.filter((step) => step.kind === "tool");
  return (
    <>
      <div className="trace-run-head">
        <span className={`trace-dot ${run.status}`} />
        <span className="trace-run-scene">{sceneLabel(run.scene)}</span>
        <span className="trace-run-status">{STATUS_LABEL[run.status]}</span>
        <span className="trace-run-summary" title={run.summary}>{run.summary ?? ""}</span>
      </div>
      <TraceGroup title="输入" steps={input} />
      <TraceGroup title="模型" steps={models} />
      <TraceGroup title="工具" steps={tools} />
    </>
  );
}

function TraceGroup({ title, steps }: { title: string; steps: TraceStep[] }): ReactElement | null {
  if (!steps.length) return null;
  return (
    <section className="trace-group">
      <div className="trace-group-head"><span>{title}</span><span className="trace-count">{steps.length}</span></div>
      {steps.map((step) => <TraceRow key={step.stepId ?? `${step.kind}-${step.seq}`} step={step} />)}
    </section>
  );
}

function TraceRow({ step }: { step: TraceStep }): ReactElement {
  const [open, setOpen] = useState(false);
  const detail = step.detail;
  return (
    <div className="trace-step">
      <button type="button" className="trace-step-btn" aria-expanded={detail ? open : undefined} onClick={() => { if (detail) setOpen((value) => !value); }}>
        <StepStatus step={step} />
        <span className="trace-step-label" title={step.label}>{step.label}</span>
        <span className="trace-step-meta">{stepMeta(step)}</span>
        {detail ? <span className={`trace-chevron${open ? " open" : ""}`}><Icon name="chevronDown" size={12} /></span> : null}
      </button>
      {detail && open ? <div className="trace-step-detail">{detail}</div> : null}
    </div>
  );
}

function StepStatus({ step }: { step: TraceStep }): ReactElement {
  if (step.status === "start") return <span className="spin trace-step-status"><Icon name="rotate" size={11} /></span>;
  const tone = step.status === "ok" ? "ok" : step.status === "aborted" ? "aborted" : "error";
  return <span className={`trace-dot ${tone} trace-step-status`} />;
}
