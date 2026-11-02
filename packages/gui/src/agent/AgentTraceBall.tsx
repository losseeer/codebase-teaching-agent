import { useEffect, useState, type ReactElement } from "react";
import type { AgentScope, AgentSurface, AgentToolEntry } from "@codebase-tutor/contract";

import { Icon } from "../ui/icons";
import { useAgentSurface } from "./useAgentSurface";
import { useAgentTrace, type TraceRun, type TraceStep } from "./useAgentTrace";

const SCENE_LABEL: Record<string, string> = { "teaching.turn": "教学", "map.chat": "画布", "practice.chat": "练习" };
const SCOPE_LABEL: Record<AgentScope, string> = { map: "画布", teaching: "教学", practice: "练习" };
const STATUS_LABEL: Record<TraceRun["status"], string> = { running: "进行中", ok: "完成", error: "失败", aborted: "提前结束" };
const FINISH_LABEL: Record<string, string> = { stop: "结束", length: "截断", tool_calls: "调工具" };

type TraceTab = "trace" | "skills" | "tools";

interface RuntimeCall {
  calls: TraceStep[];
  chars: number;
  ms: number;
  last?: TraceStep;
}

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

function formatChars(chars: number): string {
  return chars < 1000 ? `${chars} 字` : `${(chars / 1000).toFixed(1)}k 字`;
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

function addCall(usage: Map<string, RuntimeCall>, key: string, step: TraceStep): void {
  const entry = usage.get(key) ?? { calls: [], chars: 0, ms: 0 };
  entry.calls.push(step);
  entry.chars += step.resultChars ?? 0;
  entry.ms += step.ms ?? 0;
  entry.last = step;
  usage.set(key, entry);
}

function toolUsage(run: TraceRun | undefined): Map<string, RuntimeCall> {
  const usage = new Map<string, RuntimeCall>();
  for (const step of run?.steps ?? []) {
    if (step.kind === "tool" && step.tool) addCall(usage, step.tool, step);
  }
  return usage;
}

function skillUsage(run: TraceRun | undefined): Map<string, RuntimeCall> {
  const usage = new Map<string, RuntimeCall>();
  for (const step of run?.steps ?? []) {
    if (step.kind !== "tool" || step.tool !== "read_skill") continue;
    const target = step.target ?? step.label.replace(/^加载技能\s*/, "");
    const name = target.split("/")[0]?.trim();
    if (name) addCall(usage, name, step);
  }
  return usage;
}

function aggregate(entries: [string, RuntimeCall][]): RuntimeCall | undefined {
  if (!entries.length) return undefined;
  const calls = entries.flatMap(([, call]) => call.calls);
  return {
    calls,
    chars: entries.reduce((sum, [, call]) => sum + call.chars, 0),
    ms: entries.reduce((sum, [, call]) => sum + call.ms, 0),
    last: calls[calls.length - 1]
  };
}

function runtimeMeta(call: RuntimeCall, withTarget: boolean): string {
  const parts = [`${call.calls.length} 次`, formatChars(call.chars)];
  if (withTarget) {
    const target = call.last?.target ?? call.last?.label;
    if (target) parts.push(target);
  }
  return `本轮 ${parts.join(" · ")}`;
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
          {runs.length > 1 ? (
            <div className="trace-runs" aria-label="最近几次运行">
              {runs.map((run) => (
                <button key={run.runId} type="button" className={`trace-run-chip${run.runId === selected?.runId ? " active" : ""}`} title={run.summary ?? ""} onClick={() => setSelectedId(run.runId)}>
                  {sceneLabel(run.scene)} · {shortTime(run.startedAt)}
                </button>
              ))}
            </div>
          ) : null}
          {tab === "trace" ? (selected ? <RunView run={selected} /> : <p className="field-note">还没有运行记录。</p>) : null}
          {tab === "skills" ? <SkillsView surface={surface} error={error} loading={loading} run={selected} /> : null}
          {tab === "tools" ? <ToolsView surface={surface} error={error} loading={loading} run={selected} /> : null}
        </div>
        <div className="modal-foot">
          <span className="modal-note">{tab === "trace" ? "仅本次打开期间" : "只读 · 来自引擎注册表"}</span>
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

function SkillsView({ surface, error, loading, run }: { surface: AgentSurface | null; error: string | null; loading: boolean; run: TraceRun | undefined }): ReactElement {
  if (loading && !surface) return <p className="field-note">正在读取技能清单…</p>;
  if (error) return <p className="field-note">{error}</p>;
  if (!surface) return <p className="field-note">读不到技能清单。</p>;
  const usage = skillUsage(run);
  const installed = new Set(surface.skills.map((skill) => skill.name));
  const attempted = [...usage].filter(([name]) => !installed.has(name));
  return (
    <>
      {!run ? <p className="field-note">还没有运行记录，下面是静态清单。</p> : null}
      {surface.skills.length ? (
        <section className="surface-group">
          <div className="trace-group-head"><span>已装载</span><span className="trace-count">{surface.skills.length}</span></div>
          {surface.skills.map((skill) => {
            const call = usage.get(skill.name);
            const meta = !run ? "" : call ? runtimeMeta(call, true) : "本轮未调用";
            const detail = [skill.description, `目录：${skill.directory}`, call?.last?.target ? `最近：${call.last.target}` : "", call?.last?.detail ?? ""].filter(Boolean).join("\n");
            return <SurfaceRow key={skill.name} title={skill.name} subtitle={skill.description} badge={{ label: "可用", tone: "ok" }} meta={meta} detail={detail} mono />;
          })}
        </section>
      ) : (
        <>
          <p className="field-note">没有装载技能。</p>
          {surface.directories.length ? <p className="field-note">目录：{surface.directories.join("、")}</p> : null}
        </>
      )}
      {attempted.length ? (
        <section className="surface-group">
          <div className="trace-group-head"><span>本轮尝试</span><span className="trace-count">{attempted.length}</span></div>
          {attempted.map(([name, call]) => {
            const found = call.last?.status === "ok";
            return <SurfaceRow key={name} title={name} subtitle={found ? "当前清单里没有这份技能" : "清单里没有这份技能"} badge={{ label: found ? "已读取" : "未找到", tone: found ? "warn" : "off" }} meta={`${call.calls.length} 次`} detail={call.last?.detail ?? ""} mono />;
          })}
        </section>
      ) : null}
      {surface.skillSkipped.length ? (
        <section className="surface-group">
          <div className="trace-group-head"><span>未装载</span><span className="trace-count">{surface.skillSkipped.length}</span></div>
          {surface.skillSkipped.map((entry, index) => <SurfaceRow key={`${entry.dir}-${index}`} title={entry.dir} subtitle={entry.reason} badge={{ label: "跳过", tone: "off" }} mono />)}
        </section>
      ) : null}
    </>
  );
}

function ToolsView({ surface, error, loading, run }: { surface: AgentSurface | null; error: string | null; loading: boolean; run: TraceRun | undefined }): ReactElement {
  if (loading && !surface) return <p className="field-note">正在读取工具清单…</p>;
  if (error) return <p className="field-note">{error}</p>;
  if (!surface) return <p className="field-note">读不到工具清单。</p>;
  const usage = toolUsage(run);
  const staticNames = new Set(surface.tools.map((tool) => tool.name));
  const mcp = [...usage].filter(([name]) => name.startsWith("mcp__"));
  const others = [...usage].filter(([name]) => !name.startsWith("mcp__") && !staticNames.has(name));
  return (
    <>
      {!run ? <p className="field-note">还没有运行记录，下面是静态清单。</p> : null}
      <section className="surface-group">
        <div className="trace-group-head"><span>清单</span><span className="trace-count">{surface.tools.filter((tool) => tool.available).length} 可用</span></div>
        {surface.tools.map((tool) => <ToolRow key={tool.name} tool={tool} calls={tool.external ? aggregate(mcp) : usage.get(tool.name)} hasRun={Boolean(run)} external={tool.external ? mcp : []} />)}
      </section>
      {others.length ? (
        <section className="surface-group">
          <div className="trace-group-head"><span>本轮其他工具</span><span className="trace-count">{others.length}</span></div>
          {others.map(([name, call]) => <SurfaceRow key={name} title={name} subtitle={call.last?.label ?? ""} badge={{ label: "未登记", tone: "warn" }} meta={runtimeMeta(call, false)} detail={call.last?.detail ?? ""} mono />)}
        </section>
      ) : null}
    </>
  );
}

function ToolRow({ tool, calls, hasRun, external }: { tool: AgentToolEntry; calls: RuntimeCall | undefined; hasRun: boolean; external: [string, RuntimeCall][] }): ReactElement {
  const badge: SurfaceBadge = tool.available
    ? tool.conditional ? { label: "按条件", tone: "warn" } : { label: "可用", tone: "ok" }
    : { label: "不可用", tone: "off" };
  const meta = [
    tool.available ? "" : tool.reason ?? "",
    !hasRun ? "" : calls ? runtimeMeta(calls, true) : "本轮未调用"
  ].filter(Boolean).join(" · ");
  const detail = [
    tool.description,
    tool.reason ? `条件：${tool.reason}` : "",
    calls?.last?.target ? `最近：${calls.last.target}` : "",
    calls?.last?.detail ?? "",
    ...(external.length ? ["本轮外部工具：", ...external.map(([name, call]) => `- ${name}：${call.calls.length} 次，${formatChars(call.chars)}`)] : [])
  ].filter(Boolean).join("\n");
  return <SurfaceRow title={tool.name} subtitle={tool.description} badge={badge} meta={meta} detail={detail} mono />;
}

function SurfaceRow({ title, subtitle, badge, meta, detail, mono }: { title: string; subtitle?: string; badge?: SurfaceBadge; meta?: string; detail?: string; mono?: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const content = (
    <>
      <span className="surface-row-main">
        <span className={`surface-row-title${mono ? " mono" : ""}`} title={title}>{title}</span>
        {subtitle ? <span className="surface-row-sub" title={subtitle}>{subtitle}</span> : null}
      </span>
      <span className="surface-row-side">
        {badge ? <span className={`surface-badge ${badge.tone}`}>{badge.label}</span> : null}
        {meta ? <span className="surface-row-meta" title={meta}>{meta}</span> : null}
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
