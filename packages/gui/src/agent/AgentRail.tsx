import { useEffect, useRef, useState, type ReactElement } from "react";
import { CheckCircle2, Clock3, Code2, Compass, GraduationCap, ListChecks, RefreshCw, Send, X } from "lucide-react";
import { STYLE_BAND_LABEL, styleBand } from "@codebase-tutor/shared";
import { companionKindLabel } from "../views/helpers";
import { Markdown } from "./Markdown";
import { api, type LlmSettings, type ThinkingEffort } from "../api/client";
import { showToast } from "../modules/toast";
import { HEURISTIC_SOURCE, SCOPE_LABEL, SCOPES, type Scope, type TeachingSessionApi, type ThreadItem } from "./useTeachingSession";

/**
  持久 Agent 侧栏：4 段（scope-bar / scope-context / thread / composer）。
  对应 prototype `design-prototype.html` 中的 `.agent-rail`（第 113-142, 345-358 行）。
  - `scope-bar` 3 个 chip（map / teaching / practice），点击切换作用域
  - `scope-context` 当前作用域的「作用域 / 绑定 / 可见 / 动作」4 行元信息
  - `thread` 滚动消息列表，只含 pushMessage 的对话消息 / 伴侣建议（teaching scope）
  - `composer` 按作用域切换 placeholder + 行为；teaching scope 真发 LLM，其他仅做本地草稿

  v0.2 设计依据：开发计划 §1.5「三界面基线」+ 原型 ch8「三条界面约束」（提示用分隔线、反馈用气泡）。
  v0.2 不变项：TutorPage 仅渲染 session-controls + ladder + 锚点 / 成本 chip，所有 chat / composer / 流式订阅均由 AgentRail 拥有。
  */
