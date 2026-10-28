import type { Exercise } from "@codebase-tutor/domain";
import type { ScopedStreamFrame, TurnScene } from "@codebase-tutor/contract";

import type { AskFacet } from "../../source/ask-user.js";
import type { LlmProvider } from "../port/llm-provider.js";
import { LlmAbortedError } from "../port/llm-provider.js";
import { factsToolFor, setDiagramToolFor } from "../../infrastructure/canvas-tools.js";
import { crossRepoFor, searchCorpusFor, turnBudgetGuard } from "../orchestration/paid-turn.js";
import { turnCheckpointChannel } from "../runtime/turn-checkpoint.js";
import { auditsFromResult, recordUnfinishedTurn } from "../runtime/turn-audit.js";
import { abortTurn } from "../runtime/turn-registry.js";
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
} from "../orchestration/scoped-turn.js";
import { type MapChatProgress, type ScopedChatResult, type ScopedChatTurn, mapChat, practiceChat } from "../../turn/run-turn.js";
import { turnTextPayload } from "@codebase-tutor/domain";
import { REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../infrastructure/composition-root.js";
import { traceEngine } from "@codebase-tutor/platform";

/**
  宏观设计与练习答疑两个对话用例，以及带外的「停止生成」。
  能回干净 JSON 的检查都在流开始之前跑完，之后的失败只能变成流里的一帧。
  用例只依赖写过程事件的函数与中止信号。
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

/** 回合的结果：外层据此拼 done 帧。 */
export type ScopedTurnOutcome = Pick<ScopedChatResult, "reply" | "provider" | "interrupted" | "asked"> & {
  /** 这一回合真的画/改过的图；中断的回合也给。 */
  diagram?: { id: string; name: string };
};

/** 已经打开的那条流：写帧与中止信号由传输层给。 */
export interface ScopedTurnStream {
  send: (frame: ScopedStreamFrame) => void;
  signal?: AbortSignal;
}

/** 停止生成的带外入口，只由用户点击触发，断线不算停止。 */
export function stopTurn(turnId: unknown): ChatResult<{ scene: TurnScene }> {
  const stopped = abortTurn(turnId);
  if (!stopped.aborted) return fail("turn-not-in-flight");
  traceEngine("turn_stop", { scene: stopped.scene, turn_id: stopped.turnId, waited_ms: stopped.waitedMs });
  return { ok: true, value: { scene: stopped.scene } };
}

/** 一个回合带给模型的提问与历史，trim 在 prepare 里做一次。 */
export interface PreparedTurn {
  question: string;
  threadId?: string;
  history: ScopedChatTurn[];
}

/** map-chat 发起前检查：仓是否挂载、这一句有没有内容、线程是否还活着。 */
export function prepareMapChat(repositoryId: string, input: { content?: string; threadId?: string }): ChatResult<PreparedTurn> {
  // 只读已挂载对象，不在请求里再挂一次
  const repository = repositoryOr404(repositoryId);
  if (!repository) return fail("repository-missing");
  const question = input.content?.trim();
  if (!question) return fail("content-empty");
  const turn = scopedThreadTurn(repository, input.threadId, "map");
  if (!turn) return fail("thread-missing");
  return { ok: true, value: { question, ...turn } };
}

/** map-chat 流式这一趟：SSE 已开好，这里负责发起调用、中止判定与收尾。 */
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
    // 发起前结算这条线程上不会再被回答的提问
    settleStaleAsks(repository, threadJournal, turn.threadId, input.resumeAsk);
    const threadEvents = repository.audit.read().filter((event) => event.sessionId === turn.threadId);
    const askGiven = !(input.scopePaths?.length || input.path) && consecutiveAskedTurns(threadEvents) < 2;
    let writtenDiagram: { id: string; name: string } | undefined;
    const result = await mapChat({
      repoPath: repository.path, analysis: repository.analysis, scopePaths: input.scopePaths, path: input.path, content: turn.question, history: turn.history, provider,
      style: input.style,
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
      // 认领的那一句必须带 resume 进循环
      ...(input.resumeAsk
        ? { ask: { facets: askGiven ? (["range", "goal"] as AskFacet[]) : [], resume: { toolCallId: input.resumeAsk, answer: turn.question } } }
        : askGiven ? { ask: { facets: ["range", "goal"] as AskFacet[] } } : {}),
      threadId: turn.threadId,
      onProgress: (progress: MapChatProgress) => stream.send(progress),
      diagram: setDiagramToolFor(repository, overlayDatabase, turn.threadId, input.diagramId, (diagram) => { writtenDiagram = diagram; }),
      facts: factsToolFor(repository, overlayDatabase),
      // 同一线程同一问题从这里续跑
      checkpoint: turnCheckpointChannel({ repositoryPath: repository.path, threadId: turn.threadId ?? "", scene: "map.chat", ...(turn.threadId ? {} : { enabled: false }) }),
      budgetGuard: turnBudgetGuard(repository.handle),
      ...(await externalAndSkills()),
      ...(stream.signal ? { signal: stream.signal } : {})
    });
    // 中止晚于最后一趟调用时，这一轮照样作废
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

/** 归属核对过、还没拿到题面与历史的那一段。 */
export interface CheckedPracticeChat {
  question: string;
  exerciseId: string;
  threadId?: string;
}

/** 题与历史都在了，可以发起调用。 */
export type PracticeTurn = PreparedTurn & { exercise: Exercise };

/** 练习答疑发起前的归属核对：仓、内容、练习上下文、线程归属与线程绑的题。 */
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

/** 取题面与历史；排在发起闸门之后。 */
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
  return { ok: true, value: { ...prepared, ...threadScopedHistory(repository.chatStore, prepared.threadId), exercise: stored.exercise } };
}

