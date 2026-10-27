import type { Exercise } from "@codebase-tutor/domain";
import type { ScopedStreamFrame, TurnScene } from "@codebase-tutor/contract";

import type { AskFacet } from "../../source/ask-user.js";
import type { LlmProvider } from "../../adapter/outbound/llm/provider.js";
import { LlmAbortedError } from "../../adapter/outbound/llm/provider.js";
import { factsToolFor, setDiagramToolFor } from "../../infrastructure/canvas-tools.js";
import { crossRepoFor, searchCorpusFor, turnBudgetGuard } from "../paid-turn.js";
import { turnCheckpointChannel } from "../turn-checkpoint.js";
import { auditsFromResult, recordUnfinishedTurn } from "../turn-audit.js";
import { abortTurn } from "../turn-registry.js";
import {
  consecutiveAskedTurns,
  externalAndSkills,
  finishMapChatTurn,
  persistScopedTurn,
  recheckTurn,
  scopedThread,
  scopedThreadTurn,
  settleStaleAsks,
  skillsForTurn,
  threadScopedHistory
} from "../scoped-turn.js";
import { type MapChatProgress, type ScopedChatResult, type ScopedChatTurn, mapChat, practiceChat } from "../../turn/run-turn.js";
import { readJournal, turnTextPayload } from "../../adapter/outbound/persistence/journal.js";
import { REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../infrastructure/composition-root.js";
import { traceEngine } from "@codebase-tutor/platform";

/**
  三作用域对话中的两个（宏观设计 / 练习答疑）与带外「停止生成」的用例。

  切在「开火」这条线上，不切在文件里：能回干净 JSON 的判断全在 hijack 之前跑完（仓在不在、这一句有没有
  内容、这条线程还活着吗、题还在不在），hijack 之后失败只能变成流里的一帧。所以每条流两段——
  `prepare*` / `load*` 回失败种类（controller 一对一翻状态码），`run*` 只抛错
  （controller 的 catch 用同一套 `failScopedTurn` 收尾，中止与出错才分得开）。

  用例里不出现 fastify，也不出现 reply：流式侧要的只是「能把过程事件写出去」这一个函数和一个中止信号，
  帧的形状、心跳、`reply.raw.end()` 都留在传输层。
*/
export type ChatFailure =
  | "repository-missing"
  | "content-empty"
  | "thread-missing"
  | "exercise-context-missing"
  | "exercise-thread-mismatch"
  | "exercise-missing"
  | "turn-not-in-flight";

export type ChatResult<T> = { ok: true; value: T } | { ok: false; failure: ChatFailure };

const fail = (failure: ChatFailure): { ok: false; failure: ChatFailure } => ({ ok: false, failure });

/** 开火之后用例往外给的那一份料：controller 只照着它拼 done 帧，不再读回合内部。 */
export type ScopedTurnOutcome = Pick<ScopedChatResult, "reply" | "provider" | "interrupted" | "asked"> & {
  /** 这一回合真的画/改过的图（`set_diagram` 落过笔才有）：中断的回合也要给，那几笔是真发生过的事。 */
  diagram?: { id: string; name: string };
};

/** 已经打开的那条流：写帧与中止信号由传输层给，用例不负责开也不负责关。 */
export interface ScopedTurnStream {
  send: (frame: ScopedStreamFrame) => void;
  signal?: AbortSignal;
}

/** 「停止生成」的带外入口（三作用域共用）：GUI 点停止时先打这里，再断开自己的 SSE 连接。
    单独一条而不是「连接断了就中止」：客户端消失分不出是用户要停还是网络波动 / 刷新页面，
    后者引擎必须把这一轮算完并落库（见 application/turn-registry.ts）。
    未命中 = 这一轮已经结束或本来就没登记，回 404，GUI 照常收尾、不当成错误。 */
export function stopTurn(turnId: unknown): ChatResult<{ scene: TurnScene }> {
  const stopped = abortTurn(turnId);
  if (!stopped.aborted) return fail("turn-not-in-flight");
  traceEngine("turn_stop", { scene: stopped.scene, turn_id: stopped.turnId, waited_ms: stopped.waitedMs });
  return { ok: true, value: { scene: stopped.scene } };
}

/** 一个回合要带给模型的提问与历史：`trim` 在 prepare 里做一次，模型、落库、审计读的是同一份文本。
    两条流共用这一份形状（练习答疑在它上面再挂题面），所以名字不带作用域。 */
export interface PreparedTurn {
  question: string;
  threadId?: string;
  history: ScopedChatTurn[];
}

/** map-chat 开火前：仓挂着吗、这一句有没有内容、这条线程还活着吗。 */
export function prepareMapChat(repositoryId: string, input: { content?: string; threadId?: string }): ChatResult<PreparedTurn> {
  // `repositoryOr404` 只读那份已挂载对象，不趁请求再挂一次：真被 LRU 挤出去了就回「打不开」，不让一次对话顺带付一遍导入
  const repository = repositoryOr404(repositoryId);
  if (!repository) return fail("repository-missing");
  const question = input.content?.trim();
  if (!question) return fail("content-empty");
  const turn = scopedThreadTurn(repository, input.threadId, "map");
  if (!turn) return fail("thread-missing");
  return { ok: true, value: { question, ...turn } };
}

/**
  map-chat 流式这一趟：SSE 已经开好，这里负责开火、中止判定与收尾，把帧要带的料交回去。
  过程事件（thinking / reading / searching）直接写进那条流，GUI 借此显示「回复生成中 / 正在读取 xx / 正在检索 xx」。
*/
export async function runMapChat(
  repositoryId: string,
  turn: PreparedTurn,
  input: { scopePaths?: string[]; path?: string; style: number; diagramId?: string; resumeAsk?: string },
  provider: LlmProvider,
  stream: ScopedTurnStream
): Promise<ScopedTurnOutcome> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) throw new Error(REPOSITORY_NOT_MOUNTED);
  const crossFiles = new Map<string, number>();
  const overlayDatabase = repository.handle.pin();
  const threadJournal = repository.audit;
  try {
    // 开火前先结算这条线程上不会再被回答的提问（过期 / 换话题），认领不算换话题
    settleStaleAsks(repository, threadJournal, turn.threadId, input.resumeAsk);
    const threadEvents = readJournal(repository.path).filter((event) => event.sessionId === turn.threadId);
    // 连续两回合都在问 ⇒ 这一轮不给提问通道（第三句该按默认答并写明假设）；范围已知的回合本来就不缺那一格
    const askGiven = !(input.scopePaths?.length || input.path) && consecutiveAskedTurns(threadEvents) < 2;
    let writtenDiagram: { id: string; name: string } | undefined;
    const result = await mapChat({
      repoPath: repository.path, analysis: repository.analysis, scopePaths: input.scopePaths, path: input.path, content: turn.question, history: turn.history, provider,
      style: input.style,
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
      // 缺哪一格由上下文判：画布已选中文件或绑定路径 = 范围不缺；「缺意图」这一格交给模型按工具里写死的判据核。
      // 认领的那一句必须带着 `resume` 进循环（否则答句就变成一句新提问），但能不能再问一句照旧受同一道闸管
      ...(input.resumeAsk
        ? { ask: { facets: askGiven ? (["range", "goal"] as AskFacet[]) : [], resume: { toolCallId: input.resumeAsk, answer: turn.question } } }
        : askGiven ? { ask: { facets: ["range", "goal"] as AskFacet[] } } : {}),
      threadId: turn.threadId,
      onProgress: (progress: MapChatProgress) => stream.send(progress),
      diagram: setDiagramToolFor(repository, overlayDatabase, turn.threadId, input.diagramId, (diagram) => { writtenDiagram = diagram; }),
      facts: factsToolFor(repository, overlayDatabase),
      // 中断恢复：同一线程同一问题的残局（进程被杀、端点报错）从这里接上，已读到的源码不必再付一遍
      checkpoint: turnCheckpointChannel({ repositoryPath: repository.path, threadId: turn.threadId ?? "", scene: "map.chat", ...(turn.threadId ? {} : { enabled: false }) }),
      budgetGuard: turnBudgetGuard(repository.handle),
      ...(await externalAndSkills()),
      ...(stream.signal ? { signal: stream.signal } : {})
    });
    // 中止若晚于最后一趟 LLM 到达，这一轮照样作废：不落库也不回放（与教学回合同一口径）
    if (stream.signal?.aborted) {
      recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "map_chat", provider: provider.modelVersion, outcome: "aborted", threadId: turn.threadId, audits: auditsFromResult(result) });
      throw new LlmAbortedError();
    }
    finishMapChatTurn(repository, provider, turn.threadId, turn.question, result, crossFiles);
    return {
      reply: result.reply,
      provider: result.provider,
      ...(result.interrupted ? { interrupted: result.interrupted } : {}),
      ...(result.asked ? { asked: result.asked } : {}),
      ...(writtenDiagram ? { diagram: writtenDiagram } : {})
    };
  } finally {
    repository.handle.unpin();
  }
}

