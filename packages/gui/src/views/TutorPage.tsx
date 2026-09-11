import { useEffect, useRef, useState, type ReactElement } from "react";
import { BarChart3, Code2, MessageCircleQuestion, RefreshCw, Send } from "lucide-react";
import type { CostSummary, CourseTree, DecompositionDepth, FadedState, LearnerProfile, Pedagogy, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import { EmptyState, Loading, Segmented, firstTeachNode, flatten, stageIndex } from "./helpers";

/**
 * 教学会话工作区（苏格拉底式）：
 * - 左栏：三维调节（风格光谱 0-100 / 教学法 / 拆解层次）+ 教学阶梯（L1→L5）+ 锚点 + 成本 chip
 * - 右栏：聊天面板（用户消息 / 导师消息 / 流式 liveAnswer / composer）
 *
 * 与 prototype 的差异：
 * - prototype 是「共享主区 + Agent 侧栏」，3 个工作区共用 Agent rail
 * - 当前 GUI 是路由切换，每页有自己的 composer（更简单但与 §1.5 不一致）
 * - v0.2+ 应按 prototype 把 Agent rail 抽到 agent/，3 工作区共享
 */

export function TutorPage({ workspace }: { workspace: Workspace }): ReactElement {
  const [course, setCourse] = useState<CourseTree | null>(null);
  const [selected, setSelected] = useState<ReturnType<typeof firstTeachNode> | null>(null);
  const [session, setSession] = useState<TutorSession | null>(null);
  const [settings, setSettings] = useState<TutorSettings>({ style: 50, pedagogy: "socratic", depth: "macro" });
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [error, setError] = useState("");
  const [learner, setLearner] = useState<LearnerProfile | null>(null);
  const [faded, setFaded] = useState<FadedState | null>(null);
  const activeSessionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    api.getCourse(workspace.repositoryId).then((tree) => { setCourse(tree); setSelected(firstTeachNode(tree.root)); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取课程"));
    api.getLearner(workspace.repositoryId).then((profile) => { setLearner(profile); setSettings(profile.recommended.settings); }).catch(() => setLearner(null));
  }, [workspace.repositoryId]);
  useEffect(() => { setSession(null); setFaded(null); }, [selected?.id]);
  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socket.onmessage = (event: MessageEvent<string>) => {
      const serverEvent = JSON.parse(event.data) as { type: string; payload: { sessionId?: string; delta?: string } };
      if (serverEvent.type === "session.delta" && serverEvent.payload.sessionId === activeSessionId.current) {
        setLiveAnswer((current) => current + (serverEvent.payload.delta ?? ""));
      }
    };
    return () => socket.close();
  }, []);
  const send = async (): Promise<void> => {
    if (!content.trim() || !selected) return;
    setSending(true); setError("");
    try {
      let active = session;
      if (!active) { const created = await api.createSession(workspace.repositoryId, selected.id, settings); active = created.session; setFaded(created.faded); }
      if (!active) return;
      activeSessionId.current = active.id;
      setLiveAnswer("");
      const reply = await api.sendMessage(active.id, content, settings);
      setSession(reply.session); setSettings(reply.session.settings); setCost(reply.cost); setLiveAnswer(""); setContent("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "发送失败"); } finally { setSending(false); }
  };
  if (error && !course) return <EmptyState title="教学会话暂不可用" detail={error} />;
  if (!course || !selected) return <Loading />;
  const messages = session?.messages ?? [];
  return (
    <section className="tutor-page">
      <header className="tutor-header">
        <div>
          <p className="eyebrow">苏格拉底教学</p>
          <h1>{selected.title}</h1>
          <p>围绕源码证据逐层推进，连续两次要求降档会触发答案熔断并记录依赖事件。</p>
          {learner && (
            <small className="recommendation-note">
              当前默认档：{learner.recommended.settings.pedagogy === "socratic" ? "引导" : learner.recommended.settings.pedagogy === "explanatory" ? "讲解" : "练习"} · {learner.recommended.settings.depth === "macro" ? "宏观" : "微观"} · 风格 {learner.recommended.settings.style}
              {faded ? ` · faded ${faded.sampleCompleteness}/${faded.hintDepth}/${faded.stylePlainness}` : ""}
            </small>
          )}
        </div>
        <select value={selected.id} onChange={(event) => { const found = flatten(course.root).find((node) => node.id === event.target.value); if (found) setSelected(found); }} aria-label="选择课程节点">
          {flatten(course.root).filter((node) => node.anchors.length).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
        </select>
      </header>
      <div className="tutor-layout">
        <aside className="session-controls">
          <h2>语言风格 <output>{settings.style}</output></h2>
          <input className="style-slider" type="range" min="0" max="100" value={settings.style} onChange={(event) => setSettings((current) => ({ ...current, style: Number(event.target.value) }))} aria-label="语言风格" />
          <div className="range-labels"><span>严肃</span><span>通俗</span></div>
          <h2 className="control-heading">教学法</h2>
          <Segmented value={settings.pedagogy} items={[{ value: "socratic", label: "引导" }, { value: "explanatory", label: "讲解" }, { value: "practice", label: "练习" }]} onChange={(pedagogy) => setSettings((current) => ({ ...current, pedagogy: pedagogy as Pedagogy }))} />
          <h2 className="control-heading">拆解层次</h2>
          <Segmented value={settings.depth} items={[{ value: "macro", label: "宏观" }, { value: "micro", label: "微观" }]} onChange={(depth) => setSettings((current) => ({ ...current, depth: depth as DecompositionDepth }))} />
          <div className="ladder">
            <h2>教学阶梯</h2>
            {["L1 定向", "L2 程序", "L3 概念", "检验", "确认"].map((label) => (
              <div key={label} className={stageIndex(session?.stage) >= ["L1 定向", "L2 程序", "L3 概念", "检验", "确认"].indexOf(label) ? "ladder-step reached" : "ladder-step"}><span />{label}</div>
            ))}
          </div>
          <div className="source-chip"><Code2 size={15} />{selected.anchors[0] ? `${selected.anchors[0].path}:${selected.anchors[0].line}` : "无源码锚点"}</div>
          {cost && <div className={`cost-chip ${cost.mode}`}><BarChart3 size={15} />${cost.estimatedCostUsd.toFixed(4)} / ${cost.monthlyBudgetUsd.toFixed(2)}</div>}
        </aside>
        <div className="chat-panel">
          <div className="chat-messages">
            {messages.length === 0 && !liveAnswer ? (
              <div className="starter"><MessageCircleQuestion size={25} /><p>先写下你对这个节点的一个观察或假设。</p></div>
            ) : (
              messages.map((message) => <div className={`message ${message.role}`} key={message.id}><span>{message.role === "user" ? "你" : "导师"}</span><p>{message.content}</p></div>)
            )}
            {liveAnswer && <div className="message assistant streaming"><span>导师</span><p>{liveAnswer}<i /></p></div>}
          </div>
          {error && <p className="error-message">{error}</p>}
          <div className="composer">
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder="描述你的推理，或输入「不知道」请求下一层提示"
              rows={3}
            />
            <button className="primary icon-button" aria-label="发送消息" title="发送消息" onClick={() => void send()} disabled={sending || !content.trim()}>
              {sending ? <RefreshCw className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}