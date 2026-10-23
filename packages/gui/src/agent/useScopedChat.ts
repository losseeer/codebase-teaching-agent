import { useEffect, useRef, useState } from "react";
import type { ChatThread, Exercise, ScopedStreamProgress, TutorSession, TutorSettings } from "@codebase-tutor/shared/wire";
import { defaultTutorSettings } from "@codebase-tutor/shared/wire";
import { api, subscribeServerEvents, type StreamTurn } from "../api/client";
import { useTypewriter } from "./useTypewriter";
import { readDebtMap, writeDebtMap, readThreadMemory, writeThreadMemory, RECHECK_DELAYS, type TurnDebt, type ThreadMemory } from "./chatMemory";
import { CHAT_SCOPE, loadInitialScope, SCOPES, SCOPE_STORAGE_KEY, type MapBinding, type Scope } from "./chatScope";
import { progressText } from "./progressLines";
import { threadItemsFrom, type ThreadItem, type ThreadRow } from "./threadItems";
import { lostInTransit } from "./turnFailure";
import type { ScopedChatApi } from "./scopedChatApi";

/**
  三作用域共用的单一状态源（App.tsx 调用一次，返回值以 `chat` prop 铺给三个页面 + AgentRail）：
  页面只读绑定与选择（scopeRef / settings / mapScopePaths / practiceUnit），写入都经 AgentRail。
  命名口径：本对象管线程（threadId / ThreadItem / chatThreads），`session` 是引擎的 TutorSession（教学作用域的在途状态）；
  同一条教学会话三个名字——库里 `chat_session` 行 = GUI 的 threadId = 引擎的 sessionId。
  */
export function useScopedChat(repositoryId: string): ScopedChatApi {
  const [scope, setScope] = useState<Scope>(loadInitialScope);
  useEffect(() => {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch { /* 持久化失败不回退 */ }
  }, [scope]);

const [threads, setThreads] = useState<Record<Scope, ThreadItem[]>>({ map: [], teaching: [], practice: [] });
const pushMessage = (target: Scope, role: "user" | "agent", text: string, variant?: "error" | "hint", card?: { diagramId: string; name: string }): void => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setThreads((prev) => ({ ...prev, [target]: [...prev[target], { kind: role, id, text, ...(variant ? { variant } : {}), ...(card ? { card } : {}) }] }));
};

/** 教学作用域：只存 `file:<path>` / `dir:<path>`，不依赖课程树。 */
const [scopeRef, setScopeRefState] = useState<string | null>(null);
const setScopeRef = (ref: string | null): void => setScopeRefState(ref);
const scopeLabel = scopeRef
  ? (scopeRef.startsWith("dir:") ? (scopeRef.slice(4) === "." ? "仓库根目录" : scopeRef.slice(4)) : scopeRef.slice(5).split("/").pop() ?? scopeRef)
  : "";
// 产物数据代数：重新导入 / watcher 重分析 / agent 改图后递增，画布与源码树据此重取。
const [dataVersion, setDataVersion] = useState(0);
const reloadRepositoryData = (): void => setDataVersion((version) => version + 1);
useEffect(() => {
  if (!repositoryId) return;
  const controller = new AbortController();
  const stop = subscribeServerEvents((event) => {
    if (event.type === "repository.updated" && event.payload.repositoryId === repositoryId) setDataVersion((version) => version + 1);
  }, controller.signal);
  return () => { stop(); controller.abort(); };
}, [repositoryId]);
// 画布选中节点时上送的文件清单：只作为 map-chat 的作用域提示。
const [mapScopePaths, setMapScopePaths] = useState<string[]>([]);
const setMapScope = (scopePaths: string[]): void => setMapScopePaths(scopePaths);
const [mapFile, setMapFile] = useState("");
  const [mapBinding, setMapBinding] = useState<MapBinding | null>(null);
