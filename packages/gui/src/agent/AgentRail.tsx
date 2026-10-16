import { useEffect, useRef, useState, type ReactElement } from "react";
import { STYLE_BAND_LABEL, styleBand } from "@codebase-tutor/shared";
import { Markdown } from "./Markdown";
import { LlmSettingsControl } from "./LlmSettings";
import { ColumnResizer } from "../ui/ColumnResizer";
import { Icon } from "../ui/icons";
import { HEURISTIC_SOURCE, SCOPE_LABEL, type Scope, type ScopedChatApi, type ThreadItem } from "./useScopedChat";

/**
  持久 Agent 对话栏（对齐 docs/ui-prototype 的 `.rail` 五段）：
  ① 绑定上下文行 → ② 语言风格三档 → ③ 线程条（切换 / 新建 / 重命名 / 软删）→ ④ 消息流 → ⑤ 模型胶囊 + composer。
  - 绑定行 = 当前作用域的**当前**位置（不是历史）：切换作用域/节点/文件只改这一行的值
  - 语言风格是会话级设置，三个作用域共用一份
  - 线程正文的真源在引擎库（chat_session + chat_message），这里只是入口
  - 分工不变：所有 chat / composer / 流式订阅由本栏拥有（状态在 useScopedChat），工作区页面只呈现内容

  收起态由外壳（App）负责：`railCollapsed` 时整栏不渲染，页顶栏那枚 panelRight 是再开入口。
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
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // 切作用域是「跳到另一条对话」，不是用户往上翻——恢复跟随
  useEffect(() => { stickToBottom.current = true; }, [scope]);
  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, scope, t.liveAnswer, t.progress[scope]]);

  const activeBand = styleBand(t.settings.style);
  const { placeholder, canSend, onSend } = composerForScope(scope, t);
  const bound = boundFor(scope, t);
  const unbound = bound.startsWith("未绑定") || bound === "未定位锚点" || bound === "未开始练习";

  return (
    <aside className="rail" aria-label="Codebase Agent">
      {/* 压在左边界上的拖宽条（绝对定位，不占栅格列）：整栏高度都是它的拖动手势 */}
      <ColumnResizer field="railWidth" label="Agent 对话栏" growOn="left" />
      <div className="rail-head">
        <div className="rail-scope">
          <span className="scope-dot" aria-hidden />
          <span className={`scope-text ${unbound ? "unbound" : ""}`}>
            {SCOPE_LABEL[scope]} · <b>{bound}</b>
          </span>
        </div>

        {/* 语言风格：离散三档（2026-09-18 起不再是 0~100 滑块），三作用域共用 */}
        <div className="segmented" role="radiogroup" aria-label="语言风格">
          {STYLE_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={activeBand === choice.band}
              className={activeBand === choice.band ? "active" : ""}
              title={choice.hint}
              onClick={() => t.setSettings({ ...t.settings, style: choice.value })}
            >
              {choice.label}
            </button>
          ))}
        </div>

        <ThreadBar scope={scope} t={t} />

        <div className="thread-meta">
          <span title="三个作用域各记各的对话，互不混在一起">{items.length} 条 · 仅 {SCOPE_LABEL[scope]}</span>
          {t.replySource[scope] ? (
            <span title={t.replySource[scope] === HEURISTIC_SOURCE ? "本次回复由本地启发式模板生成，LLM 未参与（调用失败或未配置）" : `本次回复由 ${t.replySource[scope]} 生成`}>
              来源 · <b>{t.replySource[scope] === HEURISTIC_SOURCE ? "本地启发式" : "LLM"}</b>
            </span>
          ) : null}
        </div>
      </div>

      <div className="rail-msgs" ref={threadRef} aria-live="polite">
        {items.length === 0 && !t.liveAnswer && !t.sending ? <EmptyTurn scope={scope} /> : null}
        {items.map((item) => <ThreadEntry key={item.id} item={item} />)}
        {/* 回复生成过程指示：有流式正文时让位（避免双重提示），只有进度时顶替 */}
        {t.sending && t.progress[scope] && !t.liveAnswer ? (
          <div className="msg msg-agent">
            <div className="msg-hint">{t.progress[scope]}</div>
          </div>
        ) : null}
        {/* 流式正文气泡：三作用域共用——各自请求的 SSE delta（72 字分块回放） */}
        {t.liveAnswer ? (
          <div className="msg msg-agent">
            <div className="msg-bubble msg-streaming"><Markdown content={t.liveAnswer} /></div>
          </div>
        ) : null}
      </div>

      <div className="rail-foot">
        {/* 模型入口：一颗胶囊显示「当前模型 · 思考档 · 风格」，点开弹窗做全部配置 */}
        <LlmSettingsControl styleLabel={STYLE_BAND_LABEL[activeBand]} />
        {t.error ? <p className="error-message">{t.error}</p> : null}
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
            rows={2}
            // 生成期间不锁输入框：下一条问题可以预先打进去（发送按钮与 Enter 仍由 canSend 挡住，不会并发发请求）
          />
          {/* 生成中这颗按钮换成「停止」：整轮请求带 turnId，点了引擎就停手（省 token）、连接同时掐掉 */}
          {t.sending ? (
            <button className="send-btn stop" aria-label="停止生成" title="停止生成" type="button" onClick={t.stopTurn}>
              <Icon name="stop" />
            </button>
          ) : (
            <button className="send-btn" aria-label="发送消息" title="发送消息" type="submit" disabled={!canSend}>
              <Icon name="send" />
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

function composerForScope(scope: Scope, t: ScopedChatApi): { placeholder: string; canSend: boolean; onSend: () => Promise<void> } {
  // 三个作用域的发送条件一致：生成中或空输入都不发
  const canSend = !t.sending && t.content.trim().length > 0;
  if (scope === "teaching") {
    return {
      placeholder: t.selected ? `围绕「${t.selected.title}」说说你的推理；不知道就输入「不知道」` : "说说你的推理；不知道就输入「不知道」",
      canSend,
      onSend: t.send,
    };
  }
  if (scope === "map") {
    return { placeholder: "讨论这个项目的宏观设计…", canSend, onSend: t.sendMap };
  }
  return { placeholder: "对这道练习追问…", canSend, onSend: t.sendPractice };
}

/** 空线程时的一句话指引（原型 `.empty`）：每个作用域问法不同，别写成通用欢迎语。 */
function EmptyTurn({ scope }: { scope: Scope }): ReactElement {
  const hint = scope === "map"
    ? "点模块、环节或目录里的文件，我围绕它展开。"
    : scope === "teaching"
      ? "写下你的观察或疑问；不知道就输入「不知道」。"
      : "只讨论思路，不给标准答案。";
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={scope === "practice" ? "practice" : scope === "map" ? "map" : "book"} size={22} /></span>
      {hint}
    </div>
  );
}

/**
  绑定行 = 当前作用域的**当前**位置（不是历史）：切换作用域/节点/文件只改这一行的值。
  teaching 只显示当前文件的 `path:line`（不累积历史切换）。
 */
function boundFor(scope: Scope, t: ScopedChatApi): string {
  if (scope === "map") {
    // 绑定只认三种情形（2026-09-18）：目录里选文件 / 架构视图模块(+其关联文件) / 流程视图环节(+其关联文件)。
    // 不再把默认根节点拼进绑定——那会让「从目录随便打开一个文件」显示成节点「根目录文件」。
    const binding = t.mapBinding;
    if (!binding) return "未绑定 —— 选中模块 / 环节 / 文件后提问";
    if (binding.kind === "file") return `文件 · ${binding.path}`;
    const label = binding.kind === "module" ? "模块" : "环节";
    return binding.path ? `${label}「${binding.title}」 · ${binding.path}` : `${label}「${binding.title}」`;
  }
  if (scope === "teaching") {
    if (!t.selected) return "未定位锚点";
    const anchor = t.selected.anchors[0];
    return anchor ? `锚点 ${anchor.path}:${anchor.line}` : t.selected.title;
  }
  if (!t.practiceUnit) return "未开始练习";
  const anchor = t.practiceExercise?.anchors[0];
  return anchor ? `${t.practiceUnit} · ${anchor.path}:${anchor.line}` : t.practiceUnit;
}

/**
  会话条（当前作用域一份独立列表）：新建 / 切换 / 重命名 / 删除。
  切哪条就按 threadId 回读哪条的历史。删除是软删：列表与正文从此看不见，
  库里的行与 journal 的审计事件（session_deleted）都还在，所以二次确认把这话说明白。
 */
function ThreadBar({ scope, t }: { scope: Scope; t: ScopedChatApi }): ReactElement {
  const list = t.chatThreads[scope];
  const currentId = t.currentThreadId[scope];
  const current = list.find((thread) => thread.id === currentId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  if (renaming) {
    return (
      <div className="thread-bar">
        <input
          className="text-input"
          value={draft}
          autoFocus
          aria-label="会话名称"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); setRenaming(false); if (currentId && draft.trim()) void t.renameThread(scope, currentId, draft.trim()); }
            else if (event.key === "Escape") setRenaming(false);
          }}
        />
        <button type="button" className="icon-btn" aria-label="确认改名" onClick={() => { setRenaming(false); if (currentId && draft.trim()) void t.renameThread(scope, currentId, draft.trim()); }}><Icon name="check" size={14} /></button>
        <button type="button" className="icon-btn" aria-label="取消改名" onClick={() => setRenaming(false)}><Icon name="x" size={14} /></button>
      </div>
    );
  }
  return (
    <div className="thread-bar">
      <div className="thread-select-wrap">
        <select
          className="select"
          value={currentId ?? ""}
          aria-label={`切换会话（${SCOPE_LABEL[scope]}）`}
          onChange={(event) => t.switchThread(scope, event.target.value || null)}
        >
          {currentId || list.length ? <option value="">（新会话）</option> : <option value="">还没有会话，直接提问即可新建</option>}
          {list.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </select>
      </div>
      <button type="button" className="icon-btn" title="新建会话" aria-label="新建会话" onClick={() => void t.newThread(scope)}><Icon name="plus" size={14} /></button>
      <button type="button" className="icon-btn" title="重命名当前会话" aria-label="重命名当前会话" disabled={!currentId} onClick={() => { setDraft(current?.title ?? ""); setRenaming(true); }}><Icon name="edit" size={14} /></button>
      <button
        type="button"
        className="icon-btn"
        title="删除当前会话（软删）"
        aria-label="删除当前会话"
        disabled={!currentId}
        onClick={() => {
          if (!currentId) return;
          if (!window.confirm(`删除会话「${current?.title ?? ""}」？删除后不可恢复；审计日志仍保留脱敏摘要。`)) return;
          void t.removeThread(scope, currentId);
        }}
      ><Icon name="trash" size={14} /></button>
    </div>
  );
}

/** thread 单条消息：用户消息纯文本气泡；agent 正文走 Markdown；error/hint 变体不进 Markdown。 */
function ThreadEntry({ item }: { item: ThreadItem }): ReactElement {
  const agent = item.kind === "agent" ? item : null;
  const variant = agent?.variant;
  const body = agent && !variant ? <Markdown content={agent.text} /> : agent ? agent.text : item.text;
  const tone = variant === "error" ? " error" : variant === "hint" ? " hint" : "";
  return (
    <div className={`msg msg-${agent ? "agent" : "user"}`}>
      <div className={`msg-bubble${tone}`}>{body}</div>
    </div>
  );
}
