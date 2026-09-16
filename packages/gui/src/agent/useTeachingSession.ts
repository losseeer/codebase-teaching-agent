import { useEffect, useRef, useState } from "react";
import type { CompanionSuggestion, CostSummary, CourseNode, CourseTree, Exercise, FadedState, LearnerProfile, TutorSession, TutorSettings } from "@codebase-tutor/shared";
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

/**
  教学回合过程提示的文案。引擎按 `harness` 的 TeachingProgress 发结构化事件（stage 取值与 map-chat 的
  SSE 过程事件同一套），文案在这一层定——引擎不该关心中文措辞，GUI 不该猜阶段语义。
  */
export function teachingProgressText(payload: { stage?: string; round?: number; path?: string }): string {
  if (payload.stage === "deciding") return "正在判断本轮教学动作…";
  if (payload.stage === "reading") return `正在读取 ${payload.path || "代码文件"} …`;
  if (payload.stage === "thinking") return payload.round && payload.round > 1 ? `正在思考（第 ${payload.round} 轮）…` : "正在思考…";
  return "回复生成中…";
}

/** thread 一条消息的形态：用户/Agent。
  agent 消息存原文，由 AgentRail 按需走 Markdown 渲染；`variant` 标记非正文消息（错误提示 / 本地提示）。
  位置/状态变化（切换作用域、切换节点、选中文件等）不再以分割线入线程——上下文变化由绑定区展示，
  线程只留真实的对话内容（v0.8.1）。 */
export type ThreadItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string; variant?: "error" | "hint" };

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

/** 引擎启发式回落 provider 名：与 engine harness 的 local fallback 标识一致。 */
export const HEURISTIC_SOURCE = "local-heuristic-v1";

export interface TeachingSessionApi {
  scope: Scope;
  setScope: (next: Scope) => void;

  /** Agent 侧栏 thread 状态：3 作用域各独立。`pushMessage/clearThread` 两个写入器封装为方法。 */
  threads: Record<Scope, ThreadItem[]>;
  /** `text` 存原文（不预 escape）；agent 消息可选 variant（"error" 错误 / "hint" 本地提示）。 */
  pushMessage: (scope: Scope, role: "user" | "agent", text: string, variant?: "error" | "hint") => void;
  clearThread: (scope: Scope) => void;

  /** 当前 teaching 教学状态（API + 流式） */
  course: CourseTree | null;
  /** 课程数据代数：repositoryId 不变的重新导入 / 需要强制刷新课程请求时递增。 */
  dataVersion: number;
  /** 强制重发课程相关请求（导入完成后由 App 调用）。 */
  reloadCourseData: () => void;
  selected: CourseNode | null;
  setSelected: (node: CourseNode) => void;

  /** 代码地图作用域绑定（prototype `binds.map` = 节点「X」· 文件）：由 CoursePage 写入，AgentRail 只读 */
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
  /** 回复生成过程指示（按作用域）：如「回复生成中…」「正在读取 src/app.ts …」；空串 = 无进行中任务 */
  progress: Record<Scope, string>;
  liveAnswer: string;
  learner: LearnerProfile | null;
  faded: FadedState | null;
  error: string;
  send: () => Promise<void>;
  /** 作用域对话：宏观设计 / 练习评估的单轮 LLM 讨论 */
  sendMap: () => Promise<void>;
  sendPractice: () => Promise<void>;
  /** 最近一条回复的来源（按作用域记录；"local-heuristic-v1" = 启发式回落；空串 = 本作用域尚无回复） */
  replySource: Record<Scope, string>;
  /** 当前练习对象（练习评估作用域的对话上下文；由 PracticePage 写入） */
  practiceExercise: Exercise | null;
  setPracticeExercise: (exercise: Exercise | null) => void;

  /** companion 推送（teaching 作用域 thread 渲染） */
  suggestions: CompanionSuggestion[];
  actOnSuggestion: (suggestion: CompanionSuggestion, action: "accepted" | "later" | "dismissed") => Promise<void>;
  refreshSuggestions: () => void;
}

/**
  教学会话 + Agent 侧栏共享的单一状态源。
  - App.tsx 调用一次，把返回值 prop drill 给 TutorPage + AgentRail
  - TutorPage 只读 session.selected/settings/learner/faded/cost（用于渲染阶梯 + 锚点 + 成本 chip）
  - AgentRail 写入 content / send / scope / pushMessage
  */
export function useTeachingSession(repositoryId: string): TeachingSessionApi {
  const [scope, setScopeRaw] = useState<Scope>(loadInitialScope);
  useEffect(() => {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch { /* 持久化失败不回退 */ }
  }, [scope]);
  const setScope = (next: Scope): void => setScopeRaw(next);

  /**
  Agent 侧栏 thread 状态：3 作用域各独立。
  - 内存态（跨路由共享；刷新页面重置 —— 与 prototype 语义一致）
  - 只有 `pushMessage` / `clearThread` 两个写入器：位置/状态变化不再入线程（v0.8.1 起）
  */
const [threads, setThreads] = useState<Record<Scope, ThreadItem[]>>({ map: [], teaching: [], practice: [] });
const pushMessage = (target: Scope, role: "user" | "agent", text: string, variant?: "error" | "hint"): void => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setThreads((prev) => ({ ...prev, [target]: [...prev[target], { kind: role, id, text, ...(variant ? { variant } : {}) }] }));
};
const clearThread = (target: Scope): void => setThreads((prev) => ({ ...prev, [target]: [] }));

