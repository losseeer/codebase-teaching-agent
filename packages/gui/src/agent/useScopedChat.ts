import { TutorSession, TutorSettings, defaultTutorSettings } from "@codebase-tutor/domain";
import type { ChatThread, ScopedStreamProgress } from "@codebase-tutor/contract";
import { threadTitleFromQuestion } from "@codebase-tutor/contract";
import type { Exercise } from "@codebase-tutor/domain";

import {useEffect, useRef, useState } from "react";
import { api, isNotFound, subscribeServerEvents, type StreamTurn } from "../api/client";
import { failureText } from "../ui/toast";
import { type Typewriter, useTypewriter } from "./useTypewriter";
import { readDebtMap, writeDebtMap, readThreadMemory, writeThreadMemory, RECHECK_DELAYS, type TurnDebt, type ThreadMemory } from "./chatMemory";
import { CHAT_SCOPE, loadInitialScope, SCOPES, SCOPE_STORAGE_KEY, type MapBinding, type Scope } from "./chatScope";
import { foldProgress, interruptText, progressText } from "./progressLines";
import { threadItemsFrom, type MessageExtra, type ThreadItem, type ThreadRow } from "./threadItems";
import { lostInTransit } from "./turnFailure";
import type { ScopedChatApi } from "./scopedChatApi";

/** 三工作区共用的单一状态源。 */
export function useScopedChat(repositoryId: string): ScopedChatApi {
  const [scope, setScope] = useState<Scope>(loadInitialScope);
  useEffect(() => {
    try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch { /* 持久化失败不回退 */ }
  }, [scope]);

const [threads, setThreads] = useState<Record<Scope, ThreadItem[]>>({ map: [], teaching: [], practice: [] });
const pushMessage = (target: Scope, role: "user" | "agent", text: string, variant?: "error" | "hint" | "ask" | "warn", extra?: MessageExtra): string => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setThreads((prev) => ({ ...prev, [target]: [...prev[target], { kind: role, id, text, ...(variant ? { variant } : {}), ...extra } as ThreadItem] }));
  return id;
};
/** 最后一句提问的气泡 id；开新回合即失效。 */
const [liveAsk, setLiveAsk] = useState<Record<Scope, string | null>>({ map: null, teaching: null, practice: null });

/** 教学域：`file:<path>` 或 `dir:<path>`。 */
const [scopeRef, setScopeRefState] = useState<string | null>(null);
const setScopeRef = (ref: string | null): void => setScopeRefState(ref);
const scopeLabel = scopeRef
  ? (scopeRef.startsWith("dir:") ? (scopeRef.slice(4) === "." ? "仓库根目录" : scopeRef.slice(4)) : scopeRef.slice(5).split("/").pop() ?? scopeRef)
  : "";
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
// 画布选中节点的文件清单，仅作 map-chat 选中范围提示。
const [mapScopePaths, setMapScopePaths] = useState<string[]>([]);
const setMapScope = (scopePaths: string[]): void => setMapScopePaths(scopePaths);
const [mapFile, setMapFile] = useState("");
  const [mapBinding, setMapBinding] = useState<MapBinding | null>(null);
