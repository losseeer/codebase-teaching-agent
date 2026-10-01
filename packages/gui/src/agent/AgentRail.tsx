import { useEffect, useRef, useState, type ReactElement } from "react";
import { Check, Compass, GraduationCap, Pencil, Plus, Send, Square, Trash2, X } from "lucide-react";
import { STYLE_BAND_LABEL, styleBand } from "@codebase-tutor/shared";
import { Markdown } from "./Markdown";
import { LlmSettingsControl } from "./LlmSettings";
import { HEURISTIC_SOURCE, SCOPE_LABEL, type Scope, type ScopedChatApi, type ThreadItem } from "./useScopedChat";

/**
  持久 Agent 侧栏：4 段（scope-bar / scope-context / thread / composer）。
  对应 prototype `design-prototype.html` 中的 `.agent-rail`（第 113-142, 345-358 行）。
  - `scope-bar` 3 个 chip（map / teaching / practice），点击切换作用域
  - `scope-context` 当前作用域的「作用域 / 绑定 / 可见 / 动作」4 行元信息
  - `thread` 滚动消息列表，只含 pushMessage 的对话消息
  - `composer` 按作用域切换 placeholder + 行为；teaching scope 真发 LLM，其他仅做本地草稿

  v0.2 设计依据：开发计划 §1.5「三界面基线」+ 原型 ch8「三条界面约束」（提示用分隔线、反馈用气泡）。
  v0.2 不变项：TutorPage 仅渲染 session-controls + ladder + 锚点 / 成本 chip，所有 chat / composer / 流式订阅均由 AgentRail 拥有。
  */
export function AgentRail({ chat: t }: { chat: ScopedChatApi }): ReactElement {
  const { scope, threads } = t;
  const items = threads[scope];
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** 「贴底跟随」开关：用户手动往上翻回看历史时置 false，新内容就不再把他拽回底部（流式期间尤其恼人）。
      离底 80px 以内视为「仍在看最新一条」，翻回底部即恢复跟随。 */
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = (): void => { stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener("scroll", onScroll);
    return () => { el.removeEventListener("scroll", onScroll); };
  }, []);
  // 切作用域是「跳到另一条对话」，不是用户往上翻——恢复跟随
  useEffect(() => { stickToBottom.current = true; }, [scope]);
  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, scope, t.liveAnswer, t.progress[scope]]);

  const activeBand = styleBand(t.settings.style);
  const { placeholder, canSend, onSend } = composerForScope(scope, t);

  return (
    <aside className="agent-rail" aria-label="Codebase Agent">
      <header className="agent-header">
        <span className="agent-avatar" aria-hidden>✦</span>
        <strong>Codebase Agent</strong>
      </header>

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

      <ThreadBar scope={scope} t={t} />

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
        {scope === "teaching" && items.length === 0 && !t.liveAnswer ? (
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
        {/* 流式正文气泡：三作用域共用——各自请求的 SSE delta（72 字分块回放） */}
        {t.liveAnswer && (
          <div className="message agent streaming">
            <span>Codebase Agent</span>
            <Markdown content={t.liveAnswer} /><i />
          </div>
        )}
        {/* 回复生成过程指示：有流式正文时让位（避免双重提示），只有进度时顶替 */}
        {t.sending && t.progress[scope] && !t.liveAnswer && (
          <div className="message agent streaming" key="agent-progress">
            <span>Codebase Agent</span>
            <p className="agent-progress">{t.progress[scope]}</p><i />
          </div>
        )}
      </div>

      <div className="composer-section">
        {/* 模型入口：一颗胶囊显示「当前模型 · 思考档」，点开弹窗做全部配置（对齐 workbuddy / trae 的位置与形态） */}
        <LlmSettingsControl />
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
            // 生成期间不锁输入框：下一条问题可以预先打进去（发送按钮与 Enter 仍由 canSend 挡住，不会并发发请求）
          />
          {/* 生成中这颗按钮换成「停止」：整轮请求带 turnId，点了引擎就停手（省 token）、连接同时掐掉 */}
          {t.sending ? (
            <button className="primary icon-button" aria-label="停止生成" title="停止生成" type="button" onClick={t.stopTurn}>
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button className="primary icon-button" aria-label="发送消息" title="发送消息" type="submit" disabled={!canSend}>
              <Send size={18} />
            </button>
          )}
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

function composerForScope(scope: Scope, t: ScopedChatApi): { placeholder: string; canSend: boolean; onSend: () => Promise<void> } {  if (scope === "teaching") {
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

function ScopeContext({ scope, t }: { scope: Scope; t: ScopedChatApi }): ReactElement {
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
function boundFor(scope: Scope, t: ScopedChatApi): string {
  if (scope === "map") {
    // 绑定只认三种情形（2026-09-18）：目录里选文件 / 架构视图模块(+其关联文件) / 流程视图环节(+其关联文件)。
    // 不再把默认根节点拼进绑定——那会让「从目录随便打开一个文件」显示成节点「根目录文件」。
    const binding = t.mapBinding;
    if (!binding) return "未绑定";
    if (binding.kind === "file") return `文件 · ${binding.path}`;
    const label = binding.kind === "module" ? "模块" : "环节";
    return binding.path ? `${label}「${binding.title}」 · ${binding.path}` : `${label}「${binding.title}」`;
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

/**
  会话条（当前作用域一份独立列表）：新建 / 切换 / 重命名 / 删除。
  线程正文的真源在引擎库（chat_session + chat_message），这里只是入口——切哪条就按 threadId 回读哪条的历史。
  删除是软删：列表与正文从此看不见，库里的行与 journal 的审计事件都还在，所以二次确认把这话说明白。
  */
function ThreadBar({ scope, t }: { scope: Scope; t: ScopedChatApi }): ReactElement {
  const list = t.chatThreads[scope];
  const currentId = t.currentThreadId[scope];
  const current = list.find((thread) => thread.id === currentId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  if (renaming) {
    return (
      <div className="session-bar renaming">
        <input
          value={draft}
          autoFocus
          aria-label="会话名称"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); setRenaming(false); if (currentId && draft.trim()) void t.renameThread(scope, currentId, draft.trim()); }
            else if (event.key === "Escape") setRenaming(false);
          }}
        />
        <button type="button" onClick={() => { setRenaming(false); if (currentId && draft.trim()) void t.renameThread(scope, currentId, draft.trim()); }}><Check size={14} /></button>
        <button type="button" onClick={() => setRenaming(false)}><X size={14} /></button>
      </div>
    );
  }
  return (
    <div className="session-bar">
      <select
        value={currentId ?? ""}
        aria-label={`切换会话（${SCOPE_LABEL[scope]}）`}
        onChange={(event) => t.switchThread(scope, event.target.value || null)}
      >
        {currentId || list.length ? <option value="">（新会话）</option> : <option value="">还没有会话，直接提问即可新建</option>}
        {list.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
      </select>
      <button type="button" title="新建会话" onClick={() => void t.newThread(scope)}><Plus size={14} /></button>
      <button type="button" title="重命名当前会话" disabled={!currentId} onClick={() => { setDraft(current?.title ?? ""); setRenaming(true); }}><Pencil size={14} /></button>
      <button
        type="button"
        title="删除当前会话"
        disabled={!currentId}
        onClick={() => {
          if (!currentId) return;
          if (!window.confirm(`删除会话「${current?.title ?? ""}」？删除后不可恢复；审计日志仍保留脱敏摘要。`)) return;
          void t.removeThread(scope, currentId);
        }}
      ><Trash2 size={14} /></button>
    </div>
  );
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