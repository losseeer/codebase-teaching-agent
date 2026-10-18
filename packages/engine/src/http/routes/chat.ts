import type { Exercise } from "@codebase-tutor/shared";
import { architectureToolFor, setDiagramToolFor } from "../../application/canvas-tools.js";
import { crossRepoFor, searchCorpusFor } from "../../application/paid-turn.js";
import { externalAndSkills, finishMapChatTurn, persistScopedTurn, recheckTurn, scopedThread, scopedThreadTurn, threadScopedHistory } from "../../application/scoped-turn.js";
import { auditsFromResult, recordAbortedAudits } from "../../application/turn-audit.js";
import { flattenCourseTree } from "../../coursetree/projection.js";
import { sanitizeChatFocus, sanitizeDiagramId, sanitizeScopePaths, sanitizeThreadId } from "../../http/input.js";
import { scopedChatProviderOr422 } from "../gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../../http/sse.js";
import { id } from "../../identity.js";
import { turnTextPayload } from "../../store/journal.js";
import { LlmAbortedError } from "../../llm/provider.js";
import { type MapChatProgress, mapChat, practiceChat } from "../../scopechat/scopechat.js";
import { repositoryOr404 } from "../../services.js";
import { Journal } from "../../store/journal.js";
import { markThread } from "../../trace/context.js";
import { traceEngine } from "../../trace/engine-log.js";
import { abortTurn } from "../../turns/registry.js";
import { validateStyle } from "../../tutor-settings/tutor-settings.js";
import type { FastifyInstance } from "fastify";

/**
  三作用域对话中的两个（宏观设计 / 练习答疑）：JSON 与 SSE 两条 map-chat、practice-chat、以及带外的「停止生成」。
  `scopedChatProviderOr422` 是这一组的开火闸门，四个消费方（含教学回合）共用同一句 422 文案。
 */
export function registerChatRoutes(app: FastifyInstance): void {
app.post<{ Params: { repositoryId: string }; Body: { content?: string; nodeId?: string; scopePaths?: string[]; path?: string; focus?: unknown; threadId?: unknown; style?: unknown; diagramId?: unknown } }>("/api/repositories/:repositoryId/map-chat", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const turn = scopedThreadTurn(repository, sanitizeThreadId(request.body?.threadId), "map");
  // 线程无效（跨仓库 / 跨作用域 / 已软删）在开火前拒绝：一个干净的 409 比「模型拿错上下文自信作答」便宜得多
  if (!turn) return reply.code(409).send({ error: "会话线程不存在、已删除或不属于本仓库的宏观设计作用域；请新建会话后再问。" });
  // 线程就地标注：llm.log 的每条 provider 调用都带上它，前缀缓存才能按「同一线程相邻两轮」算间隔
  markThread(turn.threadId);
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flattenCourseTree(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  // 覆盖层的读写要一条库连接；工具闭包与回合共用它，收尾统一 close（句柄泄漏的旧坑见 §37.4）
  const overlayDatabase = repository.handle.pin();
  try {
    const crossFiles = new Map<string, number>();
    const toolContext = architectureToolFor(repository, overlayDatabase, turn.threadId);
    // 这一回合真写过哪张图：回话带回去，界面上那张图卡片才有依据（拒写不算写过）
    let writtenDiagram: { id: string; name: string } | undefined;
    const diagramContext = setDiagramToolFor(repository, overlayDatabase, turn.threadId, sanitizeDiagramId(request.body?.diagramId), (diagram) => { writtenDiagram = diagram; });
    const result = await mapChat({ repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, focus: sanitizeChatFocus(request.body?.focus), content, history: turn.history, earlierQuestions: turn.earlierQuestions, provider, style: validateStyle(request.body?.style), search: searchCorpusFor(repository), cross: crossRepoFor(repository, crossFiles), threadId: turn.threadId, ...(toolContext ? { architecture: toolContext } : {}), diagram: diagramContext, ...(await externalAndSkills()) });
    finishMapChatTurn(repository, provider, turn.threadId, content, result, crossFiles);
    return { reply: result.reply, provider: result.provider, ...(writtenDiagram ? { diagram: writtenDiagram } : {}) };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "LLM 对话失败" });
  } finally {
    repository.handle.unpin();
  }
});

/** 「停止生成」的带外入口（三作用域共用）：GUI 点停止时先打这里，再断开自己的 SSE 连接。
    为什么单独一条而不是「连接断了就中止」：客户端消失分不出是用户要停还是网络波动/刷新页面——
    后者引擎必须把这一轮**算完并落库**，用户回来才有账可补（见 turns/registry.ts）。
    未命中 = 这一轮已经结束或本来就没登记，回 404，GUI 照常收尾、不当成错误。
    认证闸撤了之后**这台机器上谁都能停任何回合**（原来按 key 归属判的那道 403 一起没了，§64）。 */
app.post<{ Body: { turnId?: unknown } }>("/api/turns/stop", async (request, reply) => {
  const stopped = abortTurn(request.body?.turnId);
  if (!stopped.aborted) {
    return reply.code(404).send({ stopped: false });
  }
  traceEngine("turn_stop", { scene: stopped.scene, turn_id: stopped.turnId, waited_ms: stopped.waitedMs });
  return { stopped: true, scene: stopped.scene };
});

