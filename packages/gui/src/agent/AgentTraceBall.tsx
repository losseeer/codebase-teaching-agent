import { useEffect, useState, type ReactElement } from "react";
import type { AgentScope, AgentSurface, AgentToolEntry } from "@codebase-tutor/contract";

import { Icon } from "../ui/icons";
import { useAgentSurface } from "./useAgentSurface";
import { useAgentTrace, type TraceRun, type TraceStep } from "./useAgentTrace";
import { useTraceHistory } from "./useTraceHistory";

const SCENE_LABEL: Record<string, string> = { "teaching.turn": "教学", "map.chat": "画布", "practice.chat": "练习" };
const SCOPE_LABEL: Record<AgentScope, string> = { map: "画布", teaching: "教学", practice: "练习" };
const STATUS_LABEL: Record<TraceRun["status"], string> = { running: "进行中", ok: "完成", error: "失败", aborted: "提前结束" };
const FINISH_LABEL: Record<string, string> = { stop: "结束", length: "截断", tool_calls: "调工具" };

type TraceTab = "trace" | "skills" | "tools";

interface SurfaceBadge {
  label: string;
  tone: "ok" | "warn" | "off";
}

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
  const round = step.round === undefined ? "" : step.kind === "model" ? `第 ${step.round} 次` : `第 ${step.round} 轮`;
  return [
    round,
    duration(step.ms),
    tokenCount(step),
    step.finishReason ? FINISH_LABEL[step.finishReason] ?? step.finishReason : ""
  ].filter(Boolean).join(" · ");
}

/** 实时与历史按 runId 去重：同一个回合优先留实时帧，历史补上已过去的回合。 */
function mergeRuns(live: TraceRun[], history: TraceRun[]): TraceRun[] {
  const seen = new Set(live.map((run) => run.runId));
  return [...live, ...history.filter((run) => !seen.has(run.runId))]
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
}