/** 归属核对过、但还没拿到题面与历史的那一段：`loadPracticeExercise` 吃它。 */
export interface CheckedPracticeChat {
  question: string;
  exerciseId: string;
  threadId?: string;
}

/** 题与历史都在了，可以开火。 */
export type PracticeTurn = PreparedTurn & { exercise: Exercise };

/** 练习答疑开火前的归属核对：仓、内容、练习上下文、线程归属、线程绑的题是不是这一道。
    线程绑题（`exercise_id` 由 GUI 建线程时给出）：换题走新建线程，这里拒掉「拿着 A 题的会话问 B 题」。 */
export function preparePracticeChat(repositoryId: string, input: { content?: string; threadId?: string; exerciseId?: string }): ChatResult<CheckedPracticeChat> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return fail("repository-missing");
  const question = input.content?.trim();
  if (!question) return fail("content-empty");
  if (!input.exerciseId) return fail("exercise-context-missing");
  const thread = input.threadId ? scopedThread(repository, input.threadId, "practice") : undefined;
  if (input.threadId && !thread) return fail("thread-missing");
  if (thread?.exerciseId && thread.exerciseId !== input.exerciseId) return fail("exercise-thread-mismatch");
  return { ok: true, value: { question, exerciseId: input.exerciseId, ...(thread ? { threadId: thread.id } : {}) } };
}