/** map-chat 流式版：SSE 推送过程事件（thinking / reading / searching），GUI 借此显示「回复生成中 / 正在读取 xx / 正在检索 xx」。 */
app.post<{ Params: { repositoryId: string }; Body: { content?: string; nodeId?: string; scopePaths?: string[]; path?: string; focus?: unknown; threadId?: unknown; style?: unknown; turnId?: unknown; diagramId?: unknown } }>("/api/repositories/:repositoryId/map-chat/stream", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const turn = scopedThreadTurn(repository, sanitizeThreadId(request.body?.threadId), "map");
  if (!turn) return reply.code(409).send({ error: "会话线程不存在、已删除或不属于本仓库的宏观设计作用域；请新建会话后再问。" });
  markThread(turn.threadId);
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flattenCourseTree(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  const { send, turnHandle } = beginScopedStream(request, reply, "map_chat", request.body?.turnId);
  const crossFiles = new Map<string, number>();
  const overlayDatabase = repository.handle.pin();
  try {
    const toolContext = architectureToolFor(repository, overlayDatabase, turn.threadId);
    let writtenDiagram: { id: string; name: string } | undefined;
    const diagramContext = setDiagramToolFor(repository, overlayDatabase, turn.threadId, sanitizeDiagramId(request.body?.diagramId), (diagram) => { writtenDiagram = diagram; });
    const result = await mapChat({
      repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, focus: sanitizeChatFocus(request.body?.focus), content, history: turn.history, earlierQuestions: turn.earlierQuestions, provider,
      style: validateStyle(request.body?.style),
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
      threadId: turn.threadId,
      onProgress: (progress: MapChatProgress) => send(progress),
      ...(toolContext ? { architecture: toolContext } : {}),
      diagram: diagramContext,
      ...(await externalAndSkills()),
      ...(turnHandle.signal ? { signal: turnHandle.signal } : {})
    });
    // 与教学回合同款收尾：中止若晚于最后一趟 LLM 到达，这一轮照样作废，不落库也不回放
    if (turnHandle.signal?.aborted) {
      recordAbortedAudits({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "map_chat", threadId: turn.threadId, audits: auditsFromResult(result) });
      throw new LlmAbortedError();
    }
    finishMapChatTurn(repository, provider, turn.threadId, content, result, crossFiles);
    replayTypewriter(send, result.reply);
    send({ type: "done", reply: result.reply, provider: result.provider, ...(writtenDiagram ? { diagram: writtenDiagram } : {}) });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "map_chat", turnHandle, threadId: turn.threadId, error, fallbackError: "LLM 对话失败" });
  } finally {
    turnHandle.dispose();
    // 与 JSON 那条同一个收尾：这条库句柄是给两个写工具闭包用的，不关就是每个回合漏一个 fd（better-sqlite3 还带 WAL）
    repository.handle.unpin();
  }
  reply.raw.end();
});

app.post<{ Params: { repositoryId: string }; Body: { content?: string; exerciseId?: string; threadId?: unknown; style?: unknown; turnId?: unknown } }>("/api/repositories/:repositoryId/practice-chat", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  if (!request.body?.exerciseId) return reply.code(400).send({ error: "缺少练习上下文；请先在练习页生成一道练习。" });
  const threadId = sanitizeThreadId(request.body?.threadId);
  const thread = threadId ? scopedThread(repository, threadId, "practice") : undefined;
  if (threadId && !thread) return reply.code(409).send({ error: "会话线程不存在、已删除或不属于本仓库的练习作用域；请新建会话后再问。" });
  // 线程绑题（exercise_id 由 GUI 建线程时给出）：换题走新建线程，这里兜住「拿着 A 题的会话问 B 题」——
  // 上一题的解答混进本轮上下文，模型会把两道题的条件揉在一起作答
  if (thread?.exerciseId && thread.exerciseId !== request.body.exerciseId) return reply.code(409).send({ error: "该会话属于另一道练习；请新建会话后再追问。" });
  markThread(thread?.id);
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  // 练习查询留在 hijack 前：404 还是干净的 JSON，只有确定要开火了才切 SSE
  const database = repository.handle.pin();
  let stored: { exercise: Exercise } | undefined;
  try {
    stored = database.getExerciseCacheById<{ exercise: Exercise }>(repository.index.repositoryId, request.body.exerciseId);
  } finally {
    repository.handle.unpin();
  }
  if (!stored) return reply.code(404).send({ error: "练习不存在或已被清理；请重新生成练习。" });
  const { history, earlierQuestions } = threadScopedHistory(repository.path, thread?.id);
  // 与 map-chat/stream 同款 SSE：delta 打字机回放 + done/error——GUI 三作用域的流式解析共用一条路径
  const { send, turnHandle } = beginScopedStream(request, reply, "practice_chat", request.body?.turnId);
  try {
    const result = await practiceChat({ repoPath: repository.path, exercise: stored.exercise, content, history, earlierQuestions, provider, style: validateStyle(request.body?.style), ...(thread?.id ? { threadId: thread.id } : {}), ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    // 与教学回合同款收尾：中止若晚于最后一趟 LLM 到达，这一轮照样作废，不落库也不回放
    if (turnHandle.signal?.aborted) {
      recordAbortedAudits({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", ...(thread?.id ? { threadId: thread.id } : {}), audits: auditsFromResult(result) });
      throw new LlmAbortedError();
    }
    const journal = new Journal(repository.path, repository.index.repositoryId);
    // 运行期复检（零 token）：练习答疑也运行时内——它同样会引用仓库里的代码位置
    result.reply = recheckTurn({ repository, journal, sessionId: thread?.id, scene: "practice_chat", question: content, answer: result.reply }).answer;
    persistScopedTurn(repository.path, "practice_chat", thread?.id, content, result.reply);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "practice_chat"
    }, thread?.id);
    journal.append("turn_text", turnTextPayload("practice_chat", content, result.reply), thread?.id);
    replayTypewriter(send, result.reply);
    send({ type: "done", reply: result.reply, provider: result.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", turnHandle, ...(thread?.id ? { threadId: thread.id } : {}), error, fallbackError: "LLM 对话失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});
}
