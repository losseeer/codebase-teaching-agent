import { useEffect, useRef, useState } from "react";
import type { CompanionSuggestion, CostSummary, CourseNode, CourseTree, FadedState, LearnerProfile, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { api } from "../api/client";
import { firstTeachNode } from "../views/helpers";

/**
  Agent 侧栏的 3 个作用域。对应 prototype 中 `SCOPES = { map, teaching, practice }`。
  - `map`      宏观设计（绑定文件树，可见模块/关系，动作只读）
  - `teaching` 代码教学（绑定当前课程节点，可见源码/锚点/stage，动作可写入 session）
  - `practice` 练习评估（绑定当前练习，可见题目/进度，动作可写入学习日志）
  */
export type Scope = "map" | "teaching" | "practice";
export const SCOPES: ReadonlyArray<Scope> = ["map", "teaching", "practice"] as const;

export const SCOPE_LABEL: Record<Scope, string> = {
  map: "宏观设计",
  teaching: "代码教学",
  practice: "练习评估",
};

/** thread 一条消息的形态：用户/Agent/分隔线。`divider.html` 即分隔线文本（已通过 pushDivider 注入）。 */
export type ThreadItem =
  | { kind: "user"; id: string; html: string }
  | { kind: "agent"; id: string; html: string }
  | { kind: "divider"; id: string; html: string };

const SCOPE_STORAGE_KEY = "codebase-tutor.scope";

function isScope(value: string): value is Scope {
  return value === "map" || value === "teaching" || value === "practice";
}

function loadInitialScope(): Scope {
  try {
    const saved = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (saved && isScope(saved)) return saved;
  } catch {
    /* localStorage 不可用时 fallback */
  }
  return "teaching";
}

export interface TeachingSessionApi {
  scope: Scope;
  setScope: (next: Scope) => void;

  /** Agent 侧栏 thread 状态：3 作用域各独立。`pushDivider/pushMessage/clearThread` 三个写入器封装为方法。 */
  threads: Record<Scope, ThreadItem[]>;
  pushMessage: (scope: Scope, role: "user" | "agent", html: string) => void;
  pushDivider: (scope: Scope, text: string) => void;
  clearThread: (scope: Scope) => void;

  /** 当前 teaching 教学状态（API + 流式） */
  course: CourseTree | null;
  /** 课程数据代数：repositoryId 不变的重新导入 / 需要强制刷新课程请求时递增。 */
  dataVersion: number;
  /** 强制重发课程相关请求（导入完成后由 App 调用）。 */
  reloadCourseData: () => void;
  selected: CourseNode | null;
  setSelected: (node: CourseNode) => void;

  /** 课程地图作用域绑定（prototype `binds.map` = 节点「X」· 文件）：由 CoursePage 写入，AgentRail 只读 */
  mapNode: CourseNode | null;
  setMapNode: (node: CourseNode | null) => void;
  mapFile: string;
  setMapFile: (path: string) => void;

  /** 练习作用域绑定（prototype `binds.practice` = 练习 #N · 文件）：由 PracticePage 写入 */
  practiceUnit: string;
  setPracticeUnit: (label: string) => void;
  session: TutorSession | null;
  settings: TutorSettings;
  setSettings: (next: TutorSettings | ((prev: TutorSettings) => TutorSettings)) => void;
  cost: CostSummary | null;
  content: string;
  setContent: (next: string) => void;
  sending: boolean;
  liveAnswer: string;
  learner: LearnerProfile | null;
  faded: FadedState | null;
  error: string;
  send: () => Promise<void>;

  /** companion 推送（teaching 作用域 thread 渲染） */
  suggestions: CompanionSuggestion[];
  actOnSuggestion: (suggestion: CompanionSuggestion, action: "accepted" | "later" | "dismissed") => Promise<void>;
  refreshSuggestions: () => void;
}

/**
  教学会话 + Agent 侧栏共享的单一状态源。
  - App.tsx 调用一次，把返回值 prop drill 给 TutorPage + AgentRail
  - TutorPage 只读 session.selected/settings/learner/faded/cost（用于渲染阶梯 + 锚点 + 成本 chip）
  - AgentRail 写入 content / send / scope / pushDivider / pushMessage
  */
export function useTeachingSession(repositoryId: string): TeachingSessionApi {
  const [scope, setScopeRaw] = useState<Scope>(loadInitialScope);
  useEffect(() => {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch { /* 持久化失败不回退 */ }
  }, [scope]);
  const setScope = (next: Scope): void => {
    setScopeRaw(next);
    pushDivider(next, `已切换到 · ${SCOPE_LABEL[next]}`);
  };

  /**
  Agent 侧栏 thread 状态：3 作用域各独立。
  - 内存态（跨路由共享；刷新页面重置 —— 与 prototype 语义一致）
  - `pushDivider` 对连续完全相同的文本去重（React StrictMode 双跑 effect 不产生重复分隔线）
  - `pushMessage` / `clearThread` 不做去重
  */
const [threads, setThreads] = useState<Record<Scope, ThreadItem[]>>({ map: [], teaching: [], practice: [] });
const pushMessage = (target: Scope, role: "user" | "agent", html: string): void => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setThreads((prev) => ({ ...prev, [target]: [...prev[target], { kind: role, id, html }] }));
};
const pushDivider = (target: Scope, text: string): void => {
  const id = `${Date.now()}-div-${Math.random().toString(36).slice(2, 8)}`;
  setThreads((prev) => {
    const list = prev[target];
    const last = list[list.length - 1];
    if (last && last.kind === "divider" && last.html === text) return prev;
    return { ...prev, [target]: [...list, { kind: "divider", id, html: text }] };
  });
};
const clearThread = (target: Scope): void => setThreads((prev) => ({ ...prev, [target]: [] }));

// 课程与节点
const [course, setCourse] = useState<CourseTree | null>(null);
const [selected, setSelected] = useState<CourseNode | null>(null);
// 课程数据代数：同一仓库重新导入时 repositoryId 由内容 hash 派生、保持不变，
// 仅靠 [repositoryId] 依赖不会重发请求（首次 404 后 course 恒为 null）——导入完成后由 App 调 reloadCourseData() 强制重跑。
const [dataVersion, setDataVersion] = useState(0);
const reloadCourseData = (): void => setDataVersion((version) => version + 1);
// 课程地图 / 练习作用域的绑定（跨组件只读展示；prototype 的 binds 对象）
const [mapNode, setMapNode] = useState<CourseNode | null>(null);
const [mapFile, setMapFile] = useState("");
const [practiceUnit, setPracticeUnit] = useState("");
useEffect(() => { setMapNode(null); setMapFile(""); setPracticeUnit(""); }, [repositoryId]);
useEffect(() => {
  if (!repositoryId) { setCourse(null); setSelected(null); return; }
  let cancelled = false;
  api.getCourse(repositoryId).then((tree) => {
    if (cancelled) return;
    setCourse(tree);
    setMapNode((prev) => prev ?? tree.root);
    const first = firstTeachNode(tree.root);
    if (first) setSelected((prev) => prev ?? first);
  }).catch(() => { if (!cancelled) setCourse(null); });
  return () => { cancelled = true; };
}, [repositoryId, dataVersion]);
// prototype 语义：首次打开节点记「已打开」；之后每次切换记「已定位」+「已切换到」
const initialSelectionDone = useRef(false);
useEffect(() => {
  if (!selected) { initialSelectionDone.current = false; return; }
  const anchor = selected.anchors[0];
  if (!initialSelectionDone.current) {
    initialSelectionDone.current = true;
    if (anchor) pushDivider("teaching", `已打开 · ${anchor.path}:${anchor.line}`);
    return;
  }
  if (anchor) pushDivider("teaching", `已定位 · ${anchor.path}:${anchor.line}`);
  pushDivider("teaching", `已切换到 · ${selected.title}`);
}, [selected?.id]);

  // 教学会话 + settings + 流式
  const [session, setSession] = useState<TutorSession | null>(null);
  const [settings, setSettingsState] = useState<TutorSettings>({ style: 50, pedagogy: "socratic", depth: "macro" });
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [error, setError] = useState("");
  const setSettings = (next: TutorSettings | ((prev: TutorSettings) => TutorSettings)): void => {
    setSettingsState((prev) => (typeof next === "function" ? (next as (prev: TutorSettings) => TutorSettings)(prev) : next));
  };

  const [learner, setLearner] = useState<LearnerProfile | null>(null);
  const [faded, setFaded] = useState<FadedState | null>(null);
  useEffect(() => {
    if (!repositoryId) { setLearner(null); setFaded(null); return; }
    api.getLearner(repositoryId).then((profile) => {
      setLearner(profile);
      setSettingsState((curr) => curr.style === 50 && curr.pedagogy === "socratic" && curr.depth === "macro" ? profile.recommended.settings : curr);
    }).catch(() => setLearner(null));
  }, [repositoryId]);
  useEffect(() => {
    setSession(null);
    setFaded(null);
    setLiveAnswer("");
  }, [selected?.id]);

  const activeSessionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!repositoryId) return;
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socket.onmessage = (event: MessageEvent<string>) => {
      const serverEvent = JSON.parse(event.data) as { type: string; payload: { sessionId?: string; delta?: string; repositoryId?: string; suggestion?: CompanionSuggestion } };
      if (serverEvent.type === "session.delta" && serverEvent.payload.sessionId === activeSessionId.current) {
        setLiveAnswer((current) => current + (serverEvent.payload.delta ?? ""));
      } else if (serverEvent.type === "companion.suggestion" && serverEvent.payload.repositoryId === repositoryId && serverEvent.payload.suggestion) {
        const s = serverEvent.payload.suggestion;
        setSuggestions((curr) => {
          if (curr.some((existing) => existing.id === s.id)) return curr;
          return [s, ...curr];
        });
      }
    };
    return () => socket.close();
  }, [repositoryId]);

  const send = async (): Promise<void> => {
    if (!content.trim() || !selected) return;
    const message = content;
    pushMessage("teaching", "user", escapeHtml(message));
    setSending(true); setError(""); setContent("");
    try {
      let active = session;
      if (!active) {
        const created = await api.createSession(repositoryId, selected.id, settings);
        active = created.session;
        setFaded(created.faded);
      }
      if (!active) return;
      activeSessionId.current = active.id;
      setLiveAnswer("");
      const reply = await api.sendMessage(active.id, message, settings);
      setSession(reply.session);
      setSettingsState(reply.session.settings);
      setCost(reply.cost);
      setLiveAnswer("");
      pushMessage("teaching", "agent", escapeHtml(reply.message.content));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败");
      pushMessage("teaching", "agent", `<em style="color:#ae3f36">发送失败：${escapeHtml(reason instanceof Error ? reason.message : String(reason))}</em>`);
    } finally {
      setSending(false);
    }
  };

  // Companion suggestions（teaching 作用域展示）
  const [suggestions, setSuggestions] = useState<CompanionSuggestion[]>([]);
  const refreshSuggestions = (): void => {
    if (!repositoryId) { setSuggestions([]); return; }
    api.getCompanionSuggestions(repositoryId).then((result) => setSuggestions(result.suggestions)).catch(() => setSuggestions([]));
  };
  useEffect(refreshSuggestions, [repositoryId]);
  const actOnSuggestion = async (suggestion: CompanionSuggestion, action: "accepted" | "later" | "dismissed"): Promise<void> => {
    try {
      await api.actOnSuggestion(repositoryId, suggestion.id, action);
      setSuggestions((curr) => curr.filter((item) => item.id !== suggestion.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    }
  };

  return {
    scope, setScope,
    threads, pushMessage, pushDivider, clearThread,
    course, dataVersion, reloadCourseData, selected, setSelected,
    mapNode, setMapNode, mapFile, setMapFile,
    practiceUnit, setPracticeUnit,
    session, settings, setSettings, cost,
    content, setContent, sending, liveAnswer, learner, faded, error, send,
    suggestions, actOnSuggestion, refreshSuggestions,
  };
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