/** 题面与历史：单独一段、由 controller 排在开火闸门之后，为的是「确定要开火了才切 SSE」，404 仍是干净的 JSON。 */
export function loadPracticeExercise(repositoryId: string, prepared: CheckedPracticeChat): ChatResult<PracticeTurn> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return fail("repository-missing");
  const database = repository.handle.pin();
  let stored: { exercise: Exercise } | undefined;
  try {
    stored = database.exercises.byId<{ exercise: Exercise }>(repository.index.repositoryId, prepared.exerciseId);
  } finally {
    repository.handle.unpin();
  }
  if (!stored) return fail("exercise-missing");
  return { ok: true, value: { ...prepared, ...threadScopedHistory(repository.path, prepared.threadId), exercise: stored.exercise } };
}

/** 练习答疑这一趟：与 map-chat/stream 同款 SSE，GUI 三作用域的流式解析共用一条路径。 */
export async function runPracticeChat(repositoryId: string, turn: PracticeTurn, style: number, provider: LlmProvider, stream: ScopedTurnStream): Promise<ScopedTurnOutcome> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) throw new Error(REPOSITORY_NOT_MOUNTED);
  // 技能清单与取正文通道同时给或同时不给：没装技能时这一轮与从前逐字一致（单轮、无工具）
  const skills = skillsForTurn();
  const result = await practiceChat({
    repoPath: repository.path, exercise: turn.exercise, content: turn.question, history: turn.history, provider, style,
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    ...(skills ? { skills } : {}),
    // 过程帧与 map-chat 并进同一条流：练习答疑能做的工具动作少，但能报的每一步都要报得出来，不然界面只剩一行「生成中」
    onProgress: (progress: MapChatProgress) => stream.send(progress),
    ...(stream.signal ? { signal: stream.signal } : {})
  });
  if (stream.signal?.aborted) {
    recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", provider: provider.modelVersion, outcome: "aborted", ...(turn.threadId ? { threadId: turn.threadId } : {}), audits: auditsFromResult(result) });
    throw new LlmAbortedError();
  }
  const journal = repository.audit;
  // 运行期复检（零 token）先于落库与回放：练习答疑同样会引用仓库里的代码位置，尾注要进同一份正文
  result.reply = recheckTurn({ repository, journal, ...(turn.threadId ? { sessionId: turn.threadId } : {}), scene: "practice_chat", question: turn.question, answer: result.reply }).answer;
  persistScopedTurn(repository.path, "practice_chat", turn.threadId, turn.question, result.reply);
  if (result.usage) journal.append("token_usage", {
    input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
    cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "practice_chat"
  }, turn.threadId);
  // 取过哪份技能正文逐条留痕（`found:false` 也记：那是清单与提示词漂移的读数）
  for (const skill of result.skillReads ?? []) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, turn.threadId);
  // 练习答疑只有「取技能正文」这一类工具调用，逐条已由 skill_read 记下；不写 loop_round（那条记的是文件与检索工具的轮次）
  // 上下文折叠的读数照样有地方
  journal.append("turn_context", { scene: "practice_chat", conversation_folded: result.conversation.foldedMessages, conversation_recalled: result.conversation.recalledMessages }, turn.threadId);
  journal.append("turn_text", turnTextPayload("practice_chat", turn.question, result.reply), turn.threadId);
  return { reply: result.reply, provider: result.provider };
}