export function AgentRail({ session: t }: { session: TeachingSessionApi }): ReactElement {
  const { scope, threads } = t;
  const items = threads[scope];
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [items.length, scope, t.liveAnswer, t.progress[scope]]);

  // LLM 运行时设置：进侧栏时拉取，改动立即 PUT 引擎（乐观更新，失败回滚提示）
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  useEffect(() => {
    let current = true;
    api.getLlmSettings().then((next) => { if (current) setLlm(next); }).catch(() => undefined);
    return () => { current = false; };
  }, []);
  const updateLlm = (partial: { model?: string; thinking?: ThinkingEffort }): void => {
    if (!llm) return;
    const previous = llm;
    setLlm({ ...llm, ...partial });
    api.updateLlmSettings(partial)
      .then((next) => setLlm(next))
      .catch((error: unknown) => {
        setLlm(previous);
        // 引擎 422（如思考档位与新模型不兼容）会带具体原因，优先透传而不是笼统的「失败」
        showToast(error instanceof Error && error.message ? error.message : "LLM 设置更新失败");
      });
  };

  const activeBand = styleBand(t.settings.style);
  const { placeholder, canSend, onSend } = composerForScope(scope, t);

  return (
    <aside className="agent-rail" aria-label="Codebase Agent">
      <header className="agent-header">
        <span className="agent-avatar" aria-hidden>✦</span>
        <strong>Codebase Agent</strong>
      </header>

      <div className="scope-bar" role="tablist" aria-label="切换作用域">
        {SCOPES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={scope === s}
            className={`scope-chip ${scope === s ? "active" : ""}`}
            onClick={() => t.setScope(s)}
          >
            <ScopeIcon scope={s} /> {SCOPE_LABEL[s]}
          </button>
        ))}
      </div>

      <ScopeContext scope={scope} t={t} />

      {/* 语言风格：会话级设置，三个作用域共用；离散三档（2026-09-18 起不再是 0~100 滑块） */}
      <div className="agent-tuning">
        <div className="tuning-head"><span>语言风格</span><output>{STYLE_BAND_LABEL[activeBand]}</output></div>
        <div className="segmented" role="radiogroup" aria-label="语言风格">
          {STYLE_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={activeBand === choice.band}
              className={activeBand === choice.band ? "selected" : ""}
              title={choice.hint}
              onClick={() => t.setSettings({ ...t.settings, style: choice.value })}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>

      {/* 模型与思考：运行时设置（引擎内存态，PUT 即时生效，重启回落 .env）。
          只有一套模型配置；轻任务（推荐入口/题面/命名/L1 摘要）走同一模型、思考固定 off，无需单独配置。 */}
      <div className="agent-tuning llm-tuning">
        <div className="tuning-head"><span>模型与思考</span></div>
        <label className="tuning-row">
          <span>模型</span>
          <select
            value={llm?.model ?? ""}
            disabled={!llm}
            aria-label="LLM 模型"
            onChange={(event) => updateLlm({ model: event.target.value })}
          >
            <option value="">默认（.env）</option>
            {modelOptions(llm, llm?.model ?? "").map((slug) => <option key={slug} value={slug}>{slug}</option>)}
          </select>
        </label>
        <label className="tuning-row">
          <span>思考</span>
          <select
            value={llm?.thinking ?? "auto"}
            disabled={!llm}
            aria-label="思考模式与强度"
            title={THINKING_STYLE_HINT[llm?.thinkingCapability?.style ?? "unknown"]}
            onChange={(event) => updateLlm({ thinking: event.target.value as ThinkingEffort })}
          >
            <option value="auto">自动（模型默认）</option>
            {(["off", "low", "high", "max"] as const).map((effort) => (
              <option
                key={effort}
                value={effort}
                // 引擎按模型查表下发能力声明；老引擎没有该字段时全部可用（向后兼容）。
                // off 对 none/unknown 样式恒可选（= 不发字段），与引擎 PUT 校验的豁免一致。
                disabled={llm?.thinkingCapability ? !effortSelectable(llm.thinkingCapability, effort) : false}
              >
                {THINKING_EFFORT_LABEL[effort]}
              </option>
            ))}
          </select>
        </label>
        {llm?.thinkingCapability ? (
          <p className="tuning-hint">{thinkingHint(llm.thinkingCapability)}</p>
        ) : null}
      </div>

      <div className="thread-meta">
        <span>作用域 · <b>{SCOPE_LABEL[scope]}</b></span>
        {t.replySource[scope] ? (
          <span title={t.replySource[scope] === HEURISTIC_SOURCE ? "本次回复由本地启发式模板生成，LLM 未参与（调用失败或未配置）" : `本次回复由 ${t.replySource[scope]} 生成`}>
            来源 · <b>{t.replySource[scope] === HEURISTIC_SOURCE ? "本地启发式" : "LLM"}</b>
          </span>
        ) : null}
        <span>{items.length} 条 · 本作用域独立记录</span>
      </div>

      <div className="agent-thread" id="agent-thread" ref={threadRef} aria-live="polite">
        {items.length === 0 && scope === "teaching" && !t.liveAnswer && !t.suggestions.length ? (
          <div className="starter">
            <GraduationCap size={22} />
            <p>先写下你对这个节点的一个观察或假设，或输入「不知道」请求下一层提示。</p>
          </div>
        ) : null}
        {items.length === 0 && scope !== "teaching" ? (
          <div className="starter">
            <Compass size={22} />
            <p>{scope === "map" ? "点流程节点或目录文件，再开始提问。" : "在左栏选一个模块与练习，再对这道题追问。"}</p>
          </div>
        ) : null}
        {items.map((item) => <ThreadEntry key={item.id} item={item} />)}
        {scope === "teaching" && t.liveAnswer && (
          <div className="message agent streaming">
            <span>Codebase Agent</span>
            <Markdown content={t.liveAnswer} /><i />
          </div>
        )}
        {/* 回复生成过程指示：teaching 有流式正文时让位（避免双重提示），其余作用域全程显示 */}
        {t.sending && t.progress[scope] && !(scope === "teaching" && t.liveAnswer) && (
          <div className="message agent streaming" key="agent-progress">
            <span>Codebase Agent</span>
            <p className="agent-progress">{t.progress[scope]}</p><i />
          </div>
        )}
        {scope === "teaching" && t.suggestions.map((s) => (
          <article className="companion-card thread-card" key={s.id}>
            <div className="companion-heading"><span>{companionKindLabel(s.kind)}</span><strong>{s.title}</strong></div>
            <Markdown content={s.body} />
            {s.anchors.length ? (
              <div className="companion-anchors">
                {s.anchors.slice(0, 2).map((a) => <span key={`${a.path}:${a.line}`}><Code2 size={12} />{a.path}:{a.line}</span>)}
              </div>
            ) : null}
            <div className="companion-actions">
              <button className="primary icon-button" aria-label="接受建议" title="接受建议" onClick={() => void t.actOnSuggestion(s, "accepted")}><CheckCircle2 size={17} /></button>
              <button className="secondary icon-button" aria-label="稍后处理" title="稍后处理" onClick={() => void t.actOnSuggestion(s, "later")}><Clock3 size={17} /></button>
              <button className="secondary icon-button" aria-label="忽略建议" title="忽略建议" onClick={() => void t.actOnSuggestion(s, "dismissed")}><X size={17} /></button>
            </div>
          </article>
        ))}
      </div>

      <div className="composer-section">
        {t.error && <p className="error-message">{t.error}</p>}
        <form
          className="composer"
          onSubmit={(event) => { event.preventDefault(); void onSend(); }}
          aria-label={`与 Codebase Agent 对话（${SCOPE_LABEL[scope]}）`}
        >
          <textarea
            value={t.content}
            onChange={(event) => t.setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && canSend) {
                event.preventDefault();
                void onSend();
              }
            }}
            placeholder={placeholder}
            aria-label="与 Codebase Agent 对话"
            rows={3}
            disabled={t.sending}
          />
          <button className="primary icon-button" aria-label="发送消息" title="发送消息" type="submit" disabled={!canSend}>
            {t.sending ? <RefreshCw className="spin" size={18} /> : <Send size={18} />}
          </button>
        </form>
      </div>
    </aside>
  );
}

