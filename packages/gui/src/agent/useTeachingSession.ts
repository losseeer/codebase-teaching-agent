import { useEffect, useRef, useState } from "react";
import type { CostSummary, CourseNode, CourseTree, Exercise, FadedState, FlowStage, LearnerProfile, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { api, type ScopedChatHistoryTurn } from "../api/client";
import { firstTeachNode, flatten } from "../views/helpers";

/**
  Agent 侧栏的 3 个作用域。对应 prototype 中 `SCOPES = { map, teaching, practice }`。
  - `map`      宏观设计（绑定文件树，可见模块/关系，动作只读）
  - `teaching` 代码教学（绑定当前课程节点，可见源码/锚点/stage，动作可写入 session）
  - `practice` 练习评估（绑定当前练习，可见题目/进度，动作可写入学习日志）
  */
export type Scope = "map" | "teaching" | "practice";
export const SCOPES: ReadonlyArray<Scope> = ["map", "teaching", "practice"] as const;

/** 宏观设计绑定的三种合法情形：项目目录选文件 / 架构视图模块(+其关联文件) / 流程视图环节(+其关联文件)。 */
export type MapBinding = { kind: "file" | "module" | "flow"; title?: string; path?: string };

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
/** 教学会话 id 的持久化表（键 = `仓库:节点`）：页面刷新后凭它向引擎取回历史（引擎侧有 journal 续命）。 */
const SESSION_STORAGE_KEY = "codebase-tutor.teaching-sessions";

function readSessionMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "{}") as unknown;
    return typeof parsed === "object" && parsed ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function rememberSession(repositoryId: string, nodeId: string, sessionId?: string): void {
  try {
    const map = readSessionMap();
    const key = `${repositoryId}:${nodeId}`;
    if (sessionId) map[key] = sessionId;
    else delete map[key];
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* localStorage 不可用时续命只在当前页面内有效，不影响发送 */
  }
}

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

  /** 宏观设计作用域绑定（prototype `binds.map` = 节点「X」· 文件）：由 CoursePage 写入，AgentRail 只读。
    `scopePaths`：仅架构图合成模块（id 以 `depmap:` 起，课程树里查无此节点）随请求上送 chip 内文件清单，
    引擎据此解析作用域；换绑其他节点时必须省略（清空），否则旧清单会污染新节点的上下文。
    `focus`：仅流程视图选中环节时给出——课程树节点只到入口粒度，环节自身的说明与关联文件要随请求上送。 */
  mapNode: CourseNode | null;
  setMapNode: (node: CourseNode | null, scopePaths?: string[], focus?: FlowStage | null) => void;
  /** 绑定行数据（AgentRail 的「绑定」只读展示）；null = 未绑定，不再默认拼根节点 */
  mapBinding: MapBinding | null;
  setMapBinding: (binding: MapBinding | null) => void;
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
}

/**
  代码教学 + Agent 侧栏共享的单一状态源。
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
// threads 的渲染期镜像：换题等事件发生时要同步读到「当前线程长度」来推进历史游标（setState 的异步值不可用）
const threadsRef = useRef(threads);
threadsRef.current = threads;
/** practice 历史上界：此下标之前的线程消息属于更早的练习，不随追问上送（线程仍完整展示）。 */
const practiceHistoryStart = useRef(0);

// 课程与节点
const [course, setCourse] = useState<CourseTree | null>(null);
const [selected, setSelected] = useState<CourseNode | null>(null);
// 课程数据代数：同一仓库重新导入时 repositoryId 由内容 hash 派生、保持不变，
// 仅靠 [repositoryId] 依赖不会重发请求（首次 404 后 course 恒为 null）——导入完成后由 App 调 reloadCourseData() 强制重跑。
const [dataVersion, setDataVersion] = useState(0);
const reloadCourseData = (): void => setDataVersion((version) => version + 1);
// 宏观设计 / 练习作用域的绑定（跨组件只读展示；prototype 的 binds 对象）
// 节点 + depmap 文件清单 + 流程环节 focus 是一个绑定的三半，合成一个 state 原子更新——分开两个 setState 会让
// 「换绑到其他节点却残留旧清单/旧环节」成为可能（它们只对特定选中项有意义）。
const [mapSelection, setMapSelection] = useState<{ node: CourseNode | null; scopePaths: string[]; focus: FlowStage | null }>({ node: null, scopePaths: [], focus: null });
const mapNode = mapSelection.node;
const setMapNode = (node: CourseNode | null, scopePaths: string[] = [], focus: FlowStage | null = null): void => setMapSelection({ node, scopePaths, focus });
const [mapFile, setMapFile] = useState("");
  const [mapBinding, setMapBinding] = useState<MapBinding | null>(null);