// 画布上正打开的那张图：绑定行读它，map-chat 也把它当作用域上送，
// 这样「把这条边删掉」指的是用户眼前那张，而不是模型从图库里猜一张。
const [openDiagram, setOpenDiagram] = useState<{ id: string; name: string } | null>(null);
// 对话里的图卡片被点开：页面取走这一格去开图，取完清空（一次性的投递，不当事件总线用）
const [pendingDiagramOpen, setPendingDiagramOpen] = useState<{ id: string; name: string } | null>(null);
const requestOpenDiagram = (diagram: { id: string; name: string }): void => setPendingDiagramOpen(diagram);
const clearDiagramOpen = (): void => setPendingDiagramOpen(null);
const [practiceUnit, setPracticeUnit] = useState("");
useEffect(() => { setScopeRefState(null); setMapScopePaths([]); setMapFile(""); setMapBinding(null); setPracticeUnit(""); setOpenDiagram(null); }, [repositoryId]);
  /** 引擎的在途教学会话：只在本 hook 内部用（切作用域要重置、发问要带 id）。不对外暴露——GUI 的口径是线程，不是 session。 */
  const [session, setSession] = useState<TutorSession | null>(null);
  const [settings, setSettingsState] = useState<TutorSettings>(defaultTutorSettings);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  // 在途回合：turnId 与 signal 为什么必须分开用，见 api/client.ts 的 `StreamTurn` 注释。
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
    // 404 = 引擎那一轮已经算完了（我们只是没读到 done）：界面同样算停下来，错误丢弃即可
    void api.stopTurn(turn.turnId).catch(() => undefined);
  };
  // 回复生成过程指示（按作用域）：三作用域都走各自请求的 SSE 事件，引擎发事件、GUI 定文案
  const [progress, setProgress] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  const setScopeProgress = (target: Scope, text: string): void => {
    setProgress((prev) => (prev[target] === text ? prev : { ...prev, [target]: text }));
  };
  const { liveAnswer, begin, enqueue, finish, clear, abort, stop } = useTypewriter();
  const [error, setError] = useState("");
  const [replySource, setReplySource] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  const [chatThreads, setChatThreads] = useState<Record<Scope, ChatThread[]>>({ map: [], teaching: [], practice: [] });
  /** 引擎认下来、但清单不收的那一条（还没发言的新会话）：切作用域与开机恢复都要靠它认回当前会话。 */
  const [unsentThread, setUnsentThread] = useState<Partial<Record<Scope, ChatThread>>>({});
  const [currentThreadId, setCurrentThreadId] = useState<Record<Scope, string | null>>({ map: null, teaching: null, practice: null });
  // 渲染期镜像：切线程、清选择这些动作要读「此刻的当前线程」，setState 的异步值不可用
  const currentThreadRef = useRef(currentThreadId);
  currentThreadRef.current = currentThreadId;
  const chatThreadsRef = useRef(chatThreads);
  chatThreadsRef.current = chatThreads;
  const [practiceExercise, setPracticeExerciseState] = useState<Exercise | null>(null);
  const setPracticeExercise = (exercise: Exercise | null): void => {
    setPracticeExerciseState(exercise);
    // 换题即换线程：旧题的问答留在旧线程里（列表可切回），当前线程清空、下次追问时新建并绑到新题。
    if (currentThreadRef.current.practice) switchThread("practice", null);
  };
  useEffect(() => { setPracticeExerciseState(null); }, [repositoryId]);

  useEffect(() => {
    if (!repositoryId) return;
    // 取消守卫：快速切换仓库/卸载后，旧仓库的画像不得写回状态
    let cancelled = false;
    // 这一发唯一的用处：把没被用户动过的设置档种子成推荐值。画像本身界面不显示（成本与明细都在 InsightsPage 自己取数）
    api.getLearner(repositoryId).then((profile) => {
      if (cancelled) return;
      setSettingsState((curr) => curr.style === 50 && curr.pedagogy === "socratic" && curr.depth === "macro" ? profile.recommended.settings : curr);
    }).catch(() => { /* 取不到画像就保持当前档，不猜 */ });
    return () => { cancelled = true; };
  }, [repositoryId]);
  /** 写记忆：静默兜底与取舍见 chatMemory.ts 的 `writeThreadMemory`。 */
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
    靠 pushMessage 递出去的这句会在第二次回读时消失。
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
  /** 发请求前记下欠账，基准是「此刻已知的库里正文条数」——回来时按它判断引擎有没有替我们算完。 */
  const recordDebt = (target: Scope, threadId: string): void => {
    patchDebt(target, { threadId, count: knownRowCount.current[target] });
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
      patchNotice(target, threadId, "断线期间的回复已取回。");
      return;
    }
    const wait = RECHECK_DELAYS[reconcileAttempts.current[target]];
    if (wait === undefined) {
      patchDebt(target, null);
      patchNotice(target, threadId, "断线那一轮没有完成，请重新提问。");
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

  /** 发送前先结断线那轮的账：回读正文会重写侧栏，必须赶在用户新消息上屏之前跑完。 */
  const settlePendingTurn = async (target: Scope): Promise<void> => {
    if (!hasDebt(target)) return;
    await loadThread(target, currentThreadRef.current[target]!);
  };

  /** 网络恢复时最可能已经落库：把有欠账的作用域各回读一次。 */
  const reconcilePending = (): void => {
    for (const target of SCOPES) {
      // 在途回合的正文还没落库：这时回读等于用旧正文覆盖侧栏（而且这一轮的欠账本来就等着 settle 去清）
      if (hasDebt(target) && activeTurn.current?.scope !== target) void loadThread(target, currentThreadRef.current[target]!);
    }
  };
  // 处理器只装一次，通过 ref 调最新闭包：loadThread 读的是渲染期的 scopeRef
  const reconcilePendingRef = useRef(reconcilePending);
  reconcilePendingRef.current = reconcilePending;
  useEffect(() => {
    const onOnline = (): void => reconcilePendingRef.current();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  /** 回合失败的分诊：用户停止（清账——这一轮不该落库）／断线（欠账原样留着，等引擎算完补回）／引擎明说失败（清账，没有可补的）／其余按原因报错。
      `replayStarted` 由 `turnSink` 的闭包给出：true 表示已经收到过 delta——回合是「算完→落库→分块回放」，回放被中止的那一轮正文其实已经在库里。
      分诊前先放弃打字机队列：半途的 delta 不该继续往 `liveAnswer` 里吐。 */
  const triageTurnFailure = (target: Scope, reason: unknown, replayStarted: boolean): void => {
    abort();
    const detail = reason instanceof Error ? reason.message : String(reason);
    if (stoppedByUser(target)) {
      patchDebt(target, null);
      if (replayStarted) knownRowCount.current[target] += 2; // 库里那一问一答确实存在：基准跟着走，免得日后误判成「补回」
      pushMessage(target, "agent", replayStarted
        ? "已停止生成。引擎那一轮其实早就算完并落库了（中止的是回放），重新打开会话能看到完整回复。"
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

  /**
    一次流式回合的共用三动作（三作用域同一份）：delta 落点、成功结账、失败分诊。
    「回放是否已开始」只活在这个闭包里：分诊发生在 catch 里，而那一个布尔决定提示文案说不说「引擎其实算完了」。
    结账顺序：等打字机排空 → 正文上屏 → 清 liveAnswer → 销欠账。
  */
  const turnSink = (target: Scope): { onDelta: (delta: string) => void; settle: (text: string, provider: string | undefined) => Promise<void>; fail: (reason: unknown) => void } => {
    let replayStarted = false;
    return {
      onDelta: (delta) => { replayStarted = true; enqueue(delta); },
      settle: async (text, provider) => {
        await finish();
        pushMessage(target, "agent", text);
        setReplySource((prev) => ({ ...prev, [target]: provider ?? "" }));
        clear();
        knownRowCount.current[target] += 2; // 一问一答原子落库，补账基准跟着走
        patchDebt(target, null);
      },
      fail: (reason) => triageTurnFailure(target, reason, replayStarted)
    };
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
        if (thread && !thread.scopeRef) {
          // 旧课程树时代的线程没有文件/目录作用域：直接断，不假装还能接着聊
          setCurrentThread("teaching", null);
          pushMessage("teaching", "agent", "这条会话沿用的是旧的目录结构，请重新选一个文件或目录。", "hint");
          return;
        }
        // 教学线程绑作用域：点开的线程若属于别的文件/目录，先把左栏指向那个作用域
        if (thread?.scopeRef && thread.scopeRef !== scopeRef) setScopeRefState(thread.scopeRef);
        const restored = await api.getSession(threadId);
        if (restored.repositoryId !== repositoryId) throw new Error("会话不属于当前仓库");
        // 迟到的旧响应不落格（`place()` 里同一道守卫）：三个 setter 不看它的话，A 线程的会话会盖住正在看的 B，
        // 下一问就顺着 session 发进 A 里
        if (currentThreadRef.current.teaching !== threadId) return;
        setScopeRefState(restored.scopeRef);
        setSession(restored);
        setSettingsState(restored.settings);
        place(restored.messages);
        return;
      }
      place((await api.getThreadMessages(threadId)).messages);
    } catch {
      if (currentThreadRef.current[scope] !== threadId) return;
      setThreads((prev) => ({ ...prev, [scope]: [] }));
      // 正文没读回来就不能留着旧 session：否则标题是这一条、下一问发进上一条线程
      if (scope === "teaching") setSession(null);
      pushMessage(scope, "agent", "这段历史暂时读不到，可稍后再试或新建会话。", "hint");
    }
  };

  /** 只改「当前线程是哪条」，不动侧栏已展示的对话——发送时惰性新建线程走这条，免得清除刚敲进去的那句。 */
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

  /**
    拉某作用域的线程清单（引擎为准，按更新时间倒序）：引擎只列**谈过的**会话，
    `current` 回认我们正打开着但还没发言的那条。
    剪枝只在「引擎说这条已经不存在」时发生——清单里没有它不等于它没了，只等于它还没第一句话；
    拿清单当唯一依据会把刚点「新建」还没发言的那条剪掉。
  */
  const refreshThreads = async (scope: Scope): Promise<{ threads: ChatThread[]; current: ChatThread | null }> => {
    if (!repositoryId) return { threads: [], current: null };
    // 发请求前先记住「此刻开着哪条」：引擎的 `current` 问的是这一条，剪枝也只能据它判。
    // 用 await 之后的值会剪错——新建会话的回合里，响应落地时当前线程已经换成刚建的那条了。
    const remembered = readThreadMemory()[repositoryId]?.[CHAT_SCOPE[scope]]?.currentId ?? null;
    const opened = currentThreadRef.current[scope] ?? remembered;
    let list: ChatThread[];
    let current: ChatThread | null;
    try {
      const fetched = await api.listThreads(repositoryId, CHAT_SCOPE[scope], opened ?? undefined);
      list = fetched.threads;
      current = fetched.current;
    } catch {
      // 引擎重启后仓库要先重新导入，清单暂时拿不到：保留上次所见，不清空选择
      return { threads: chatThreadsRef.current[scope], current: null };
    }
    setChatThreads((prev) => ({ ...prev, [scope]: list }));
    chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: list };
    setUnsentThread((prev) => ({ ...prev, [scope]: current && !list.some((item) => item.id === current.id) ? current : null }));
    patchMemory(scope, { ids: list.map((item) => item.id) });
    if (opened && !list.some((item) => item.id === opened) && current?.id !== opened) setCurrentThread(scope, null);
    return { threads: list, current };
  };

  /** 建线程（引擎发 id）。teaching 走 createSession——只有它装配策略与学习者画像，同时落 chat_session 行。 */
  const createThreadFor = async (scope: Scope, firstQuestion?: string): Promise<string | null> => {
    if (!repositoryId) return null;
    const title = firstQuestion?.trim().slice(0, 60) || undefined; // 首问当标题：列表里一眼认得出这条会话在聊什么
    try {
      if (scope === "teaching") {
        if (!scopeRef) return null;
        const created = await api.createSession(repositoryId, scopeRef, settings);
        setSession(created.session);
        void refreshThreads(scope);
        return created.session.id;
      }
      const { thread } = await api.createThread(repositoryId, {
        scope: CHAT_SCOPE[scope],
        ...(scope === "practice" && practiceExercise ? { exerciseId: practiceExercise.id } : {}),
        ...(title ? { title } : {})
      });
      // 不把它插进清单：清单只列谈过的会话，还没发言的这一条由 ThreadBar 单独占一格显示。
      return thread.id;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新建会话失败");
      return null;
    }
  };

  /** 「新建会话」按钮：建完选中它，侧栏清空成一段新对话。 */
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
        const { threads: list, current } = await refreshThreads(scope);
        if (cancelled) return;
        const remembered = readThreadMemory()[repositoryId]?.[CHAT_SCOPE[scope]]?.currentId;
        // 记住的那条还活着就回到它（还没发言也算活着——引擎用 current 认它）；否则退回清单第一条
        const stillOpen = remembered && (current?.id === remembered || list.some((item) => item.id === remembered));
        setCurrentThread(scope, stillOpen ? remembered : (list[0]?.id ?? null));
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

  // 换作用域 = 挂回该文件/目录最近一次教学线程；没有会话时留空，下一次发送经 createSession 新建。
  // 清单可能比本地状态滞后一拍（新建后还没回表），这时什么都不做：中途清掉当前线程会打断正在进行的回合，也会把 session 一起清空。
  // 已经停在这条线程上时也不再回读：loadThread 会用库里的旧正文覆盖侧栏，而新会话的第一问可能还没落库。
  // 真被别处删掉的线程由 refreshThreads 剪枝。
  useEffect(() => {
    if (!repositoryId || !scopeRef) return;
    // 教学回合在途时不动线程：清栏或回读都会拿库里那份旧正文覆盖侧栏，刚推上屏的问题就没了。
    // 代价：途中换的作用域要等回合结束后下一次清单变化才对齐（这一轮的提问仍带着原 session 走，不会串到别的文件）。
    if (activeTurn.current?.scope === "teaching") return;
    const list = chatThreadsRef.current.teaching;
    const current = currentThreadRef.current.teaching;
    const currentThread = current ? list.find((item) => item.id === current) : undefined;
    if (current && !currentThread) {
      // 清单里没有它 = 这条会话还没发言（引擎只列谈过的）。什么都不做会留着旧会话，除非教学 session 自己说它绑的不是这个作用域。
      if (session && session.scopeRef !== scopeRef) setCurrentThread("teaching", null);
      return;
    }
    if (currentThread) {
      if (currentThread.scopeRef !== scopeRef) setCurrentThread("teaching", null);
      return;
    }
    const target = list.find((item) => item.scopeRef === scopeRef) ?? (unsentThread.teaching?.scopeRef === scopeRef ? unsentThread.teaching : undefined);
    if (target) setCurrentThread("teaching", target.id);
  }, [repositoryId, scopeRef, chatThreads.teaching, unsentThread.teaching, session?.id]);

  const send = async (): Promise<void> => {
    if (!content.trim()) return;
    // 用户说出口的话一定先上屏：下面的守卫（没选作用域）只补一条提示，不丢弃这一句。
    const message = content;
    await settlePendingTurn("teaching");
    pushMessage("teaching", "user", message);
    setContent("");
    if (!scopeRef) {
      pushMessage("teaching", "agent", "先在左栏选一个文件或目录，再回到这里对话。", "hint");
      return;
    }
    setSending(true); setError(""); setScopeProgress("teaching", "正在准备教学上下文…");
    const turn = beginTurn("teaching");
    const sink = turnSink("teaching");
    try {
      let active = session;
      if (!active) {
        const created = await api.createSession(repositoryId, scopeRef, settings);
        active = created.session;
        // 会话即线程：id 由引擎发，本地只记「当前停在这条」，清单回头拉一次让它出现在列表里
        markCurrentThread("teaching", active.id);
        knownRowCount.current.teaching = 0; // 新建线程是空的：补账基准从这里起算
        void refreshThreads("teaching");
      }
      if (!active) return;
      begin();
      recordDebt("teaching", active.id);
      // 教学回合 SSE：progress 过程提示与 delta 回放并入请求响应流
      const reply = await api.sendMessageStream(active.id, message, settings, (event) => {
        if (event.type === "delta") sink.onDelta(event.delta);
        else if (event.type === "progress") setScopeProgress("teaching", progressText(event.payload));
      }, turn);
      setSession(reply.session);
      setSettingsState(reply.session.settings);
      // reply.cost 不进状态：成本监控页按整月自己取数，单次回合这一格没人显示
      await sink.settle(reply.message.content, reply.provider);
    } catch (reason) {
      sink.fail(reason);
    } finally {
      endTurn();
      setSending(false);
      setScopeProgress("teaching", "");
    }
  };

  // 作用域对话（宏观设计 / 练习评估）：不走教学状态机；历史由引擎按 threadId 自取，正文由它落库——GUI 只上送这一句
  const sendScoped = async (scope: "map" | "practice"): Promise<void> => {
    const message = content.trim();
    if (!message || !repositoryId) return;
    // 同 teaching：先结断线那轮的账，再让这一句上屏。
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
    begin();
    const turn = beginTurn(scope);
    recordDebt(scope, threadId);
    const sink = turnSink(scope);
    const onScopedEvent = (event: ScopedStreamProgress): void => {
      // delta 进打字机队列，剩下三类过程提示（thinking / reading / searching）全部走 progressText——漏接一类，那行字就停在「回复生成中…」
      if (event.type === "delta") sink.onDelta(event.delta);
      else setScopeProgress(scope, progressText(event));
    };
    try {
      const reply = scope === "map"
        ? await api.mapChatStream(repositoryId, {
            content: message,
            // 画布选中节点：带上它关联的文件清单，引擎按这份清单解析作用域
            ...(mapScopePaths.length ? { scopePaths: mapScopePaths } : {}),
            path: mapFile || undefined,
            // 画布正打开的图：agent 改哪张、删哪条边都按这一格定，认不出就不动
            ...(openDiagram ? { diagramId: openDiagram.id } : {}),
            threadId,
            style: settings.style
          }, onScopedEvent, turn)
        : await api.practiceChat(repositoryId, { content: message, exerciseId: practiceExercise!.id, threadId, style: settings.style }, onScopedEvent, turn);
      await sink.settle(reply.reply, reply.provider);
      // 这一回合真画/真改了图 → 消息下面挂一张卡片。图本身已经在图库里了，卡片给的是「回到那句话画的那张」这条路。
      if (scope === "map" && reply.diagram?.id) pushMessage("map", "agent", "", undefined, { diagramId: reply.diagram.id, name: reply.diagram.name || "未命名图" });
    } catch (reason) {
      sink.fail(reason);
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
    threads, pushMessage,
    chatThreads, currentThreadId, newThread, switchThread, renameThread, removeThread,
    scopeRef, scopeLabel, setScopeRef, dataVersion, reloadRepositoryData,
    mapScopePaths, setMapScope, mapFile, setMapFile, mapBinding, setMapBinding,
    openDiagram, setOpenDiagram, pendingDiagramOpen, requestOpenDiagram, clearDiagramOpen,
    practiceUnit, setPracticeUnit,
    settings, setSettings: setSettingsState,
    content, setContent, sending, stopTurn, progress, liveAnswer, error, send, sendMap, sendPractice, replySource,
    practiceExercise, setPracticeExercise,
  };
}
