import { useEffect, useState, type ReactElement } from "react";
import type { AgentScope, AgentSurface, AgentToolEntry } from "@codebase-tutor/contract";

import { Icon } from "../ui/icons";
import { useAgentSurface } from "./useAgentSurface";
import { useAgentTrace, type TraceRun, type TraceStep } from "./useAgentTrace";
import { inScope, practiceAgentLabel } from "./traceScope";
import { useTraceHistory } from "./useTraceHistory";

const SCENE_LABEL: Record<string, string> = { "teaching.turn": "代码问答", "map.chat": "架构全景", "practice.chat": "练习答疑", "practice.generate": "出题" };
const SCOPE_LABEL: Record<AgentScope, string> = { map: "架构全景", teaching: "代码问答", practice: "练习" };
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
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${time}`;
}

function duration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function stepMeta(step: TraceStep): string {
  if (step.kind === "turn") return [step.model ?? "", STATUS_LABEL[step.status === "start" ? "running" : step.status]].filter(Boolean).join(" · ");
  const round = step.round === undefined ? "" : step.kind === "model" ? `第 ${step.round} 次` : `第 ${step.round} 轮`;
  return [
    round,
    duration(step.ms),
    step.finishReason ? FINISH_LABEL[step.finishReason] ?? step.finishReason : ""
  ].filter(Boolean).join(" · ");
}

/** 实时与历史按 runId 去重：同一个回合优先留实时帧，历史补上已过去的回合。 */
function mergeRuns(live: TraceRun[], history: TraceRun[]): TraceRun[] {
  const seen = new Set(live.map((run) => run.runId));
  return [...live, ...history.filter((run) => !seen.has(run.runId))]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

interface RunGroup {
  key: string;
  label: string;
  runs: TraceRun[];
}

/** 已结束的运行按 agent 分堆：练习区分出题与答疑，其余工作区只有一堆。 */
function historyGroups(runs: TraceRun[], scope: AgentScope): RunGroup[] {
  const byTime = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (scope !== "practice") return byTime.length ? [{ key: "all", label: "", runs: byTime }] : [];
  const groups: RunGroup[] = [];
  for (const run of byTime) {
    const label = practiceAgentLabel(run.scene) ?? "其他";
    const group = groups.find((item) => item.key === label);
    if (group) group.runs.push(run);
    else groups.push({ key: label, label, runs: [run] });
  }
  return groups;
}

/** 悬浮球：打开当前仓、当前工作区的运行轨迹。 */
export function AgentTraceBall({ repositoryId, scope }: { repositoryId: string | null; scope: AgentScope }): ReactElement | null {
  const { runs } = useAgentTrace(repositoryId);
  const [open, setOpen] = useState(false);
  if (!repositoryId) return null;
  const scoped = runs.filter((run) => inScope(run.scene, scope));
  const running = scoped.some((run) => run.status === "running");
  return (
    <>
      <button type="button" className={`trace-ball${running ? " running" : ""}`} aria-label="运行轨迹" title="运行轨迹" onClick={() => setOpen(true)}>
        <Icon name="zap" size={18} />
        {running ? <span className="trace-ball-dot" /> : null}
      </button>
      {open ? <TraceModal runs={scoped} repositoryId={repositoryId} scope={scope} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function TraceModal({ runs, repositoryId, scope, onClose }: { runs: TraceRun[]; repositoryId: string; scope: AgentScope; onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<TraceTab>("trace");
  const [selectedId, setSelectedId] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const { surface, error, loading } = useAgentSurface(repositoryId, scope);
  const { runs: historyRuns, error: historyError, loading: historyLoading } = useTraceHistory(repositoryId, scope);
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
  const running = merged.filter((run) => run.status === "running");
  const ended = merged.filter((run) => run.status !== "running");
  const groups = historyGroups(ended, scope);
  const selected = merged.find((run) => run.runId === selectedId) ?? running[0];
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
          <span className="trace-scope" title="当前工作区">{SCOPE_LABEL[scope]}</span>
        </div>
        <div className="modal-body" id="trace-panel" role="tabpanel" aria-labelledby={`trace-tab-${tab}`}>
          {tab === "trace" ? (
            <>
              <div className="trace-run-bar">
                {running.length ? (
                  <div className="trace-run-group">
                    <span className="trace-run-group-label">进行中</span>
                    {running.map((run) => (
                      <button key={run.runId} type="button" className={`trace-run-chip running${run.runId === selected?.runId ? " active" : ""}`} onClick={() => { setSelectedId(run.runId); setHistoryOpen(false); }}>
                        <span className="trace-run-live" />
                        {scope === "practice" ? `${practiceAgentLabel(run.scene) ?? "出题"} · ` : ""}{shortTime(run.startedAt)}
                      </button>
                    ))}
                  </div>
                ) : <span className="trace-run-idle">当前没有运行中的agent</span>}
                <button type="button" className={`trace-history-toggle${historyOpen ? " open" : ""}`} aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
                  历史{ended.length ? ` ${ended.length}` : ""}
                </button>
                {selected && selected.status !== "running" ? (
                  <button type="button" className="trace-live-back" onClick={() => { setSelectedId(undefined); setHistoryOpen(false); }}>回到实时</button>
                ) : null}
              </div>
              {historyOpen ? (
                <div className="trace-history-panel">
                  {!groups.length ? <p className="field-note">{historyLoading ? "正在读取历史…" : "没有历史记录。"}</p> : null}
                  {groups.map((group) => (
                    <div key={group.key} className="trace-run-group">
                      {group.label ? <span className="trace-run-group-label">{group.label}</span> : null}
                      {group.runs.map((run) => (
                        <button key={run.runId} type="button" className={`trace-run-chip${run.runId === selected?.runId ? " active" : ""}`} onClick={() => { setSelectedId(run.runId); setHistoryOpen(false); }}>
                          {shortTime(run.startedAt)}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
              {historyError ? <p className="field-note">历史读取失败：{historyError}</p> : null}
              {selected ? <RunView run={selected} /> : null}
            </>
          ) : null}
          {tab === "skills" ? <SkillsView surface={surface} error={error} loading={loading} /> : null}
          {tab === "tools" ? <ToolsView surface={surface} error={error} loading={loading} /> : null}
        </div>
        <div className="modal-foot">
          <span className="modal-note">{tab === "trace" ? "实时 + 历史轨迹" : ""}</span>
          <button type="button" className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 步数太少时不画缩略条：一排碎块没有信息量。 */
const MIN_TIMELINE_STEPS = 6;
const TIMELINE_ROWS: { kind: TraceStep["kind"]; label: string }[] = [
  { kind: "turn", label: "回合" },
  { kind: "model", label: "模型" },
  { kind: "tool", label: "工具" }
];

/** 三行缩略时间条：按时间跨度把一步画成一段，用来看等模型与跑工具各自的分布。 */
function Timeline({ run }: { run: TraceRun }): ReactElement | null {
  if (run.steps.length < MIN_TIMELINE_STEPS) return null;
  const at = (step: TraceStep): number => new Date(step.at).getTime();
  const start = Math.min(...run.steps.map(at));
  const end = Math.max(...run.steps.map((step) => at(step) + (step.ms ?? 0)));
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) return null;
  return (
    <div className="trace-timeline" aria-label="时间概览">
      {TIMELINE_ROWS.map((row) => (
        <div key={row.kind} className={`trace-timeline-row ${row.kind}`}>
          <span className="trace-timeline-label">{row.label}</span>
          <span className="trace-timeline-track">
            {run.steps.filter((step) => step.kind === row.kind).map((step) => {
              const left = Math.max(0, Math.min(99, ((at(step) - start) / span) * 100));
              const width = Math.min(100 - left, Math.max(((step.ms ?? 0) / span) * 100, 1));
              return <span key={step.stepId ?? `${step.kind}-${step.seq}`} className={`trace-timeline-block${step.status === "error" ? " error" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} title={step.label} />;
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

