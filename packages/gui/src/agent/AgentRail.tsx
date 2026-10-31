
import {useEffect, useRef, useState, type ReactElement } from "react";
import { Markdown } from "./Markdown";
import { LlmSettingsControl } from "./LlmSettings";
import { ColumnResizer } from "../ui/ColumnResizer";
import { DangerDialog } from "../ui/DangerDialog";
import { Icon } from "../ui/icons";
import { SCOPE_LABEL, type Scope } from "./chatScope";
import type { ScopedChatApi } from "./scopedChatApi";
import type { ThreadItem } from "./threadItems";

/** 持久 Agent 对话栏：绑定行 → 风格 → 线程条 → 消息流 → composer。状态都在 useScopedChat。 */
export function AgentRail({ chat: t }: { chat: ScopedChatApi }): ReactElement {
  const { scope, threads } = t;
  const items = threads[scope];
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** 是否贴底跟随：用户上翻解除，翻回底部恢复。 */
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = (): void => { stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // 切作用域不是用户上翻，恢复跟随
  useEffect(() => { stickToBottom.current = true; }, [scope]);
  useEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, scope, t.liveAnswer, t.progress[scope]]);

  const { placeholder, canSend, onSend } = composerForScope(scope, t);
  const bound = boundFor(scope, t);
  const unbound = bound.startsWith("未绑定") || bound === "未定位锚点" || bound === "未开始练习";

  return (
    <aside className="rail" aria-label="Codebase Agent">
      {/* 拖宽条：绝对定位，不占栅格列 */}
      <ColumnResizer field="railWidth" label="Agent 对话栏" growOn="left" />
      <div className="rail-head">
        <div className="rail-scope">
          <span className="scope-dot" aria-hidden />
          <span className={`scope-text ${unbound ? "unbound" : ""}`}>
            {SCOPE_LABEL[scope]} · <b>{bound}</b>
          </span>
        </div>

        <ThreadBar scope={scope} t={t} />

        <div className="thread-meta">
          <span title="每个标签页各记一份对话">{items.length} 条 · 仅 {SCOPE_LABEL[scope]}</span>
          {t.replySource[scope] ? <span title={`本次回复由 ${t.replySource[scope]} 生成`}>来源 · <b>LLM</b></span> : null}
        </div>
      </div>

      <div className="rail-msgs" ref={threadRef} aria-live="polite">
        {items.length === 0 && !t.liveAnswer && !t.sending ? <EmptyTurn scope={scope} /> : null}
        {items.map((item) => <ThreadEntry key={item.id} item={item} onOpenDiagram={t.requestOpenDiagram} onAnswer={(text, askId) => { void t.sendMap(text, askId); }} onRetry={(text) => { void t.sendMap(text); }} answerable={!t.sending} liveAskId={t.liveAsk[scope]} />)}
        {/* 过程指示：有流式正文时让位，避免双重提示 */}
        {t.sending && t.progress[scope].length > 0 && !t.liveAnswer ? (
          <div className="msg msg-agent">
            {t.progress[scope].map((line, index) => (
              <div key={`${index}-${line}`} className={index === t.progress[scope].length - 1 ? "msg-hint" : "msg-past"}>{line}</div>
            ))}
          </div>
        ) : null}
        {/* 流式正文气泡 */}
        {t.liveAnswer ? (
          <div className="msg msg-agent">
            <div className="msg-bubble msg-streaming"><Markdown content={t.liveAnswer} /></div>
          </div>
        ) : null}
      </div>

      <div className="rail-foot">
        {/* 模型设置胶囊入口 */}
        <LlmSettingsControl />
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
              // 输入法组合中的回车不提交
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && canSend) {
                event.preventDefault();
                void onSend();
              }
            }}
            placeholder={placeholder}
            aria-label="与 Codebase Agent 对话"
            rows={2}
            // 生成期间不锁输入框，可预打下一条
          />
          {/* 生成中按钮为「停止」 */}
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

function composerForScope(scope: Scope, t: ScopedChatApi): { placeholder: string; canSend: boolean; onSend: () => Promise<void> } {
  const canSend = !t.sending && t.content.trim().length > 0;
  if (scope === "teaching") {
    return {
      placeholder: t.scopeRef ? `围绕「${t.scopeLabel}」说说你的推理` : "先在左栏选一个文件或目录，再说说你的推理",
      canSend,
      onSend: t.send,
    };
  }
  if (scope === "map") {
    return { placeholder: "讨论这个项目的宏观设计…", canSend, onSend: t.sendMap };
  }
  return { placeholder: "对这道练习追问…", canSend, onSend: t.sendPractice };
}

/** 空线程的一句话指引，按作用域不同。 */
function EmptyTurn({ scope }: { scope: Scope }): ReactElement {
  const hint = scope === "map"
    ? "点模块、环节或目录里的文件，我围绕它展开。"
    : scope === "teaching"
      ? "写下你的观察或疑问"
      : "只讨论思路，不给标准答案。";
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={scope === "practice" ? "practice" : scope === "map" ? "map" : "book"} size={22} /></span>
      {hint}
    </div>
  );
}