const [openDiagram, setOpenDiagram] = useState<{ id: string; name: string } | null>(null);
// 一次性投递：页面取走后清空。
const [pendingDiagramOpen, setPendingDiagramOpen] = useState<{ id: string; name: string } | null>(null);
const requestOpenDiagram = (diagram: { id: string; name: string }): void => setPendingDiagramOpen(diagram);
const clearDiagramOpen = (): void => setPendingDiagramOpen(null);
const [practiceUnit, setPracticeUnit] = useState("");
useEffect(() => { setScopeRefState(null); setMapScopePaths([]); setMapFile(""); setMapBinding(null); setPracticeUnit(""); setOpenDiagram(null); }, [repositoryId]);
  // 同一条代码问答会话三个名字：库里 chat_session 行 = GUI threadId = 引擎 sessionId。
  const [session, setSession] = useState<TutorSession | null>(null);
  const [settings, setSettingsState] = useState<TutorSettings>(defaultTutorSettings);
  const [drafts, setDrafts] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  // 渲染期镜像：异步路径需读最新草稿。
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftOf = (target: Scope): string => draftsRef.current[target];
  const setDraft = (target: Scope, value: string): void => setDrafts((prev) => ({ ...prev, [target]: value }));
  const content = drafts[scope];
  const setContent = (next: string): void => setDraft(scope, next);
  const [sendingByScope, setSendingByScope] = useState<Record<Scope, boolean>>({ map: false, teaching: false, practice: false });
  const sending = sendingByScope[scope];
  const markSending = (target: Scope, value: boolean): void => setSendingByScope((prev) => ({ ...prev, [target]: value }));
  const [errorsByScope, setErrorByScope] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  const error = errorsByScope[scope];
  const setError = (target: Scope, message: string): void => setErrorByScope((prev) => ({ ...prev, [target]: message }));
  const activeTurn = useRef<Partial<Record<Scope, { turnId: string; controller: AbortController }>>>({});
  const beginTurn = (target: Scope): StreamTurn => {
    const controller = new AbortController();
    const turnId = crypto.randomUUID();
    activeTurn.current = { ...activeTurn.current, [target]: { turnId, controller } };
    return { turnId, signal: controller.signal };
  };
  const endTurn = (target: Scope): void => {
    if (!activeTurn.current[target]) return;
    const next = { ...activeTurn.current };
    delete next[target];
    activeTurn.current = next;
  };
  /** 是否用户主动停止；只能在 catch 里读（finally 会清掉在途引用）。 */
  const stoppedByUser = (target: Scope): boolean => activeTurn.current[target]?.controller.signal.aborted === true;
  const stopTurnFor = (target: Scope): void => {
    const turn = activeTurn.current[target];
    if (!turn) return;
    turn.controller.abort();
    // 404 = 该轮已结束，按停下来处理
    void api.stopTurn(turn.turnId).catch(() => undefined);
  };
  const stopTurn = (): void => stopTurnFor(scope);
  const [progress, setProgress] = useState<Record<Scope, string[]>>({ map: [], teaching: [], practice: [] });
  /** progress 行的渲染期镜像，供异步收尾读取。 */
  const progressLines = useRef<Record<Scope, string[]>>({ map: [], teaching: [], practice: [] });
  const resetProgress = (target: Scope): void => {
    progressLines.current[target] = [];
    setProgress((prev) => ({ ...prev, [target]: [] }));
  };
  const logProgress = (target: Scope, text: string): void => {
    if (!text) return;
    progressLines.current[target] = foldProgress(progressLines.current[target], text);
    setProgress((prev) => ({ ...prev, [target]: progressLines.current[target] }));
  };
  const mapTypewriter = useTypewriter();
  const teachingTypewriter = useTypewriter();
  const practiceTypewriter = useTypewriter();
  const typewriter: Record<Scope, Typewriter> = { map: mapTypewriter, teaching: teachingTypewriter, practice: practiceTypewriter };
  const liveAnswer = typewriter[scope].liveAnswer;
  const [replySource, setReplySource] = useState<Record<Scope, string>>({ map: "", teaching: "", practice: "" });
  const [chatThreads, setChatThreads] = useState<Record<Scope, ChatThread[]>>({ map: [], teaching: [], practice: [] });
  /** 引擎认下来但未发言的会话，不进清单。 */
  const [unsentThread, setUnsentThread] = useState<Partial<Record<Scope, ChatThread>>>({});
  const [currentThreadId, setCurrentThreadId] = useState<Record<Scope, string | null>>({ map: null, teaching: null, practice: null });
  // 渲染期镜像：同步读取此刻的当前线程与清单。
  const currentThreadRef = useRef(currentThreadId);
  currentThreadRef.current = currentThreadId;
  const chatThreadsRef = useRef(chatThreads);
  chatThreadsRef.current = chatThreads;
  const [practiceExercise, setPracticeExerciseState] = useState<Exercise | null>(null);
  const setPracticeExercise = (exercise: Exercise | null): void => {
    setPracticeExerciseState(exercise);
    // 换题即换线程：当前线程清空，下次追问新建。
    if (currentThreadRef.current.practice) switchThread("practice", null);
  };
  useEffect(() => { setPracticeExerciseState(null); }, [repositoryId]);

  /** 写线程记忆；失败静默。 */
  const patchMemory = (scope: Scope, patch: Partial<ThreadMemory>): void => {
    if (!repositoryId) return;
    const chatScope = CHAT_SCOPE[scope];
    const current = readThreadMemory()[repositoryId]?.[chatScope] ?? { currentId: null, ids: [] };
    writeThreadMemory(repositoryId, chatScope, { ...current, ...patch });
  };

  /** 当前线程已知的库里正文条数，回读核对的比对基准。 */
  const knownRowCount = useRef<Record<Scope, number>>({ map: 0, teaching: 0, practice: 0 });
  /** 回读重试计数与定时器句柄；由 patchDebt 统一作废。 */
  const reconcileAttempts = useRef<Record<Scope, number>>({ map: 0, teaching: 0, practice: 0 });
  const recheckTimers = useRef<Record<Scope, number | null>>({ map: null, teaching: null, practice: null });
  /** 补拉结论只存在于本地，库里没有对应正文：回读上屏时按线程补回最后一项。 */
  const backfillNotice = useRef<Record<Scope, { threadId: string; item: ThreadItem } | null>>({ map: null, teaching: null, practice: null });
  const patchNotice = (target: Scope, threadId: string, text: string): void => {
    backfillNotice.current[target] = { threadId, item: { kind: "agent", id: `backfill-${threadId}`, text, variant: "hint" } };
  };
  /** 欠账存 sessionStorage：整页刷新后仍在。 */
  const readDebt = (target: Scope): TurnDebt | null => readDebtMap()[repositoryId]?.[CHAT_SCOPE[target]] ?? null;
  const patchDebt = (target: Scope, debt: TurnDebt | null): void => {
    resetRecheck(target);
    if (debt) backfillNotice.current[target] = null; // 新一轮作废上一轮的补拉结论
    if (!repositoryId) return;
    const map = readDebtMap();
    map[repositoryId] = { ...map[repositoryId], [CHAT_SCOPE[target]]: debt ?? undefined };
    writeDebtMap(map);
  };
  /** 发请求前记欠账，基准取当前已知正文条数。 */
  const recordDebt = (target: Scope, threadId: string): void => {
    patchDebt(target, { threadId, count: knownRowCount.current[target] });
  };
  const hasDebt = (target: Scope): boolean => {
    const debt = readDebt(target);
    const threadId = currentThreadRef.current[target];
    return !!debt && !!threadId && debt.threadId === threadId;
  };

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

  /** 结算断线轮；必须早于新消息上屏（回读会重写侧栏）。 */
  const settlePendingTurn = async (target: Scope): Promise<void> => {
    if (!hasDebt(target)) return;
    await loadThread(target, currentThreadRef.current[target]!);
  };

  const reconcilePending = (): void => {
    for (const target of SCOPES) {
      // 在途回合正文未落库，跳过回读
      if (hasDebt(target) && !activeTurn.current[target]) void loadThread(target, currentThreadRef.current[target]!);
    }
  };
  const reconcilePendingRef = useRef(reconcilePending);
  reconcilePendingRef.current = reconcilePending;
  useEffect(() => {
    const onOnline = (): void => reconcilePendingRef.current();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const triageTurnFailure = (target: Scope, reason: unknown, replayStarted: boolean): void => {
    typewriter[target].abort();
    const detail = reason instanceof Error ? reason.message : String(reason);
    if (stoppedByUser(target)) {
      patchDebt(target, null);
      if (replayStarted) knownRowCount.current[target] += 2; // 该轮已落库，基准同步
      pushMessage(target, "agent", "已停止生成", "hint");
      return;
    }
    if (lostInTransit(reason)) {
      console.warn("[gui] 回合结果未送达", detail);
      pushMessage(target, "agent", "回复未送达，恢复连接后自动补回。", "error");
      return;
    }
    patchDebt(target, null);
    const shown = failureText("发送失败，请重试。", reason);
    setError(target, shown);
    pushMessage(target, "agent", shown, "error");
  };

  const turnSink = (target: Scope): { onDelta: (delta: string) => void; settle: (text: string, provider: string | undefined, extra?: MessageExtra) => Promise<void>; fail: (reason: unknown) => void } => {
    // replayStarted=收到过 delta，即该轮引擎已算完并落库
    let replayStarted = false;
    return {
      onDelta: (delta) => { replayStarted = true; typewriter[target].enqueue(delta); },
      // extra.options 非空 = 本回合是 agent 在向用户提问
      settle: async (text, provider, extra) => {
        await typewriter[target].finish();
        const pushed = pushMessage(target, "agent", text, extra?.options?.length ? "ask" : undefined, extra);
        // 仅最新一句提问可认领
        setLiveAsk((prev) => ({ ...prev, [target]: extra?.options?.length ? pushed : null }));
        setReplySource((prev) => ({ ...prev, [target]: provider ?? "" }));
        typewriter[target].clear();
        knownRowCount.current[target] += 2; // 一问一答原子落库
        patchDebt(target, null);
      },
      fail: (reason) => triageTurnFailure(target, reason, replayStarted)
    };
  };

  const loadThread = async (scope: Scope, threadId: string): Promise<void> => {
    const place = (messages: readonly ThreadRow[]): void => {
      if (currentThreadRef.current[scope] !== threadId) return; // 迟到的旧响应不落进新线程
      reconcile(scope, threadId, messages); // 先核对，补拉结论随这份正文一起上屏
      const items = threadItemsFrom(messages);
      const notice = backfillNotice.current[scope];
      if (notice?.threadId === threadId) items.push(notice.item);
      setThreads((prev) => ({ ...prev, [scope]: items }));
    };
    try {
      if (scope === "teaching") {
        const thread = chatThreadsRef.current.teaching.find((item) => item.id === threadId);
        if (thread && !thread.scopeRef) {
          setCurrentThread("teaching", null);
          pushMessage("teaching", "agent", "这条会话沿用的是旧的目录结构，请重新选一个文件或目录。", "hint");
          return;
        }
        // 代码问答线程绑教学域：左栏随所点线程切换
        if (thread?.scopeRef && thread.scopeRef !== scopeRef) setScopeRefState(thread.scopeRef);
        const restored = await api.getSession(threadId);
        if (restored.repositoryId !== repositoryId) throw new Error("会话不属于当前仓库");
        // 迟到的旧响应不落格
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
      // 正文没读回来就不留旧 session，避免下一问发进上一条线程
      if (scope === "teaching") setSession(null);
      pushMessage(scope, "agent", "历史暂时不可读，请稍后重试或新建会话。", "hint");
    }
  };

  /** 新会话立刻进列表：会话建好、消息还没落库时，清单接口还看不到它。 */
  const rememberThread = (scope: Scope, thread: { id: string; title?: string }): void => {
    const list = chatThreadsRef.current[scope];
    if (list.some((item) => item.id === thread.id)) return;
    const now = new Date().toISOString();
    const placeholder: ChatThread = {
      id: thread.id,
      repositoryId,
      scope: CHAT_SCOPE[scope],
      title: thread.title ?? "（新会话）",
      createdAt: now,
      updatedAt: now
    };
    const next = [placeholder, ...list];
    setChatThreads((prev) => ({ ...prev, [scope]: next }));
    chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: next };
  };

  /** 只改当前线程 id，不动侧栏已展示的对话。 */
  const markCurrentThread = (scope: Scope, threadId: string): void => {
    setCurrentThreadId((prev) => ({ ...prev, [scope]: threadId }));
    currentThreadRef.current = { ...currentThreadRef.current, [scope]: threadId };
    patchMemory(scope, { currentId: threadId });
  };

  /** 切当前线程并回读正文；null 清空侧栏。 */
  const setCurrentThread = (scope: Scope, threadId: string | null): void => {
    if (threadId) markCurrentThread(scope, threadId);
    else {
      setCurrentThreadId((prev) => ({ ...prev, [scope]: null }));
      currentThreadRef.current = { ...currentThreadRef.current, [scope]: null };
      patchMemory(scope, { currentId: null });
    }
    if (!threadId) { setThreads((prev) => ({ ...prev, [scope]: [] })); knownRowCount.current[scope] = 0; if (scope === "teaching") setSession(null); return; }
    void loadThread(scope, threadId);
  };
  const switchThread = (scope: Scope, threadId: string | null): void => setCurrentThread(scope, threadId);

  /** 拉线程清单（引擎为准，倒序）；current 回认未发言的当前会话。 */
  const refreshThreads = async (scope: Scope): Promise<{ threads: ChatThread[]; current: ChatThread | null }> => {
    if (!repositoryId) return { threads: [], current: null };
    // 须在发请求前快照当前线程：await 之后的值会剪错
    const remembered = readThreadMemory()[repositoryId]?.[CHAT_SCOPE[scope]]?.currentId ?? null;
    const opened = currentThreadRef.current[scope] ?? remembered;
    let list: ChatThread[];
    let current: ChatThread | null;
    try {
      const fetched = await api.listThreads(repositoryId, CHAT_SCOPE[scope], opened ?? undefined);
      list = fetched.threads;
      current = fetched.current;
    } catch {
      // 清单暂时拿不到：保留上次所见，不清空选择
      return { threads: chatThreadsRef.current[scope], current: null };
    }
    // 服务端清单只收有正文的会话：当前这条还没落消息时，不能把它从列表与记忆里抹掉
    const existing = chatThreadsRef.current[scope].find((item) => item.id === opened);
    const merged = opened && existing && !list.some((item) => item.id === opened) ? [existing, ...list] : list;
    setChatThreads((prev) => ({ ...prev, [scope]: merged }));
    chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: merged };
    setUnsentThread((prev) => ({ ...prev, [scope]: current && !merged.some((item) => item.id === current.id) ? current : null }));
    patchMemory(scope, { ids: merged.map((item) => item.id) });
    if (opened && !merged.some((item) => item.id === opened) && current?.id !== opened) setCurrentThread(scope, null);
    return { threads: list, current };
  };

  /** 建线程（引擎发 id）；仅在确有第一句话时调用。 */
  const createThreadFor = async (scope: "map" | "practice", firstQuestion?: string): Promise<string | null> => {
    if (!repositoryId) return null;
    const title = firstQuestion ? threadTitleFromQuestion(firstQuestion) : "";
    try {
      const { thread } = await api.createThread(repositoryId, {
        scope: CHAT_SCOPE[scope],
        ...(scope === "practice" && practiceExercise ? { exerciseId: practiceExercise.id } : {}),
        ...(title ? { title } : {})
      });
      rememberThread(scope, thread);
      return thread.id;
    } catch (reason) {
      setError(scope, failureText("新建会话失败", reason));
      return null;
    }
  };

  const newThread = (scope: Scope): void => {
    setCurrentThread(scope, null);
  };

  const renameThread = async (scope: Scope, threadId: string, title: string): Promise<void> => {
    try {
      const { thread } = await api.renameThread(threadId, title);
      const list = chatThreadsRef.current[scope].map((item) => (item.id === threadId ? thread : item));
      setChatThreads((prev) => ({ ...prev, [scope]: list }));
      chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: list };
    } catch (reason) {
      setError(scope, failureText("重命名失败", reason));
      void refreshThreads(scope);
    }
  };

  /** 软删：正文与审计日志留库，仅从列表消失。 */
  const removeThread = async (scope: Scope, threadId: string): Promise<void> => {
    try {
      await api.deleteThread(threadId);
    } catch (reason) {
      // 404 = 引擎侧已不存在，视为删除成功
      if (!isNotFound(reason)) {
        setError(scope, failureText("删除会话失败", reason));
        return;
      }
    }
    const list = chatThreadsRef.current[scope].filter((item) => item.id !== threadId);
    setChatThreads((prev) => ({ ...prev, [scope]: list }));
    chatThreadsRef.current = { ...chatThreadsRef.current, [scope]: list };
    // 未发言线程不在清单里，只能在此摘除
    setUnsentThread((prev) => (prev[scope]?.id === threadId ? { ...prev, [scope]: null } : prev));
    patchMemory(scope, { ids: list.map((item) => item.id) });
    if (currentThreadRef.current[scope] === threadId) setCurrentThread(scope, null);
  };

  // 挂载/换仓库：各工作区拉清单；teaching 的当前线程由下面的教学域效应决定。
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
        const stillOpen = remembered && (current?.id === remembered || list.some((item) => item.id === remembered));
        setCurrentThread(scope, stillOpen ? remembered : (list[0]?.id ?? null));
      }
      void refreshThreads("teaching");
    };
    void boot();
    return () => { cancelled = true; };
  }, [repositoryId]);

  useEffect(() => {
    if (repositoryId) void refreshThreads(scope);
  }, [repositoryId, scope]);

  // 清单可能滞后一拍，此时不动线程；已停在目标线程也不再回读。
  useEffect(() => {
    if (!repositoryId || !scopeRef) return;
    // 代码问答回合在途时不动线程：清栏或回读都会覆盖侧栏
    if (activeTurn.current.teaching) return;
    const list = chatThreadsRef.current.teaching;
    const current = currentThreadRef.current.teaching;
    const currentThread = current ? list.find((item) => item.id === current) : undefined;
    if (current && !currentThread) {
      // 清单只列已发言的会话；缺席 = 还没发言
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
    const message = draftOf("teaching").trim();
    if (!message) return;
    // 用户说出口的话先上屏：缺教学域的守卫只补提示，不丢弃这句
    await settlePendingTurn("teaching");
    pushMessage("teaching", "user", message);
    setDraft("teaching", "");
    if (!scopeRef) {
      pushMessage("teaching", "agent", "先在左栏选一个文件或目录，再回到这里对话。", "hint");
      return;
    }
    markSending("teaching", true); setError("teaching", ""); resetProgress("teaching"); logProgress("teaching", "正在准备问答上下文…");
    const turn = beginTurn("teaching");
    const sink = turnSink("teaching");
    try {
      let active = session;
      if (!active) {
        const created = await api.createSession(repositoryId, scopeRef, settings);
        active = created.session;
        // 仅在设置未被用户改动时以推荐值种子
        if (settings.pedagogy === "socratic" && settings.depth === "macro") setSettingsState(created.recommendedSettings.settings);
        markCurrentThread("teaching", active.id);
        knownRowCount.current.teaching = 0;
        rememberThread("teaching", active);
      }
      if (!active) return;
      typewriter.teaching.begin();
      recordDebt("teaching", active.id);
      const reply = await api.sendMessageStream(active.id, message, settings, (event) => {
        if (event.type === "delta") sink.onDelta(event.delta);
        else if (event.type === "progress") logProgress("teaching", progressText(event.payload));
      }, turn);
      setSession(reply.session);
      setSettingsState(reply.session.settings);
      await sink.settle(reply.message.content, reply.provider);
    } catch (reason) {
      sink.fail(reason);
    } finally {
      endTurn("teaching");
      markSending("teaching", false);
      resetProgress("teaching");
      // 消息落库后再拉一次清单：标题与顺序以引擎为准
      void refreshThreads("teaching");
    }
  };

  // GUI 只上送这一句，历史由引擎按 threadId 自取；answer 代替输入框发送，resumeAsk 是提问的认领句柄。
  const sendScoped = async (scope: "map" | "practice", answer?: string, resumeAsk?: string): Promise<void> => {
    const message = (answer ?? draftOf(scope)).trim();
    if (!message || !repositoryId) return;
    setLiveAsk((prev) => ({ ...prev, [scope]: null }));
    await settlePendingTurn(scope);
    pushMessage(scope, "user", message);
    if (answer === undefined) setDraft(scope, "");
    if (scope === "practice" && !practiceExercise) {
      pushMessage("practice", "agent", "先在练习页生成一道练习，再在这里追问。", "hint");
      return;
    }
    const threadId = currentThreadRef.current[scope] ?? await createThreadFor(scope, message);
    if (!threadId) return;
    if (!currentThreadRef.current[scope]) { markCurrentThread(scope, threadId); knownRowCount.current[scope] = 0; }
    markSending(scope, true); setError(scope, ""); resetProgress(scope); logProgress(scope, "回复生成中…");
    typewriter[scope].begin();
    const turn = beginTurn(scope);
    recordDebt(scope, threadId);
    const sink = turnSink(scope);
    const onScopedEvent = (event: ScopedStreamProgress): void => {
      if (event.type === "delta") sink.onDelta(event.delta);
      else logProgress(scope, progressText(event));
    };
    try {
      const reply = scope === "map"
        ? await api.mapChatStream(repositoryId, {
            content: message,
            ...(mapScopePaths.length ? { scopePaths: mapScopePaths } : {}),
            path: mapFile || undefined,
            ...(openDiagram ? { diagramId: openDiagram.id } : {}),
            ...(resumeAsk ? { resumeAsk } : {}),
            threadId
          }, onScopedEvent, turn)
        : await api.practiceChat(repositoryId, { content: message, exerciseId: practiceExercise!.id, threadId }, onScopedEvent, turn);
      if (reply.interrupted) {
        // 中断轮未落库，补账基准不动
        pushMessage(scope, "agent", interruptText(reply.interrupted.reason), "warn", { retry: message, lines: progressLines.current[scope] });
        patchDebt(scope, null);
      } else {
        await sink.settle(reply.reply, reply.provider, reply.asked ? { options: reply.asked.options, askId: reply.asked.toolCallId } : undefined);
        if (scope === "map" && reply.diagram?.id) pushMessage("map", "agent", "", undefined, { card: { diagramId: reply.diagram.id, name: reply.diagram.name || "未命名图" } });
      }
    } catch (reason) {
      sink.fail(reason);
    } finally {
      typewriter[scope].stop();
      endTurn(scope);
      markSending(scope, false);
      resetProgress(scope);
      void refreshThreads(scope);
    }
  };
  const sendMap = (answer?: string, resumeAsk?: string): Promise<void> => sendScoped("map", answer, resumeAsk);
  const sendPractice = (answer?: string): Promise<void> => sendScoped("practice", answer);

  return {
    scope, setScope,
    threads, pushMessage,
    chatThreads, currentThreadId, newThread, switchThread, renameThread, removeThread,
    scopeRef, scopeLabel, setScopeRef, dataVersion, reloadRepositoryData,
    mapScopePaths, setMapScope, mapFile, setMapFile, mapBinding, setMapBinding,
    openDiagram, setOpenDiagram, pendingDiagramOpen, requestOpenDiagram, clearDiagramOpen,
    practiceUnit, setPracticeUnit,
    settings, setSettings: setSettingsState,
    content, setContent, sending, stopTurn, progress, liveAnswer, error, send, sendMap, sendPractice, replySource, liveAsk,
    practiceExercise, setPracticeExercise,
  };
}