/** 离散三档语言风格：通俗=可用类比举例讲直观；普通=中性准确；严肃=工程严谨、不用类比。值对应 styleBand 阈值（100/50/0）。 */
const STYLE_CHOICES = [
  { value: 100, band: "plain" as const, label: "通俗", hint: "多用类比和例子，把原理讲得直观易懂" },
  { value: 50, band: "neutral" as const, label: "普通", hint: "中性、准确，术语照常使用" },
  { value: 0, band: "rigorous" as const, label: "严肃", hint: "工程术语、严谨论证，不用类比" }
] as const;

/** 下拉选项：.env 预设 + 当前已选的自定义 slug（不在预设里也要可见）。 */
function modelOptions(settings: LlmSettings | null, current: string): string[] {
  const presets = settings?.presets ?? [];
  return current && !presets.includes(current) ? [...presets, current] : presets;
}

const THINKING_EFFORT_LABEL: Record<"off" | "low" | "high" | "max", string> = {
  off: "关闭",
  low: "低",
  high: "高",
  max: "最大"
};

/** 各能力样式的下拉 title 提示（悬停可见）。 */
const THINKING_STYLE_HINT: Record<string, string> = {
  deepseek: "DeepSeek 格式：thinking 开关 + reasoning_effort（V4 默认开启思考）",
  openai: "OpenAI 格式：顶层 reasoning_effort（GPT-5 / o 系 / Gemini 兼容层）",
  anthropic: "Anthropic 兼容层：仅 thinking 开关，无强度档位",
  none: "该模型没有思考参数",
  unknown: "未识别的模型：auto/off 不发字段；强度档位会被引擎拒绝（可用 TUTOR_THINKING_STYLES 声明）"
};

