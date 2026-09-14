import { useEffect, useRef, type ReactElement } from "react";
import { CheckCircle2, Clock3, Code2, Compass, GraduationCap, ListChecks, RefreshCw, Send, X } from "lucide-react";
import { companionKindLabel } from "../views/helpers";
import { SCOPE_LABEL, SCOPES, type Scope, type TeachingSessionApi } from "./useTeachingSession";

/**
  持久 Agent 侧栏：4 段（scope-bar / scope-context / thread / composer）。
  对应 prototype `design-prototype.html` 中的 `.agent-rail`（第 113-142, 345-358 行）。
  - `scope-bar` 3 个 chip（map / teaching / practice），点击切换并 pushDivider
  - `scope-context` 当前作用域的「作用域 / 绑定 / 可见 / 动作」4 行元信息
  - `thread` 滚动消息列表，含 pushDivider / pushMessage / 伴侣建议（teaching scope）
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
  }, [items.length, scope, t.liveAnswer]);

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

      {/* 语言风格：会话级设置，三个作用域共用（v0.5.3 起不再仅 teaching 可见） */}
      <div className="agent-tuning">
        <div className="tuning-head"><span>语言风格</span><output>{t.settings.style}</output></div>
        <input
          className="style-slider"
          type="range"
          min={0}
          max={100}
          value={t.settings.style}
          aria-label="语言风格"
          onChange={(event) => t.setSettings({ ...t.settings, style: Number(event.target.value) })}
        />
        <div className="range-labels"><span>严肃</span><span>通俗</span></div>
      </div>

      <div className="thread-meta">
        <span>作用域 · <b>{SCOPE_LABEL[scope]}</b></span>
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
            <p>{scope === "map" ? "在文件树切换节点，会自动在此记录「已切换到 / 已选中」。" : "在练习页提交答案后，判分与下一步建议会出现在这里。"}</p>
          </div>
        ) : null}
        {items.map((item) => item.kind === "divider" ? (
          <div className="thread-divider" key={item.id}><span dangerouslySetInnerHTML={{ __html: item.html }} /></div>
        ) : (
          <div className={`message ${item.kind}`} key={item.id}>
            <span>{item.kind === "user" ? "你" : "Codebase Agent"}</span>
            <p dangerouslySetInnerHTML={{ __html: item.html }} />
          </div>
        ))}
        {scope === "teaching" && t.liveAnswer && (
          <div className="message agent streaming">
            <span>Codebase Agent</span>
            <p dangerouslySetInnerHTML={{ __html: escapeHtml(t.liveAnswer) }} /><i />
          </div>
        )}
        {scope === "teaching" && t.suggestions.map((s) => (
          <article className="companion-card thread-card" key={s.id}>
            <div className="companion-heading"><span>{companionKindLabel(s.kind)}</span><strong>{s.title}</strong></div>
            <p dangerouslySetInnerHTML={{ __html: escapeHtml(s.body) }} />
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

function composerForScope(scope: Scope, t: TeachingSessionApi): { placeholder: string; canSend: boolean; onSend: () => Promise<void> } {
  if (scope === "teaching") {
    return {
      placeholder: t.selected ? `围绕「${t.selected.title}」描述你的推理，或输入「不知道」请求下一层提示` : "描述你的推理，或输入「不知道」请求下一层提示",
      canSend: !t.sending && t.content.trim().length > 0,
      onSend: t.send,
    };
  }
  if (scope === "map") {
    return {
      placeholder: "讨论这个项目的宏观设计…（记录为草稿笔记）",
      canSend: !t.sending && t.content.trim().length > 0,
      onSend: async () => { t.pushMessage("map", "user", escapeHtml(t.content.trim())); t.setContent(""); },
    };
  }
  return {
    placeholder: "对这道练习追问…（记录为草稿笔记）",
    canSend: !t.sending && t.content.trim().length > 0,
    onSend: async () => { t.pushMessage("practice", "user", escapeHtml(t.content.trim())); t.setContent(""); },
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

function boundFor(scope: Scope, t: TeachingSessionApi): string {
  if (scope === "map") {
    const node = t.mapNode ?? t.course?.root;
    if (!node) return "未加载课程";
    return `节点「${node.title}」${t.mapFile ? ` · ${t.mapFile}` : ""}`;
  }
  if (scope === "teaching") return t.selected ? t.selected.title : "未选择节点";
  return t.practiceUnit || "未开始练习";
}

function ScopeIcon({ scope }: { scope: Scope }): ReactElement {
  if (scope === "map") return <Compass size={12} />;
  if (scope === "teaching") return <GraduationCap size={12} />;
  return <ListChecks size={12} />;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === "\"") return "&quot;";
    return "&#39;";
  });
}