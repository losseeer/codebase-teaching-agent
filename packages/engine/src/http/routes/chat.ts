import type { Exercise } from "@codebase-tutor/domain";
import { validateStyle } from "@codebase-tutor/domain";

import type { AskFacet } from "../../source/ask-user.js";
import { factsToolFor, setDiagramToolFor } from "../../application/canvas-tools.js";
import { crossRepoFor, searchCorpusFor, turnBudgetGuard } from "../../application/paid-turn.js";
import { turnCheckpointChannel } from "../../application/turn-checkpoint.js";
import { externalAndSkills, finishMapChatTurn, persistScopedTurn, recheckTurn, scopedThread, scopedThreadTurn, skillsForTurn, threadScopedHistory, consecutiveAskedTurns, settleStaleAsks } from "../../application/scoped-turn.js";
import { auditsFromResult, recordUnfinishedTurn } from "../../application/turn-audit.js";
import { sanitizeAskId, sanitizeDiagramId, sanitizeScopePaths, sanitizeThreadId } from "../../http/input.js";
import { scopedChatProviderOr422 } from "../gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../../http/sse.js";
import { turnTextPayload } from "../../store/journal.js";
import { LlmAbortedError } from "../../llm/provider.js";
import { type MapChatProgress, mapChat, practiceChat } from "../../turn/run-turn.js";
import { REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../services.js";
import { Journal, readJournal } from "../../store/journal.js";
import { markThread } from "@codebase-tutor/platform";
import { traceEngine } from "@codebase-tutor/platform";
import { abortTurn } from "../../application/turn-registry.js";
import type { FastifyInstance } from "fastify";

/**
  三作用域对话中的两个（宏观设计 / 练习答疑）：map-chat 流式、practice-chat 流式、以及带外的「停止生成」。
  开火闸门 `scopedChatProviderOr422` 有三个调用点（本文件两处、教学回合 `teaching.ts` 一处），共用同一句 422 文案。
 */
export function registerChatRoutes(app: FastifyInstance): void {
/** 「停止生成」的带外入口（三作用域共用）：GUI 点停止时先打这里，再断开自己的 SSE 连接。
    单独一条而不是「连接断了就中止」：客户端消失分不出是用户要停还是网络波动 / 刷新页面，
    后者引擎必须把这一轮算完并落库（见 application/turn-registry.ts）。
    未命中 = 这一轮已经结束或本来就没登记，回 404，GUI 照常收尾、不当成错误。 */
app.post<{ Body: { turnId?: unknown } }>("/api/turns/stop", async (request, reply) => {
  const stopped = abortTurn(request.body?.turnId);
  if (!stopped.aborted) {
    return reply.code(404).send({ stopped: false });
  }
  traceEngine("turn_stop", { scene: stopped.scene, turn_id: stopped.turnId, waited_ms: stopped.waitedMs });
  return { stopped: true, scene: stopped.scene };
});

/** map-chat 流式版：SSE 推送过程事件（thinking / reading / searching），GUI 借此显示「回复生成中 / 正在读取 xx / 正在检索 xx」。 */
app.post<{ Params: { repositoryId: string }; Body: { content?: string; scopePaths?: string[]; path?: string; threadId?: unknown; style?: unknown; turnId?: unknown; diagramId?: unknown; resumeAsk?: unknown } }>("/api/repositories/:repositoryId/map-chat/stream", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const turn = scopedThreadTurn(repository, sanitizeThreadId(request.body?.threadId), "map");
  if (!turn) return reply.code(409).send({ error: "这个会话已经不在了，请新建一个再问。" });
  markThread(turn.threadId);
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  const { send, turnHandle } = beginScopedStream(request, reply, "map_chat", request.body?.turnId);
  const crossFiles = new Map<string, number>();
  const overlayDatabase = repository.handle.pin();
  // 认领的那一句：内容就是用户选中的答句，`resumeAsk` 带着当时挂着的调用 id 回来
  const resumeAskId = sanitizeAskId(request.body?.resumeAsk);
  const threadJournal = new Journal(repository.path, repository.index.repositoryId);
  // 开火前先结算这条线程上不会再被回答的提问（过期 / 换话题），认领不算换话题
  settleStaleAsks(repository, threadJournal, turn.threadId, resumeAskId);
  const threadEvents = readJournal(repository.path).filter((event) => event.sessionId === turn.threadId);
  // 连续两回合都在问 ⇒ 这一轮不给提问通道（第三句该按默认答并写明假设）；范围已知的回合本来就不缺那一格
  const rangeKnown = Boolean(sanitizeScopePaths(request.body?.scopePaths)?.length || request.body?.path);
  const askGiven = !rangeKnown && consecutiveAskedTurns(threadEvents) < 2;
  try {
    let writtenDiagram: { id: string; name: string } | undefined;
    const diagramContext = setDiagramToolFor(repository, overlayDatabase, turn.threadId, sanitizeDiagramId(request.body?.diagramId), (diagram) => { writtenDiagram = diagram; });
    const factsContext = factsToolFor(repository, overlayDatabase);
    const result = await mapChat({
      repoPath: repository.path, analysis: repository.analysis, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, content, history: turn.history, provider,
      style: validateStyle(request.body?.style),
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
      // 缺哪一格由上下文判：画布已选中文件或绑定路径 = 范围不缺；「缺意图」这一格交给模型按工具里写死的判据核。
      // 认领的那一句必须带着 `resume` 进循环（否则答句就变成一句新提问），但能不能再问一句照旧受同一道闸管
      ...(resumeAskId
        ? { ask: { facets: askGiven ? (["range", "goal"] as AskFacet[]) : [], resume: { toolCallId: resumeAskId, answer: content } } }
        : askGiven ? { ask: { facets: ["range", "goal"] as AskFacet[] } } : {}),
      threadId: turn.threadId,
      onProgress: (progress: MapChatProgress) => send(progress),
      diagram: diagramContext,
      facts: factsContext,
      // 中断恢复：同一线程同一问题的残局（进程被杀、端点报错）从这里接上，已读到的源码不必再付一遍
      checkpoint: turnCheckpointChannel({ repositoryPath: repository.path, threadId: turn.threadId ?? "", scene: "map.chat", ...(turn.threadId ? {} : { enabled: false }) }),
      budgetGuard: turnBudgetGuard(repository.handle),
      ...(await externalAndSkills()),
      ...(turnHandle.signal ? { signal: turnHandle.signal } : {})
    });
    // 中止若晚于最后一趟 LLM 到达，这一轮照样作废：不落库也不回放（与教学回合同一口径）
    if (turnHandle.signal?.aborted) {
      recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "map_chat", provider: provider.modelVersion, outcome: "aborted", threadId: turn.threadId, audits: auditsFromResult(result) });
      throw new LlmAbortedError();
    }
    finishMapChatTurn(repository, provider, turn.threadId, content, result, crossFiles);
    // 图卡片两条路都要给：中断前可能已经落了几笔改图，那些是真发生过的事
    const diagramFrame = writtenDiagram ? { diagram: writtenDiagram } : {};
    if (result.interrupted) {
      // 不出成品的一轮：不回放正文，只把原因交给界面那条 warn 条（带重试）
      send({ type: "done", interrupted: result.interrupted, provider: result.provider, ...diagramFrame });
    } else {
      replayTypewriter(send, result.reply);
      send({ type: "done", reply: result.reply, provider: result.provider, ...diagramFrame, ...(result.asked ? { asked: result.asked } : {}) });
    }
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "map_chat", turnHandle, provider: provider.modelVersion, threadId: turn.threadId, error, fallbackError: "LLM 对话失败" });
  } finally {
    turnHandle.dispose();
    repository.handle.unpin();
  }
  reply.raw.end();
});