// 课程与节点
const [course, setCourse] = useState<CourseTree | null>(null);
const [selected, setSelected] = useState<CourseNode | null>(null);
// 课程数据代数：同一仓库重新导入时 repositoryId 由内容 hash 派生、保持不变，
// 仅靠 [repositoryId] 依赖不会重发请求（首次 404 后 course 恒为 null）——导入完成后由 App 调 reloadCourseData() 强制重跑。
const [dataVersion, setDataVersion] = useState(0);
const reloadCourseData = (): void => setDataVersion((version) => version + 1);
// 代码地图 / 练习作用域的绑定（跨组件只读展示；prototype 的 binds 对象）
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
  // 教学会话 + settings + 流式
  const [session, setSession] = useState<TutorSession | null>(null);
  const [settings, setSettingsState] = useState<TutorSettings>({ style: 50, pedagogy: "socratic", depth: "macro" });
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  // 回复生成过程指示（按作用域）：map 走 SSE、teaching 走 ws 广播（引擎的 session.progress），都是引擎发事件、GUI 定文案
  const [progress, setProgress] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  const setScopeProgress = (target: Scope, text: string): void => {
    setProgress((prev) => (prev[target] === text ? prev : { ...prev, [target]: text }));
  };
  const [liveAnswer, setLiveAnswer] = useState("");
  const [error, setError] = useState("");
  // 最近一条回复的来源（按作用域记录）：显式展示 LLM 是否参与（不静默回落）
  const [replySource, setReplySource] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  // 练习评估作用域的对话上下文（由 PracticePage 在生成练习时写入）
  const [practiceExercise, setPracticeExerciseState] = useState<Exercise | null>(null);
  const setPracticeExercise = (exercise: Exercise | null): void => setPracticeExerciseState(exercise);
  useEffect(() => { setPracticeExerciseState(null); }, [repositoryId]);
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
      const serverEvent = JSON.parse(event.data) as { type: string; payload: { sessionId?: string; delta?: string; repositoryId?: string; suggestion?: CompanionSuggestion; stage?: string; round?: number; path?: string } };
      if (serverEvent.type === "session.delta" && serverEvent.payload.sessionId === activeSessionId.current) {
        setLiveAnswer((current) => current + (serverEvent.payload.delta ?? ""));
      } else if (serverEvent.type === "session.progress" && serverEvent.payload.sessionId === activeSessionId.current) {
        // 教学回合的过程提示：引擎发的是「判断动作 / 读文件 / 思考」这类事件，文案由 GUI 决定
        setScopeProgress("teaching", teachingProgressText(serverEvent.payload));
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
    pushMessage("teaching", "user", message);
    setSending(true); setError(""); setContent(""); setScopeProgress("teaching", "正在准备教学上下文…");
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
      setReplySource((prev) => ({ ...prev, teaching: reply.provider ?? "" }));
      setLiveAnswer("");
      pushMessage("teaching", "agent", reply.message.content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败");
      pushMessage("teaching", "agent", `发送失败：${reason instanceof Error ? reason.message : String(reason)}`, "error");
    } finally {
      setSending(false);
      setScopeProgress("teaching", "");
    }
  };

  // 作用域对话（宏观设计 / 练习评估）：单轮 LLM，不走教学状态机
  const sendScoped = async (scope: "map" | "practice"): Promise<void> => {
    if (!content.trim() || !repositoryId) return;
    if (scope === "practice" && !practiceExercise) {
      pushMessage("practice", "agent", "先在练习页生成一道练习，再在这里追问。", "hint");
      return;
    }
    const message = content;
    pushMessage(scope, "user", message);
    setSending(true); setError(""); setContent(""); setScopeProgress(scope, "回复生成中…");
    try {
      const reply = scope === "map"
        ? await api.mapChatStream(repositoryId, { content: message, nodeId: mapNode?.id, path: mapFile || undefined }, (event) => {
            setScopeProgress("map", event.stage === "reading"
              ? `正在读取 ${event.path || "文件"} …`
              : "回复生成中…");
          })
        : await api.practiceChat(repositoryId, { content: message, exerciseId: practiceExercise!.id });
      pushMessage(scope, "agent", reply.reply);
      setReplySource((prev) => ({ ...prev, [scope]: reply.provider ?? "" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败");
      pushMessage(scope, "agent", `发送失败：${reason instanceof Error ? reason.message : String(reason)}`, "error");
    } finally {
      setSending(false);
      setScopeProgress(scope, "");
    }
  };
  const sendMap = (): Promise<void> => sendScoped("map");
  const sendPractice = (): Promise<void> => sendScoped("practice");

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
    threads, pushMessage, clearThread,
    course, dataVersion, reloadCourseData, selected, setSelected,
    mapNode, setMapNode, mapFile, setMapFile,
    practiceUnit, setPracticeUnit,
    session, settings, setSettings, cost,
    content, setContent, sending, progress, liveAnswer, learner, faded, error, send, sendMap, sendPractice, replySource,
    practiceExercise, setPracticeExercise,
    suggestions, actOnSuggestion, refreshSuggestions,
  };
}