/** 练习答疑这一趟：与 map-chat 同一条 SSE 协议。 */
export async function runPracticeChat(repositoryId: string, turn: PracticeTurn, style: number, provider: LlmProvider, stream: ScopedTurnStream): Promise<ScopedTurnOutcome> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) throw new Error(REPOSITORY_NOT_MOUNTED);
  const skills = skillsForTurn();
  const result = await practiceChat({
    repoPath: repository.path, exercise: turn.exercise, content: turn.question, history: turn.history, provider, style,
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    ...(skills ? { skills } : {}),
    onProgress: (progress: MapChatProgress) => stream.send(progress),
    ...(stream.signal ? { signal: stream.signal } : {})
  });
  if (stream.signal?.aborted) {
    recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", provider: provider.modelVersion, outcome: "aborted", ...(turn.threadId ? { threadId: turn.threadId } : {}), audits: auditsFromResult(result) });
    throw new LlmAbortedError();
  }
  const journal = repository.audit;
  // 运行期复检先于落库与回放
  result.reply = recheckTurn({ repository, journal, ...(turn.threadId ? { sessionId: turn.threadId } : {}), scene: "practice_chat", question: turn.question, answer: result.reply }).answer;
  persistScopedTurn(repository.chatStore, "practice_chat", turn.threadId, turn.question, result.reply);
  if (result.usage) journal.append("token_usage", {
    input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
    cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "practice_chat"
  }, turn.threadId);
  // found 为 false 的技能读取也入账
  for (const skill of result.skillReads ?? []) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, turn.threadId);
  // 练习答疑的工具调用已由 skill_read 逐条记下，不写 loop_round
  journal.append("turn_context", { scene: "practice_chat", conversation_folded: result.conversation.foldedMessages, conversation_recalled: result.conversation.recalledMessages }, turn.threadId);
  journal.append("turn_text", turnTextPayload("practice_chat", turn.question, result.reply), turn.threadId);
  return { reply: result.reply, provider: result.provider };
}