app.post<{ Params: { repositoryId: string }; Body: { content?: string; exerciseId?: string; threadId?: unknown; style?: unknown; turnId?: unknown } }>("/api/repositories/:repositoryId/practice-chat", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  if (!request.body?.exerciseId) return reply.code(400).send({ error: "缺少练习上下文；请先在练习页生成一道练习。" });
  const threadId = sanitizeThreadId(request.body?.threadId);
  const thread = threadId ? scopedThread(repository, threadId, "practice") : undefined;
  if (threadId && !thread) return reply.code(409).send({ error: "这个会话已经不在了，请新建一个再问。" });
  // 线程绑题（exercise_id 由 GUI 建线程时给出）：换题走新建线程，这里拒掉「拿着 A 题的会话问 B 题」
  if (thread?.exerciseId && thread.exerciseId !== request.body.exerciseId) return reply.code(409).send({ error: "该会话属于另一道练习；请新建会话后再追问。" });
  markThread(thread?.id);
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  // 练习查询留在 hijack 前：404 还是干净的 JSON，确定要开火了才切 SSE
  const database = repository.handle.pin();
  let stored: { exercise: Exercise } | undefined;
  try {
    stored = database.getExerciseCacheById<{ exercise: Exercise }>(repository.index.repositoryId, request.body.exerciseId);
  } finally {
    repository.handle.unpin();
  }
  if (!stored) return reply.code(404).send({ error: "练习不存在或已被清理；请重新生成练习。" });
  const { history } = threadScopedHistory(repository.path, thread?.id);
  // 与 map-chat/stream 同款 SSE：delta 打字机回放 + done/error——GUI 三作用域的流式解析共用一条路径
  const { send, turnHandle } = beginScopedStream(request, reply, "practice_chat", request.body?.turnId);
  try {
    // 技能清单与取正文通道同时给或同时不给：没装技能时这一轮与从前逐字一致（单轮、无工具）
    const skills = skillsForTurn();
    const result = await practiceChat({ repoPath: repository.path, exercise: stored.exercise, content, history, provider, style: validateStyle(request.body?.style), ...(thread?.id ? { threadId: thread.id } : {}), ...(skills ? { skills } : {}), ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    if (turnHandle.signal?.aborted) {
      recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", provider: provider.modelVersion, outcome: "aborted", ...(thread?.id ? { threadId: thread.id } : {}), audits: auditsFromResult(result) });
      throw new LlmAbortedError();
    }
    const journal = new Journal(repository.path, repository.index.repositoryId);
    // 运行期复检（零 token）先于落库与回放：练习答疑同样会引用仓库里的代码位置，尾注要进同一份正文
    result.reply = recheckTurn({ repository, journal, sessionId: thread?.id, scene: "practice_chat", question: content, answer: result.reply }).answer;
    persistScopedTurn(repository.path, "practice_chat", thread?.id, content, result.reply);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "practice_chat"
    }, thread?.id);
    // 取过哪份技能正文逐条留痕（`found:false` 也记：那是清单与提示词漂移的读数）
    for (const skill of result.skillReads ?? []) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, thread?.id);
    // 练习答疑只有「取技能正文」这一类工具调用，逐条已由 skill_read 记下；不写 loop_round（那条记的是文件与检索工具的轮次）
    // 上下文折叠的读数照样有地方
    journal.append("turn_context", { scene: "practice_chat", conversation_folded: result.conversation.foldedMessages, conversation_recalled: result.conversation.recalledMessages }, thread?.id);
    journal.append("turn_text", turnTextPayload("practice_chat", content, result.reply), thread?.id);
    replayTypewriter(send, result.reply);
    send({ type: "done", reply: result.reply, provider: result.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", turnHandle, provider: provider.modelVersion, ...(thread?.id ? { threadId: thread.id } : {}), error, fallbackError: "LLM 对话失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});
}
