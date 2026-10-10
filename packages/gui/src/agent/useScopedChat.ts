import { useEffect, useRef, useState } from "react";
import type { ChatScope, ChatThread, CostSummary, CourseNode, CourseTree, Exercise, FadedState, FlowStage, LearnerProfile, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { api, type ScopedChatEvent, type StreamTurn } from "../api/client";
import { firstTeachNode, flatten } from "../views/helpers";
import { useTypewriter } from "./useTypewriter";
import { readDebtMap, writeDebtMap, readThreadMemory, writeThreadMemory, RECHECK_DELAYS, type TurnDebt, type ThreadMemory } from "./chatMemory";

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
export function teachingProgressText(payload: { stage?: string; round?: number; path?: string; query?: string }): string {
  if (payload.stage === "deciding") return "正在判断本轮教学动作…";
  if (payload.stage === "reading") return `正在读取 ${payload.path || "代码文件"} …`;
  if (payload.stage === "searching") return `正在检索代码：${payload.query || "关键词"} …`;
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

/** 线程正文一行的最小形状：teaching 的 TutorMessage 与 map/practice 的 ChatThreadMessage 都能对上（断线补账只比条数）。 */
type ThreadRow = { id: string; role: string; content: string };

const SCOPE_STORAGE_KEY = "codebase-tutor.scope";

/** GUI 作用域（teaching）→ 引擎作用域取值（teach）：两套口径的对应关系只在这一处表里换算。 */
const CHAT_SCOPE: Record<Scope, ChatScope> = { map: "map", teaching: "teach", practice: "practice" };

/** 线程正文 → 侧栏展示项：库里只有 user/assistant 两种角色，hint/error 这类本地提示不落库、也读不回来。 */function threadItemsFrom(messages: readonly ThreadRow[]): ThreadItem[] {
  return messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content)
    .map((message) => ({ kind: message.role === "user" ? "user" as const : "agent" as const, id: message.id, text: message.content }));
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

/**
  回合失败是「断线」还是「引擎答砸了」：fetch 层面两者同形（都是抛错），但只有前者引擎仍会把这一轮
  算完并落库，回来时补得回——补账只对这一类开。AbortError 是连接被掐（断网时浏览器也这么抛），
  「连接中断，未收到完整回复」是流提前收尾，Failed to fetch / Load failed / NetworkError 是各家浏览器
  对 fetch 网络错误的文案。引擎显式回的 error 事件（模型失败、会话失效）不在其列：那一轮确实没成品，没什么可补。
  */
function lostInTransit(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === "AbortError") return true;
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.includes("连接中断") || text.includes("Failed to fetch") || text.includes("Load failed") || text.includes("NetworkError");
}

export interface ScopedChatApi {
  scope: Scope;
  setScope: (next: Scope) => void;

  /** Agent 侧栏 thread 状态：3 作用域各独立。`pushMessage/clearThread` 两个写入器封装为方法。 */
  threads: Record<Scope, ThreadItem[]>;
  /** `text` 存原文（不预 escape）；agent 消息可选 variant（"error" 错误 / "hint" 本地提示）。 */
  pushMessage: (scope: Scope, role: "user" | "agent", text: string, variant?: "error" | "hint") => void;
  clearThread: (scope: Scope) => void;

  /**
    会话线程（三作用域各一份独立列表，真源在引擎库里）：
    `chatThreads` 按 updated_at 倒序，`currentThreadId` 是当前打开的线程。
    新建 / 切换 / 重命名 / 删除四个动作都在这里，删除是软删（列表与正文从此看不见，库里的行与审计日志不动）。
    */
  chatThreads: Record<Scope, ChatThread[]>;
  currentThreadId: Record<Scope, string | null>;
  /** 新建线程并切过去；`firstQuestion` 用来给线程起个认得出的标题。teaching 走 createSession（它才装配策略与学习者画像）。 */
  newThread: (scope: Scope, firstQuestion?: string) => Promise<string | null>;
  switchThread: (scope: Scope, threadId: string | null) => void;
  renameThread: (scope: Scope, threadId: string, title: string) => Promise<void>;
  /** 软删线程：GUI 侧二次确认在 AgentRail（文案要让用户看见「审计日志仍保留脱敏摘要」）。 */
  removeThread: (scope: Scope, threadId: string) => Promise<void>;

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
  /** 停止当前在途回合：既告诉引擎别算了（省 token），也掐掉自己的连接。没有在途回合时为空操作。 */
  stopTurn: () => void;
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
  三作用域共用的单一状态源（App.tsx 调用一次，返回值以 `chat` prop 铺给三个页面 + AgentRail）。
  命名口径：本对象管的是**线程**（threadId / ThreadItem / chatThreads）；`session` 字段是引擎的 TutorSession
  （教学作用域的在途状态：stage / fallbackCount / settings）。同一条教学会话三个名字——库里 `chat_session` 行
  = GUI 的 threadId = 引擎的 sessionId，id 一致，只是各层叫法不同。
  - TutorPage 只读 chat.selected/settings/learner/faded/cost（阶梯 + 锚点 + 成本 chip）
  - AgentRail 写入 content / send / scope / pushMessage
  */
export function useScopedChat(repositoryId: string): ScopedChatApi {
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
  // 在途回合：`turnId` 让引擎按 id 停下来（省 token），`controller` 掐自己的连接。两者刻意分开——
  // 只断连接时引擎分不清「用户点停止」和「网络波动」，会照常把这一轮算完落库（断线补账正靠这个）。
  const activeTurn = useRef<{ scope: Scope; turnId: string; controller: AbortController } | null>(null);
  const beginTurn = (target: Scope): StreamTurn => {
    const controller = new AbortController();
    const turnId = crypto.randomUUID();
    activeTurn.current = { scope: target, turnId, controller };
    return { turnId, signal: controller.signal };
  };
  const endTurn = (): void => {
    activeTurn.current = null;
  };
  /** 这一轮是不是用户自己停的：必须在 catch 里读（finally 会清掉在途引用）。 */
  const stoppedByUser = (target: Scope): boolean =>
    activeTurn.current?.scope === target && activeTurn.current.controller.signal.aborted;
  const stopTurn = (): void => {
    const turn = activeTurn.current;
    if (!turn) return;
    turn.controller.abort();
    // 404 = 引擎那一轮已经算完了（我们只是没读到 done）：界面同样算停下来，错误吞掉即可
    void api.stopTurn(turn.turnId).catch(() => undefined);
  };
  // 回复生成过程指示（按作用域）：三作用域都走各自请求的 SSE 事件（teaching 是 progress、map 是 thinking/reading），都是引擎发事件、GUI 定文案
  const [progress, setProgress] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  const setScopeProgress = (target: Scope, text: string): void => {
    setProgress((prev) => (prev[target] === text ? prev : { ...prev, [target]: text }));
  };
  const { liveAnswer, begin, enqueue, finish, clear, abort, stop } = useTypewriter();
  const [error, setError] = useState("");
  // 最近一条回复的来源（按作用域记录）：显式展示 LLM 是否参与（不静默回落）
  const [replySource, setReplySource] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  // 会话线程（三作用域各一份独立列表，真源在引擎库）：清单 + 当前打开的线程
  const [chatThreads, setChatThreads] = useState<Record<Scope, ChatThread[]>>({ map: [], teaching: [], practice: [] });
  const [currentThreadId, setCurrentThreadId] = useState<Record<Scope, string | null>>({ map: null, teaching: null, practice: null });
  // 渲染期镜像：切线程、清选择这些动作要读「此刻的当前线程」，setState 的异步值不可用
  const currentThreadRef = useRef(currentThreadId);
  currentThreadRef.current = currentThreadId;
  const chatThreadsRef = useRef(chatThreads);
  chatThreadsRef.current = chatThreads;
  // 练习评估作用域的对话上下文（由 PracticePage 在生成练习时写入）
  const [practiceExercise, setPracticeExerciseState] = useState<Exercise | null>(null);
  const setPracticeExercise = (exercise: Exercise | null): void => {
    setPracticeExerciseState(exercise);
    // 换题即换线程：旧题的问答留在旧线程里（列表可切回），当前线程清空、下次追问时新建并绑到新题。
    // 这替掉的是 09-25 的「历史游标」——同一份「旧题问答不许进新题上下文」的语义，改由线程边界来保证。
    if (currentThreadRef.current.practice) switchThread("practice", null);
  };
  useEffect(() => { setPracticeExerciseState(null); }, [repositoryId]);
  const setSettings = (next: TutorSettings | ((prev: TutorSettings) => TutorSettings)): void => {
    setSettingsState((prev) => (typeof next === "function" ? (next as (prev: TutorSettings) => TutorSettings)(prev) : next));
  };

  const [learner, setLearner] = useState<LearnerProfile | null>(null);
  const [faded, setFaded] = useState<FadedState | null>(null);
  useEffect(() => {
    if (!repositoryId) { setLearner(null); setFaded(null); return; }
    // 取消守卫：快速切换仓库/卸载后，旧仓库的画像不得写回状态（与下方 getCourse 效应同一套口径）
    let cancelled = false;
    api.getLearner(repositoryId).then((profile) => {
      if (cancelled) return;
      setLearner(profile);
      setSettingsState((curr) => curr.style === 50 && curr.pedagogy === "socratic" && curr.depth === "macro" ? profile.recommended.settings : curr);
    }).catch(() => { if (!cancelled) setLearner(null); });
    return () => { cancelled = true; };
  }, [repositoryId]);
  useEffect(() => {
    setSession(null);
    setFaded(null);
    clear();
  }, [selected?.id]);

  // ==== 会话线程：清单 / 当前线程 / 新建·切换·重命名·删除 ====

  /** 写记忆（localStorage 不可用时静默跳过：记忆只是「上次停在哪」的便利，真源在引擎库里）。 */
  const patchMemory = (scope: Scope, patch: Partial<ThreadMemory>): void => {
    if (!repositoryId) return;
    const chatScope = CHAT_SCOPE[scope];
    const current = readThreadMemory()[repositoryId]?.[chatScope] ?? { currentId: null, ids: [] };
    writeThreadMemory(repositoryId, chatScope, { ...current, ...patch });
  };

  // ==== 断线补账 ====
  /** 各作用域当前线程「已知的库里正文条数」，补账时的比对基准：回读正文时覆盖，回合成功 +2（一问一答原子落库）。 */
  const knownRowCount = useRef<Record<Scope, number>>({ map: 0, teaching: 0, practice: 0 });
  /** 欠账回读进行到第几趟，和挂着的定时器句柄；两者都由 patchDebt 统一作废（记账/结账即重置）。 */
  const reconcileAttempts = useRef<Record<Scope, number>>({ map: 0, teaching: 0, practice: 0 });
  const recheckTimers = useRef<Record<Scope, number | null>>({ map: null, teaching: null, practice: null });
  /**
    补账结论是一句「本地提示」，库里没有正文对应物：回读线程会把侧栏整个重写一遍，
    靠 pushMessage 递出去的这句会在第二次回读时消失（实测刷新一次就没了）。
    所以按线程存一份，place 每次铺正文都把它补回最后一项；记账（新一轮开始）时作废。
    */
  const backfillNotice = useRef<Record<Scope, { threadId: string; item: ThreadItem } | null>>({ map: null, teaching: null, practice: null });
  const patchNotice = (target: Scope, threadId: string, text: string): void => {
    backfillNotice.current[target] = { threadId, item: { kind: "agent", id: `backfill-${threadId}`, text, variant: "hint" } };
  };
  /** 欠账写在 sessionStorage 而不是内存：整页刷新同样是「断线回来」，而刷新会带走一切内存态。 */
  const readDebt = (target: Scope): TurnDebt | null => readDebtMap()[repositoryId]?.[CHAT_SCOPE[target]] ?? null;
  const patchDebt = (target: Scope, debt: TurnDebt | null): void => {
    resetRecheck(target);
    if (debt) backfillNotice.current[target] = null; // 新一轮开始：上一轮的补账结论不再相关
    if (!repositoryId) return;
    const map = readDebtMap();
    map[repositoryId] = { ...map[repositoryId], [CHAT_SCOPE[target]]: debt ?? undefined };
    writeDebtMap(map);
  };
  /** 有没有等着补的账：欠的必须正是当前线程，否则切回来的那条不该被旧事打扰。 */
  const hasDebt = (target: Scope): boolean => {
    const debt = readDebt(target);
    const threadId = currentThreadRef.current[target];
    return !!debt && !!threadId && debt.threadId === threadId;
  };

  /** 正文到位后结账：比记下欠账时多 → 那一轮补回来了；没多 → 引擎可能还在算（断线时它往往没算完），
      先别急着下结论，按退避再回读几趟；最后一趟仍没有才说明白。 */
  const reconcile = (target: Scope, threadId: string, rows: readonly ThreadRow[]): void => {
    knownRowCount.current[target] = rows.length;
    const debt = readDebt(target);
    if (!debt || debt.threadId !== threadId) return;
    if (rows.length > debt.count) {
      patchDebt(target, null);
      patchNotice(target, threadId, "这一轮在断线期间由引擎算完，回复已从库里补回。");
      return;
    }
    const wait = RECHECK_DELAYS[reconcileAttempts.current[target]];
    if (wait === undefined) {
      patchDebt(target, null);
      patchNotice(target, threadId, "等了一会儿，断线那一轮仍没落库（引擎没算完，或根本没收到）。可以重新提问。");
      return;
    }
    reconcileAttempts.current[target] += 1;
    scheduleRecheck(target, wait);
  };

  /** 欠账的回读重试：同一作用域同一时刻只挂一趟，新回合记账时一律作废重算。 */
  const scheduleRecheck = (target: Scope, delayMs: number): void => {
    if (recheckTimers.current[target] !== null) return;
    recheckTimers.current[target] = window.setTimeout(() => {
      recheckTimers.current[target] = null;
      if (hasDebt(target)) void loadThread(target, currentThreadRef.current[target]!);
    }, delayMs);
  };
  const resetRecheck = (target: Scope): void => {
    reconcileAttempts.current[target] = 0;
    if (recheckTimers.current[target] !== null) {
      window.clearTimeout(recheckTimers.current[target]);
      recheckTimers.current[target] = null;
    }
  };
  useEffect(() => {
    const timers = recheckTimers.current;
    return () => {
      for (const target of SCOPES) if (timers[target] !== null) window.clearTimeout(timers[target]);
    };
  }, []);

  /** 发送前先结断线那轮的账：回读正文会重写侧栏，必须赶在用户新气泡上屏之前跑完，否则又变成「气泡被覆盖」。 */
  const settlePendingTurn = async (target: Scope): Promise<void> => {
    if (!hasDebt(target)) return;
    await loadThread(target, currentThreadRef.current[target]!);
  };

  /** 网络恢复时最可能已经落库：把有欠账的作用域各回读一次。 */
  const reconcilePending = (): void => {
    for (const target of SCOPES) {
      if (hasDebt(target)) void loadThread(target, currentThreadRef.current[target]!);
    }
  };
  // 处理器只装一次，通过 ref 调最新闭包：loadThread 读的是渲染期的 selected/course
  const reconcilePendingRef = useRef(reconcilePending);
  reconcilePendingRef.current = reconcilePending;
  useEffect(() => {
    const onOnline = (): void => reconcilePendingRef.current();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  /** 回合失败的分诊：用户停止（清账——这一轮不该落库）／断线（欠账原样留着，等引擎算完补回）／引擎明说失败（清账，没有可补的）／其余按原因报错。
      `replayStarted` 由调用方的闭包给出：true 表示已经收到过 delta——回合是「算完→落库→分块回放」，回放被掐掉的那一轮正文其实已经在库里。 */
  const triageTurnFailure = (target: Scope, reason: unknown, replayStarted: boolean): void => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    if (stoppedByUser(target)) {
      patchDebt(target, null);
      if (replayStarted) knownRowCount.current[target] += 2; // 库里那一问一答确实存在：基准跟着走，免得日后误判成「补回」
      pushMessage(target, "agent", replayStarted
        ? "已停止生成。引擎那一轮其实早就算完并落库了（掐掉的是回放），重新打开会话能看到完整回复。"
        : "已停止生成，这一轮没有落库。", "hint");
      return;
    }
    if (lostInTransit(reason)) {
      pushMessage(target, "agent", `回复没能送达（${detail}）。引擎通常仍会把这一轮算完并落库——回到会话或网络恢复时会自动补回。`, "error");
      return;
    }
    patchDebt(target, null);
    setError(detail);
    pushMessage(target, "agent", `发送失败：${detail}`, "error");
  };

  /** 按 threadId 拉回正文并铺到侧栏：teaching 走 /api/sessions（连 stage/settings 一起回），map/practice 走线程正文。 */
  const loadThread = async (scope: Scope, threadId: string): Promise<void> => {
    const place = (messages: readonly ThreadRow[]): void => {
      if (currentThreadRef.current[scope] !== threadId) return; // 期间又切走了：迟到的旧响应不落进新线程
      reconcile(scope, threadId, messages); // 先结账：补账结论要作为最后一项跟着这一份正文一起上屏
      const items = threadItemsFrom(messages);
      const notice = backfillNotice.current[scope];
      if (notice?.threadId === threadId) items.push(notice.item);
      setThreads((prev) => ({ ...prev, [scope]: items }));
    };
    try {
      if (scope === "teaching") {
        const thread = chatThreadsRef.current.teaching.find((item) => item.id === threadId);
        // 教学线程绑节点：点开的线程若属于别的节点，先把左栏挪过去（节点效应接着把这个线程挂回来）
        if (thread?.courseNodeId && thread.courseNodeId !== selected?.id) {
          const node = course ? flatten(course.root).find((item) => item.id === thread.courseNodeId) : undefined;
          if (node) { setSelected(node); return; }
        }
        const restored = await api.getSession(threadId);
        if (restored.repositoryId !== repositoryId) throw new Error("会话不属于当前仓库");
        setSession(restored);
        setSettingsState(restored.settings);
        place(restored.messages);
        return;
      }
      place((await api.getThreadMessages(threadId)).messages);
    } catch {
      if (currentThreadRef.current[scope] !== threadId) return;
      setThreads((prev) => ({ ...prev, [scope]: [] }));
      pushMessage(scope, "agent", "这个会话的历史暂时读不到（引擎未挂载该仓库，或会话已被删除）。", "hint");
    }
  };

  /** 只改「当前线程是哪条」，不动侧栏已展示的对话——发送时惰性新建线程走这条，免得抹掉刚敲进去的那句。 */
  const markCurrentThread = (scope: Scope, threadId: string): void => {
    setCurrentThreadId((prev) => ({ ...prev, [scope]: threadId }));
    currentThreadRef.current = { ...currentThreadRef.current, [scope]: threadId };
    patchMemory(scope, { currentId: threadId });
  };

  /** 切当前线程并回读正文；`load=false` 用于刚建好的空线程（没必要回读一遍空清单）。 */
  const setCurrentThread = (scope: Scope, threadId: string | null, load = true): void => {
    if (threadId) markCurrentThread(scope, threadId);
    else {
      setCurrentThreadId((prev) => ({ ...prev, [scope]: null }));
      currentThreadRef.current = { ...currentThreadRef.current, [scope]: null };
      patchMemory(scope, { currentId: null });
    }
    if (!threadId || !load) { setThreads((prev) => ({ ...prev, [scope]: [] })); knownRowCount.current[scope] = 0; if (scope === "teaching" && !threadId) setSession(null); return; }
    void loadThread(scope, threadId);
  };
  const switchThread = (scope: Scope, threadId: string | null): void => setCurrentThread(scope, threadId);

  /** 拉某作用域的线程清单（引擎为准，按更新时间倒序）：清单里没有的当前线程直接放弃——它可能在别处被删了。 */
  const refreshThreads = async (scope: Scope): Promise<ChatThread[]> => {
    if (!repositoryId) return [];
    let list: ChatThread[];
    try {
      list = (await api.listThreads(repositoryId, CHAT_SCOPE[scope])).threads;
    } catch {
      // 引擎重启后仓库要先重新导入，清单暂时拿不到：保留上次所见，不清空选择
      return chatThreadsRef.current[scope];
    }
    setChatThreads((prev) => ({ ...prev, [scope]: list }));
    chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: list };
    patchMemory(scope, { ids: list.map((item) => item.id) });
    const current = currentThreadRef.current[scope];
    if (current && !list.some((item) => item.id === current)) setCurrentThread(scope, null);
    return list;
  };

  /** 建线程（引擎发 id）。teaching 走 createSession——只有它装配策略与学习者画像，同时落 chat_session 行。 */
  const createThreadFor = async (scope: Scope, firstQuestion?: string): Promise<string | null> => {
    if (!repositoryId) return null;
    const title = firstQuestion?.trim().slice(0, 60) || undefined; // 首问当标题：列表里一眼认得出这条会话在聊什么
    try {
      if (scope === "teaching") {
        if (!selected) return null;
        const created = await api.createSession(repositoryId, selected.id, settings);
        setSession(created.session);
        setFaded(created.faded);
        void refreshThreads(scope);
        return created.session.id;
      }
      const { thread } = await api.createThread(repositoryId, {
        scope: CHAT_SCOPE[scope],
        ...(scope === "map" && mapNode ? { nodeId: mapNode.id } : {}),
        ...(scope === "practice" && practiceExercise ? { exerciseId: practiceExercise.id } : {}),
        ...(title ? { title } : {})
      });
      const list = [thread, ...chatThreadsRef.current[scope]];
      setChatThreads((prev) => ({ ...prev, [scope]: list }));
      chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: list };
      patchMemory(scope, { ids: list.map((item) => item.id) });
      return thread.id;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新建会话失败");
      return null;
    }
  };

  /** 「新建会话」按钮：建完切过去，侧栏清空成一段新对话。 */
  const newThread = async (scope: Scope, firstQuestion?: string): Promise<string | null> => {
    const threadId = await createThreadFor(scope, firstQuestion);
    if (threadId) setCurrentThread(scope, threadId, false);
    return threadId;
  };

  const renameThread = async (scope: Scope, threadId: string, title: string): Promise<void> => {
    try {
      const { thread } = await api.renameThread(threadId, title);
      const list = chatThreadsRef.current[scope].map((item) => (item.id === threadId ? thread : item));
      setChatThreads((prev) => ({ ...prev, [scope]: list }));
      chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: list };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重命名失败");
      void refreshThreads(scope);
    }
  };

  /** 软删：库里的正文与审计日志都留着，只是从列表消失；删的正是当前线程时回到「还没有线程」。 */
  const removeThread = async (scope: Scope, threadId: string): Promise<void> => {
    try {
      await api.deleteThread(threadId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除会话失败");
      return;
    }
    const list = chatThreadsRef.current[scope].filter((item) => item.id !== threadId);
    setChatThreads((prev) => ({ ...prev, [scope]: list }));
    chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: list };
    patchMemory(scope, { ids: list.map((item) => item.id) });
    if (currentThreadRef.current[scope] === threadId) setCurrentThread(scope, null);
  };

  // 仓库切换 / 首次挂载：三个作用域各拉一次清单；map 与 practice 按记忆（或清单最新一条）落到当前线程，
  // teaching 的当前线程由下面的节点效应按「该节点最近一次会话」决定。
  useEffect(() => {
    if (!repositoryId) {
      setChatThreads({ map: [], teaching: [], practice: [] });
      setCurrentThread("map", null);
      setCurrentThread("practice", null);
      setCurrentThread("teaching", null);
      return;
    }
    let cancelled = false;
    const boot = async (): Promise<void> => {
      for (const scope of ["map", "practice"] as const) {
        const list = await refreshThreads(scope);
        if (cancelled) return;
        const remembered = readThreadMemory()[repositoryId]?.[CHAT_SCOPE[scope]]?.currentId;
        setCurrentThread(scope, list.find((item) => item.id === remembered)?.id ?? list[0]?.id ?? null);
      }
      void refreshThreads("teaching");
    };
    void boot();
    return () => { cancelled = true; };
  }, [repositoryId]);

  // 切作用域顺带刷一次该作用域的清单：另一个作用域里新建的线程要立刻可见，删除了的也不该再显示
  useEffect(() => {
    if (repositoryId) void refreshThreads(scope);
  }, [repositoryId, scope]);

  // 换节点 = 挂回该节点最近一次教学线程（GUI 从没存过 id 的存量会话也在清单里）；该节点没有会话时留空，
  // 下一次发送经 createSession 新建。清单可能比本地状态滞后一拍（新建后还没回表），这时**什么都不做**：
  // 中途清掉当前线程会抹掉正在进行的回合，也会把 session 一起清空。真被别处删掉的线程由 refreshThreads 剪枝。
  // 已经停在这条线程上时也**不再回读**：清单每次刷新都是新数组，本效应都会重跑，而 loadThread 会用库里的
  // 旧正文覆盖侧栏——新会话的第一问此刻还没落库，覆盖过去就把用户气泡抹掉了（只剩 agent 回复）。
  useEffect(() => {
    if (!repositoryId || !selected) return;
    const list = chatThreadsRef.current.teaching;
    const current = currentThreadRef.current.teaching;
    const currentThread = current ? list.find((item) => item.id === current) : undefined;
    if (current && !currentThread) return; // 清单还没回表（刚新建 / 刚刷新）：这一拍什么都不做
    if (currentThread) {
      if (currentThread.courseNodeId !== selected.id) setCurrentThread("teaching", null);
      return;
    }
    const target = list.find((item) => item.courseNodeId === selected.id);
    if (target) setCurrentThread("teaching", target.id);
  }, [repositoryId, selected, chatThreads.teaching, session?.id]);

  const send = async (): Promise<void> => {
    if (!content.trim()) return;
    // 用户说出口的话一定先上屏：下面的守卫（没绑节点）只补一条提示，不再把这一句吞掉。
    const message = content;
    // 断线那轮的账先结掉（回读正文会重写侧栏，得赶在用户气泡上屏前）
    await settlePendingTurn("teaching");
    pushMessage("teaching", "user", message);
    setContent("");
    if (!selected) {
      pushMessage("teaching", "agent", "先在左栏选一个可教节点，再回到这里对话。", "hint");
      return;
    }
    setSending(true); setError(""); setScopeProgress("teaching", "正在准备教学上下文…");
    const turn = beginTurn("teaching");
    // 收到过 delta = 引擎那一轮已算完并落库，掐掉的只是回放（停止分诊据此区分两种情形）
    let sawDelta = false;
    try {
      let active = session;
      if (!active) {
        const created = await api.createSession(repositoryId, selected.id, settings);
        active = created.session;
        setFaded(created.faded);
        // 会话即线程：id 由引擎发，本地只记「当前停在这条」，清单回头拉一次让它出现在列表里
        markCurrentThread("teaching", active.id);
        knownRowCount.current.teaching = 0; // 新建线程是空的：补账基准从这里起算
        void refreshThreads("teaching");
      }
      if (!active) return;
      begin();
      // 记下欠账再发请求：这一轮若因断线没送达，回来时按这条记录判断引擎有没有替我们算完
      patchDebt("teaching", { threadId: active.id, count: knownRowCount.current.teaching });
      // 教学回合 SSE：progress 过程提示与 delta 回放并入请求响应流（替代原 /ws 全局广播 + sessionId 过滤）
      const reply = await api.sendMessageStream(active.id, message, settings, (event) => {
        if (event.type === "delta") { sawDelta = true; enqueue(event.delta); }
        else if (event.type === "progress") setScopeProgress("teaching", teachingProgressText(event.payload));
      }, turn);
      await finish();
      setSession(reply.session);
      setSettingsState(reply.session.settings);
      setCost(reply.cost);
      setReplySource((prev) => ({ ...prev, teaching: reply.provider ?? "" }));
      clear();
      pushMessage("teaching", "agent", reply.message.content);
      knownRowCount.current.teaching += 2; // 一问一答原子落库
      patchDebt("teaching", null);          // 这一轮送到了：欠账销掉
    } catch (reason) {
      abort();
      triageTurnFailure("teaching", reason, sawDelta);
    } finally {
      endTurn();
      setSending(false);
      setScopeProgress("teaching", "");
    }
  };

  // 作用域对话（宏观设计 / 练习评估）：不走教学状态机；历史由引擎按 threadId 自取，正文由它落库——GUI 只上送这一句
  const sendScoped = async (scope: "map" | "practice"): Promise<void> => {
    if (!content.trim() || !repositoryId) return;
    const message = content;
    // 同 teaching：先结断线那轮的账，再让这一句上屏——原来「没题就 return」会让用户输入凭空消失。
    await settlePendingTurn(scope);
    pushMessage(scope, "user", message);
    setContent("");
    if (scope === "practice" && !practiceExercise) {
      pushMessage("practice", "agent", "先在练习页生成一道练习，再在这里追问。", "hint");
      return;
    }
    // 线程保障：没有当前线程就惰性新建（标题取首问）。没有线程等于没有历史——上一轮会被静默丢掉。
    const threadId = currentThreadRef.current[scope] ?? await createThreadFor(scope, message);
    if (!threadId) return;
    if (!currentThreadRef.current[scope]) { markCurrentThread(scope, threadId); knownRowCount.current[scope] = 0; }
    setSending(true); setError(""); setScopeProgress(scope, "回复生成中…");
    // 流式正文的落点：map/practice 的 SSE delta 进打字机队列，节奏吐字，排空后固化为正式消息
    begin();
    const turn = beginTurn(scope);
    patchDebt(scope, { threadId, count: knownRowCount.current[scope] }); // 同 teaching：发请求前先记下欠账
    // 同 teaching：收到过 delta 说明引擎那一轮已算完落库，停止只掐掉了回放
    let sawDelta = false;
    const onScopedEvent = (event: ScopedChatEvent): void => {
      if (event.type === "delta") { sawDelta = true; enqueue(event.delta); }
      else if (scope === "map" && event.type === "reading") setScopeProgress("map", `正在读取 ${event.path || "文件"} …`);
      else if (scope === "map" && event.type === "searching") setScopeProgress("map", `正在检索代码：${event.query || "关键词"} …`);
    };
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
            threadId,
            style: settings.style
          }, onScopedEvent, turn)
        : await api.practiceChat(repositoryId, { content: message, exerciseId: practiceExercise!.id, threadId, style: settings.style }, onScopedEvent, turn);
      await finish();
      pushMessage(scope, "agent", reply.reply);
      setReplySource((prev) => ({ ...prev, [scope]: reply.provider ?? "" }));
      clear();
      knownRowCount.current[scope] += 2;
      patchDebt(scope, null); // 这一轮送到了：欠账销掉
    } catch (reason) {
      abort();
      triageTurnFailure(scope, reason, sawDelta);
    } finally {
      stop();
      endTurn();
      setSending(false);
      setScopeProgress(scope, "");
      // 回合结束刷新清单：新线程进了列表，当前线程也排到最前（引擎按更新时间倒序）
      void refreshThreads(scope);
    }
  };
  const sendMap = (): Promise<void> => sendScoped("map");
  const sendPractice = (): Promise<void> => sendScoped("practice");

  return {
    scope, setScope,
    threads, pushMessage, clearThread,
    chatThreads, currentThreadId, newThread, switchThread, renameThread, removeThread,
    course, dataVersion, reloadCourseData, selected, setSelected,
    mapNode, setMapNode, mapFile, setMapFile, mapBinding, setMapBinding,
    practiceUnit, setPracticeUnit,
    session, settings, setSettings, cost,
    content, setContent, sending, stopTurn, progress, liveAnswer, learner, faded, error, send, sendMap, sendPractice, replySource,
    practiceExercise, setPracticeExercise,
  };
}