/** 悬浮球：打开当前仓的运行轨迹。 */
export function AgentTraceBall({ repositoryId, scope }: { repositoryId: string | null; scope: AgentScope }): ReactElement | null {
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
      {open ? <TraceModal runs={runs} repositoryId={repositoryId} scope={scope} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function TraceModal({ runs, repositoryId, scope, onClose }: { runs: TraceRun[]; repositoryId: string; scope: AgentScope; onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<TraceTab>("trace");
  const [selectedId, setSelectedId] = useState(runs[0]?.runId);
  const { surface, error, loading } = useAgentSurface(repositoryId, scope);
  const { runs: historyRuns, error: historyError, loading: historyLoading } = useTraceHistory(repositoryId);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);
  const merged = mergeRuns(runs, historyRuns);
  const selected = merged.find((run) => run.runId === selectedId) ?? merged[0];
  const tabs: { id: TraceTab; label: string }[] = [
    { id: "trace", label: "轨迹" },
    { id: "skills", label: "技能" },
    { id: "tools", label: "工具" }
  ];
  return (
    <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal wide trace-modal" role="dialog" aria-modal="true" aria-label="运行轨迹">
        <div className="modal-head">
          <h3>运行轨迹</h3>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="trace-tabs" role="tablist" aria-label="轨迹视图">
          {tabs.map((item) => (
            <button key={item.id} id={`trace-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls="trace-panel" className={`trace-tab${tab === item.id ? " active" : ""}`} onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
          <span className="trace-scope" title="当前作用区">{SCOPE_LABEL[scope]}</span>
        </div>
        <div className="modal-body" id="trace-panel" role="tabpanel" aria-labelledby={`trace-tab-${tab}`}>
          {tab === "trace" && merged.length > 1 ? (
            <div className="trace-runs" aria-label="最近几次运行">
              {merged.map((run) => (
                <button key={run.runId} type="button" className={`trace-run-chip${run.runId === selected?.runId ? " active" : ""}`} title={run.historical ? `来自 journal：${run.summary ?? "回合汇总"}` : run.summary ?? ""} onClick={() => setSelectedId(run.runId)}>
                  {run.historical ? "历史 · " : ""}{sceneLabel(run.scene)} · {shortTime(run.historical ? run.endedAt ?? run.startedAt : run.startedAt)}
                </button>
              ))}
            </div>
          ) : null}
          {tab === "trace" ? (
            <>
              {historyError ? <p className="field-note">历史读取失败：{historyError}</p> : null}
              {selected ? <RunView run={selected} /> : historyLoading ? <p className="field-note">正在读取历史…</p> : <p className="field-note">还没有运行记录。</p>}
            </>
          ) : null}
          {tab === "skills" ? <SkillsView surface={surface} error={error} loading={loading} /> : null}
          {tab === "tools" ? <ToolsView surface={surface} error={error} loading={loading} /> : null}
        </div>
        <div className="modal-foot">
          <span className="modal-note">{tab === "trace" ? "实时 + 历史记录" : "只读 · 来自引擎注册表"}</span>
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
      {run.historical ? <p className="field-note">历史回合按 journal 汇总。</p> : null}
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
  const content = (
    <>
      <StepStatus step={step} />
      <span className="trace-step-label" title={step.label}>{step.label}</span>
      <span className="trace-step-meta">{stepMeta(step)}</span>
      {detail ? <span className={`trace-chevron${open ? " open" : ""}`}><Icon name="chevronDown" size={12} /></span> : null}
    </>
  );
  return (
    <div className="trace-step">
      {detail ? (
        <button type="button" className="trace-step-btn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{content}</button>
      ) : (
        <div className="trace-step-btn static">{content}</div>
      )}
      {detail && open ? <div className="trace-step-detail">{detail}</div> : null}
    </div>
  );
}

function StepStatus({ step }: { step: TraceStep }): ReactElement {
  if (step.status === "start") return <span className="spin trace-step-status"><Icon name="rotate" size={11} /></span>;
  const tone = step.status === "ok" ? "ok" : step.status === "aborted" ? "aborted" : "error";
  return <span className={`trace-dot ${tone} trace-step-status`} />;
}

function SkillsView({ surface, error, loading }: { surface: AgentSurface | null; error: string | null; loading: boolean }): ReactElement {
  if (loading && !surface) return <p className="field-note">正在读取技能清单…</p>;
  if (error) return <p className="field-note">{error}</p>;
  if (!surface) return <p className="field-note">读不到技能清单。</p>;
  return (
    <>
      {surface.skills.length ? (
        <section className="surface-group">
          <div className="trace-group-head"><span>已装载</span><span className="trace-count">{surface.skills.length}</span></div>
          {surface.skills.map((skill) => (
            <SurfaceRow key={skill.name} title={skill.name} subtitle={skill.description} badge={{ label: "可用", tone: "ok" }} detail={[skill.description, `目录：${skill.directory}`].join("\n")} mono />
          ))}
        </section>
      ) : (
        <>
          <p className="field-note">没有装载技能。</p>
          {surface.directories.length ? <p className="field-note">目录：{surface.directories.join("、")}</p> : null}
        </>
      )}
      {surface.skillSkipped.length ? (
        <section className="surface-group">
          <div className="trace-group-head"><span>未装载</span><span className="trace-count">{surface.skillSkipped.length}</span></div>
          {surface.skillSkipped.map((entry, index) => <SurfaceRow key={`${entry.dir}-${index}`} title={entry.dir} subtitle={entry.reason} badge={{ label: "跳过", tone: "off" }} mono />)}
        </section>
      ) : null}
    </>
  );
}

function ToolsView({ surface, error, loading }: { surface: AgentSurface | null; error: string | null; loading: boolean }): ReactElement {
  if (loading && !surface) return <p className="field-note">正在读取工具清单…</p>;
  if (error) return <p className="field-note">{error}</p>;
  if (!surface) return <p className="field-note">读不到工具清单。</p>;
  return (
    <section className="surface-group">
      <div className="trace-group-head"><span>清单</span><span className="trace-count">{surface.tools.filter((tool) => tool.available).length} 可用</span></div>
      {surface.tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
    </section>
  );
}

function ToolRow({ tool }: { tool: AgentToolEntry }): ReactElement {
  const badge: SurfaceBadge = tool.available
    ? tool.conditional ? { label: "按条件", tone: "warn" } : { label: "可用", tone: "ok" }
    : { label: "不可用", tone: "off" };
  const detail = [tool.description, tool.reason ?? ""].filter(Boolean).join("\n");
  return <SurfaceRow title={tool.name} subtitle={tool.description} badge={badge} detail={detail} mono />;
}

function SurfaceRow({ title, subtitle, badge, detail, mono }: { title: string; subtitle?: string; badge?: SurfaceBadge; detail?: string; mono?: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const content = (
    <>
      <span className="surface-row-main">
        <span className={`surface-row-title${mono ? " mono" : ""}`} title={title}>{title}</span>
        {subtitle ? <span className="surface-row-sub" title={subtitle}>{subtitle}</span> : null}
      </span>
      <span className="surface-row-side">
        {badge ? <span className={`surface-badge ${badge.tone}`}>{badge.label}</span> : null}
      </span>
      {detail ? <span className={`trace-chevron${open ? " open" : ""}`}><Icon name="chevronDown" size={12} /></span> : null}
    </>
  );
  return (
    <div className="surface-row">
      {detail ? (
        <button type="button" className="surface-row-btn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{content}</button>
      ) : (
        <div className="surface-row-btn static">{content}</div>
      )}
      {detail && open ? <div className="surface-row-detail">{detail}</div> : null}
    </div>
  );
}