/** 思考档位下方的常驻能力提示行。 */
function thinkingHint(capability: NonNullable<LlmSettings["thinkingCapability"]>): string {
  const styleName: Record<string, string> = {
    deepseek: "DeepSeek 格式",
    openai: "reasoning_effort",
    anthropic: "仅开关（无强度）",
    none: "无思考参数",
    unknown: "未声明思考能力"
  };
  const supported = (["off", "low", "high", "max"] as const).filter((effort) => effortSelectable(capability, effort)).map((effort) => THINKING_EFFORT_LABEL[effort]);
  return `${capability.model} · ${styleName[capability.style] ?? capability.style} · 支持：${supported.length ? supported.join(" / ") : "无"}`;
}

/** off 恒可表达：无思考参数/未声明模型选 off = 不发字段（与引擎 applyThinking 语义一致，不算「支持」也不禁用）。 */
function effortSelectable(capability: NonNullable<LlmSettings["thinkingCapability"]>, effort: "off" | "low" | "high" | "max"): boolean {
  if (capability.efforts.includes(effort)) return true;
  return effort === "off" && (capability.style === "none" || capability.style === "unknown");
}

function composerForScope(scope: Scope, t: TeachingSessionApi): { placeholder: string; canSend: boolean; onSend: () => Promise<void> } {  if (scope === "teaching") {
    return {
      placeholder: t.selected ? `围绕「${t.selected.title}」描述你的推理，或输入「不知道」请求下一层提示` : "描述你的推理，或输入「不知道」请求下一层提示",
      canSend: !t.sending && t.content.trim().length > 0,
      onSend: t.send,
    };
  }
  if (scope === "map") {
    return {
      placeholder: "讨论这个项目的宏观设计…",
      canSend: !t.sending && t.content.trim().length > 0,
      onSend: t.sendMap,
    };
  }
  return {
    placeholder: "对这道练习追问…",
    canSend: !t.sending && t.content.trim().length > 0,
    onSend: t.sendPractice,
  };
}

function ScopeContext({ scope, t }: { scope: Scope; t: TeachingSessionApi }): ReactElement {
  const bound = boundFor(scope, t);
  return (
    <div className="scope-context" id="scope-context">
      <div><span>绑定</span><code>{bound}</code></div>
    </div>
  );
}

/**
  绑定行 = 当前作用域的**当前**位置（不是历史）。
  切换作用域/节点/文件只改这一行的值——不再往线程里追加「已切换到 / 已定位」分隔线（v0.8.1）。
  teaching 只显示当前文件的 `path:line`（与原型 `binds.teaching` 一致，不累积历史切换）。
  */
function boundFor(scope: Scope, t: TeachingSessionApi): string {
  if (scope === "map") {
    const node = t.mapNode ?? t.course?.root;
    if (!node) return "未加载课程";
    return `节点「${node.title}」${t.mapFile ? ` · ${t.mapFile}` : ""}`;
  }
  if (scope === "teaching") {
    if (!t.selected) return "未选择节点";
    const anchor = t.selected.anchors[0];
    return anchor ? `${anchor.path}:${anchor.line}` : t.selected.title;
  }
  if (!t.practiceUnit) return "未开始练习";
  const anchor = t.practiceExercise?.anchors[0];
  return anchor ? `${t.practiceUnit} · ${anchor.path}:${anchor.line}` : t.practiceUnit;
}

function ScopeIcon({ scope }: { scope: Scope }): ReactElement {
  if (scope === "map") return <Compass size={12} />;
  if (scope === "teaching") return <GraduationCap size={12} />;
  return <ListChecks size={12} />;
}

/** thread 单条消息渲染：用户消息纯文本（pre-wrap 由 .message p 提供）；
  agent 正文走 Markdown；error/hint 变体用样式类标注，不进 Markdown。 */
function ThreadEntry({ item }: { item: ThreadItem }): ReactElement {
  const body = item.kind === "agent" && !item.variant
    ? <Markdown content={item.text} />
    : <p className={item.kind === "agent" ? `plain-${item.variant}` : undefined}>{item.text}</p>;
  return (
    <div className={`message ${item.kind}`}>
      <span>{item.kind === "user" ? "你" : "Codebase Agent"}</span>
      {body}
    </div>
  );
}