/** 绑定行 = 当前作用域的当前位置，不累积历史。 */
function boundFor(scope: Scope, t: ScopedChatApi): string {
  if (scope === "map") {
    const binding = t.mapBinding;
    if (!binding) return t.openDiagram ? `当前图 · ${t.openDiagram.name}` : "未选中节点 / 文件";
    if (binding.kind === "file") return `文件 · ${binding.path}`;
    return binding.path ? `节点「${binding.title}」 · ${binding.path}` : `节点「${binding.title}」`;
  }
  if (scope === "teaching") {
    if (!t.scopeRef) return "还没选文件";
    return `${t.scopeRef.startsWith("dir:") ? "目录" : "文件"} · ${t.scopeRef.slice(t.scopeRef.indexOf(":") + 1)}`;
  }
  if (!t.practiceUnit) return "未开始练习";
  const anchor = t.practiceExercise?.anchors[0];
  return anchor ? `${t.practiceUnit} · ${anchor.path}:${anchor.line}` : t.practiceUnit;
}

/**
  会话条：新建/切换/重命名/软删，每作用域一份独立列表。
  下拉只列已发言会话；未发言的占「（新会话）」一格。
 */
function ThreadBar({ scope, t }: { scope: Scope; t: ScopedChatApi }): ReactElement {
  const list = t.chatThreads[scope];
  const currentId = t.currentThreadId[scope];
  const current = list.find((thread) => thread.id === currentId);
  // 未发言的不在清单里，需留一格，否则 select 显示成第一条
  const unsent = Boolean(currentId) && !current;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState(false);
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
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); setRenaming(false); if (currentId && draft.trim()) void t.renameThread(scope, currentId, draft.trim()); }
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
          title="只列谈过的会话"
          onChange={(event) => t.switchThread(scope, event.target.value || null)}
        >
          {!currentId ? <option value="">（新会话）</option> : null}
          {unsent ? <option value={currentId ?? ""}>（新会话）</option> : null}
          {list.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </select>
      </div>
      <button type="button" className="icon-btn" title="新建会话" aria-label="新建会话" onClick={() => t.newThread(scope)}><Icon name="plus" size={14} /></button>
      <button type="button" className="icon-btn" title="重命名当前会话" aria-label="重命名当前会话" disabled={!currentId} onClick={() => { setDraft(current?.title ?? ""); setRenaming(true); }}><Icon name="edit" size={14} /></button>
      <button
        type="button"
        className="icon-btn"
        title="删除当前会话"
        aria-label="删除当前会话"
        disabled={!currentId}
        onClick={() => setPendingDelete(true)}
      ><Icon name="trash" size={14} /></button>
      {pendingDelete && currentId ? (
        <DangerDialog
          title="删除这条会话"
          body={`「${current?.title ?? ""}」的提问与回答从此看不见；本机记录仍留一份脱敏摘要。`}
          deleteLabel={`删除「${current?.title ?? "当前会话"}」`}
          onDelete={() => { setPendingDelete(false); void t.removeThread(scope, currentId); }}
          onClose={() => setPendingDelete(false)}
        />
      ) : null}
    </div>
  );
}

/** thread 单条消息：agent 正文走 Markdown，error/hint 变体不走。 */
function ThreadEntry({ item, onOpenDiagram, onAnswer, onRetry, answerable, liveAskId }: { item: ThreadItem; onOpenDiagram?: (diagram: { id: string; name: string }) => void; onAnswer?: (text: string, askId?: string) => void; onRetry?: (text: string) => void; answerable?: boolean; liveAskId?: string | null }): ReactElement {
  const agent = item.kind === "agent" ? item : null;
  const variant = agent?.variant;
  const body = agent && !variant ? <Markdown content={agent.text} /> : agent ? agent.text : item.text;
  const tone = variant === "error" ? " error" : variant === "hint" ? " hint" : variant === "ask" ? " ask" : variant === "warn" ? " warn" : "";
  const card = agent?.card;
  const options = agent?.options;
  // 卡片消息无正文时只出卡片，不撑空气泡
  if (card && !agent?.text) {
    return (
      <div className="msg msg-agent" style={{ alignSelf: "stretch" }}>
        <button type="button" className="dg-card" title={`在画布打开「${card.name}」`} onClick={() => onOpenDiagram?.({ id: card.diagramId, name: card.name })}>
          <span className="dg-card-thumb">图</span>
          <span className="col" style={{ gap: 0, minWidth: 0 }}>
            <b className="fs-12">{card.name}</b>
            <span className="fs-11 link">在画布打开 ↗</span>
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className={`msg msg-${agent ? "agent" : "user"}`}>
      <div className={`msg-bubble${tone}`}>{body}</div>
      {/* 提问候选只在待答的那一句上出现 */}
      {options?.length && answerable && item.id === liveAskId ? (
        <div className="msg-asks" role="group" aria-label="选一个答回去">
          {options.map((option) => (
            <button key={option} type="button" className="btn btn-sm btn-ghost" onClick={() => onAnswer?.(option, agent?.askId)}>{option}</button>
          ))}
        </div>
      ) : null}
      {/* 中断轮的进度行 */}
      {agent?.lines?.length ? (
        <div className="col">
          {agent.lines.map((line, index) => <div key={`${index}-${line}`} className="msg-past">{line}</div>)}
        </div>
      ) : null}
      {/* 重试：原样重发那句 */}
      {agent?.retry && answerable ? (
        <button type="button" className="btn btn-sm btn-ghost" title="原样再发一次，接着上次读到的地方继续" onClick={() => onRetry?.(agent.retry ?? "")}>重试</button>
      ) : null}
      {card ? (
        <button type="button" className="dg-card" title={`在画布打开「${card.name}」`} onClick={() => onOpenDiagram?.({ id: card.diagramId, name: card.name })}>
          <span className="dg-card-thumb">图</span>
          <span className="col" style={{ gap: 0, minWidth: 0 }}>
            <b className="fs-12">{card.name}</b>
            <span className="fs-11 link">在画布打开 ↗</span>
          </span>
        </button>
      ) : null}
    </div>
  );
}