function RunView({ run }: { run: TraceRun }): ReactElement {
  const steps = [...run.steps].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <>
      <div className="trace-run-head">
        <span className={`trace-dot ${run.status}`} />
        <span className="trace-run-scene">{sceneLabel(run.scene)}</span>
        <span className="trace-run-status">{STATUS_LABEL[run.status]}</span>
      </div>
      {run.historical ? <p className="field-note">历史回合按 journal 汇总。</p> : null}
      <Timeline run={run} />
      <div className="trace-steps">
        {steps.map((step) => <TraceRow key={step.stepId ?? `${step.kind}-${step.seq}`} step={step} />)}
      </div>
    </>
  );
}

/** 模型行折叠时先露回复的第一行，点开再看全文。 */
function replyPreview(reply: string): string {
  const line = reply.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function TraceRow({ step }: { step: TraceStep }): ReactElement {
  const [open, setOpen] = useState(false);
  const reply = step.reply?.trim() ? step.reply : undefined;
  const detail = step.detail;
  const expandable = Boolean(reply || detail);
  const label = step.kind === "model" && step.status === "ok" && reply ? replyPreview(reply) : step.label;
  const content = (
    <>
      <StepStatus step={step} />
      <span className={`trace-step-kind ${step.kind}`}>{step.kind === "turn" ? "回合" : step.kind === "model" ? "模型" : "工具"}</span>
      <span className="trace-step-label" title={step.label}>{label}</span>
      <span className="trace-step-meta">{stepMeta(step)}</span>
      {expandable ? <span className={`trace-chevron${open ? " open" : ""}`}><Icon name="chevronDown" size={12} /></span> : null}
    </>
  );
  return (
    <div className="trace-step">
      {expandable ? (
        <button type="button" className="trace-step-btn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{content}</button>
      ) : (
        <div className="trace-step-btn static">{content}</div>
      )}
      {expandable && open ? (
        <div className="trace-step-detail">
          {reply ? <div className="trace-step-reply">{reply}</div> : null}
          {detail ? <div className={reply ? "trace-step-note" : undefined}>{detail}</div> : null}
        </div>
      ) : null}
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