const [practiceUnit, setPracticeUnit] = useState("");
useEffect(() => { setMapNode(null); setMapFile(""); setPracticeUnit(""); }, [repositoryId]);
useEffect(() => {
  if (!repositoryId) { setCourse(null); setSelected(null); return; }
  let cancelled = false;
  api.getCourse(repositoryId).then((tree) => {
    if (cancelled) return;
    setCourse(tree);
    // 重导入后按 id 把在绑选择挂回新树：`prev ?? …` 保旧对象会让上下文请求一直带着过期节点（children/anchors 都是旧的）
    const nodes = flatten(tree.root);
    setMapSelection((prev) => {
      // 课程重烧后流程快照也可能更新，环节 focus 一并清空（旧对象不再上送；重选环节即可）
      if (!prev.node) return { node: tree.root, scopePaths: [], focus: null };
      if (prev.node.id.startsWith("depmap:")) return { ...prev, focus: null }; // 合成节点不在课程树里，无处可挂，原样保留
      return { node: nodes.find((item) => item.id === prev.node!.id) ?? tree.root, scopePaths: [], focus: null };
    });
    const first = firstTeachNode(tree.root);
    setSelected((prev) => {
      if (!prev) return first ?? null;
      // id 失效 → 归位首个可教节点；id 一变，[selected?.id] 效应自动清掉过期教学 session
      return nodes.find((item) => item.id === prev.id) ?? first ?? null;
    });
  }).catch(() => { if (!cancelled) setCourse(null); });
  return () => { cancelled = true; };
}, [repositoryId, dataVersion]);
  // 代码教学 + settings + 流式
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
  const setPracticeExercise = (exercise: Exercise | null): void => {
    // 换题即推进游标：旧题的问答不再进新题的上下文（「为什么选A」串题会误导模型），线程本身不清空
    practiceHistoryStart.current = threadsRef.current.practice.length;
    setPracticeExerciseState(exercise);
  };
  useEffect(() => { setPracticeExerciseState(null); practiceHistoryStart.current = 0; }, [repositoryId]);
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

  // 对话历史续命：引擎早已支持「按 sessionId 从 journal 重建会话」，但 GUI 从不存 id 也不取回——
  // 刷新页面后线程恒为空。找回顺序 = 本地存的 id → 引擎按节点倒扫 journal（存量历史没存过 id 也能救回）；
  // 会话挂回后线程为空时用 session.messages 重建展示。查不到/对不上就忘掉 id，下次发送走新建。
  useEffect(() => {
    if (!repositoryId || !selected || session) return;
    const nodeId = selected.id;
    const key = `${repositoryId}:${nodeId}`;
    let cancelled = false;
    const restore = async (): Promise<void> => {
      try {
        let sessionId: string | undefined = readSessionMap()[key];
        if (!sessionId) sessionId = (await api.getLatestSession(repositoryId, nodeId)).sessionId ?? undefined;
        if (!sessionId || cancelled) return;
        const restored = await api.getSession(sessionId);
        if (cancelled) return;
        if (restored.repositoryId !== repositoryId || restored.courseNodeId !== nodeId) {
          rememberSession(repositoryId, nodeId);
          return;
        }
        rememberSession(repositoryId, nodeId, restored.id);
        setSession(restored);
        setSettingsState(restored.settings);
        setThreads((prev) => (prev.teaching.length
          ? prev
          : {
              ...prev,
              teaching: restored.messages
                .filter((message) => message.role !== "system" && message.content)
                .map((message) => ({ kind: message.role === "user" ? "user" as const : "agent" as const, id: message.id, text: message.content }))
            }));
      } catch {
        if (!cancelled) rememberSession(repositoryId, nodeId);
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [repositoryId, selected, session]);

  const activeSessionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!repositoryId) return;
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socket.onmessage = (event: MessageEvent<string>) => {
      const serverEvent = JSON.parse(event.data) as { type: string; payload: { sessionId?: string; delta?: string; repositoryId?: string; stage?: string; round?: number; path?: string } };
      if (serverEvent.type === "session.delta" && serverEvent.payload.sessionId === activeSessionId.current) {
        setLiveAnswer((current) => current + (serverEvent.payload.delta ?? ""));
      } else if (serverEvent.type === "session.progress" && serverEvent.payload.sessionId === activeSessionId.current) {
        // 教学回合的过程提示：引擎发的是「判断动作 / 读文件 / 思考」这类事件，文案由 GUI 决定
        setScopeProgress("teaching", teachingProgressText(serverEvent.payload));
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
        rememberSession(repositoryId, selected.id, active.id);
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

  // 作用域对话（宏观设计 / 练习评估）：不走教学状态机；随请求上送线程最近若干轮作历史窗口
  const sendScoped = async (scope: "map" | "practice"): Promise<void> => {
    if (!content.trim() || !repositoryId) return;
    if (scope === "practice" && !practiceExercise) {
      pushMessage("practice", "agent", "先在练习页生成一道练习，再在这里追问。", "hint");
      return;
    }
    const message = content;
    // 最近对话历史随请求上送（闭包里的 threads 尚未含本条）：practice 只送当前练习产生后的片段
    const inScopeThread = threads[scope]
      .slice(scope === "practice" ? practiceHistoryStart.current : 0)
      .filter((item) => item.kind === "user" || !item.variant);
    const scopeHistory: ScopedChatHistoryTurn[] = inScopeThread.slice(-6)
      .map((item) => ({ role: item.kind === "user" ? "user" as const : "assistant" as const, content: item.text }));
    // 窗口外的抽取式脉络：更早轮次只留学习者提问（引擎渲染时每行截断），零 LLM 成本
    const earlierQuestions = inScopeThread.slice(0, Math.max(0, inScopeThread.length - 6))
      .filter((item) => item.kind === "user")
      .slice(-8)
      .map((item) => item.text);
    pushMessage(scope, "user", message);
    setSending(true); setError(""); setContent(""); setScopeProgress(scope, "回复生成中…");
    try {
      const reply = scope === "map"
        ? await api.mapChatStream(repositoryId, {
            content: message,
            nodeId: mapNode?.id,
            // 架构图合成模块：课程树里没有这个节点，靠文件清单让引擎解析作用域（其余绑定不带）
            ...(mapNode?.id.startsWith("depmap:") && mapSelection.scopePaths.length ? { scopePaths: mapSelection.scopePaths } : {}),
            // 流程视图选中环节：节点只到入口粒度，环节信息靠这一并上送
            ...(mapSelection.focus ? { focus: mapSelection.focus } : {}),
            path: mapFile || undefined,
            history: scopeHistory,
            earlierQuestions,
            style: settings.style
          }, (event) => {
            setScopeProgress("map", event.stage === "reading"
              ? `正在读取 ${event.path || "文件"} …`
              : "回复生成中…");
          })
        : await api.practiceChat(repositoryId, { content: message, exerciseId: practiceExercise!.id, history: scopeHistory, earlierQuestions, style: settings.style });
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

  return {
    scope, setScope,
    threads, pushMessage, clearThread,
    course, dataVersion, reloadCourseData, selected, setSelected,
    mapNode, setMapNode, mapFile, setMapFile, mapBinding, setMapBinding,
    practiceUnit, setPracticeUnit,
    session, settings, setSettings, cost,
    content, setContent, sending, progress, liveAnswer, learner, faded, error, send, sendMap, sendPractice, replySource,
    practiceExercise, setPracticeExercise,
  };
}
