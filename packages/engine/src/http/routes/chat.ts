import { validateStyle } from "@codebase-tutor/domain";

import { type ChatFailure, loadPracticeExercise, prepareMapChat, preparePracticeChat, runMapChat, runPracticeChat, stopTurn } from "../../application/use-case/chat.js";
import { sanitizeAskId, sanitizeDiagramId, sanitizeScopePaths, sanitizeThreadId } from "../../http/input.js";
import { scopedChatProviderOr422 } from "../gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../../http/sse.js";
import { REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../services.js";
import { markThread } from "@codebase-tutor/platform";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
  三作用域对话中的两个（宏观设计 / 练习答疑）：map-chat 流式、practice-chat 流式、以及带外的「停止生成」。
  判断全在 `application/use-case/chat.ts`，这一层只剩四件事：请求体取形、开火闸门、SSE 这条流的开与关、
  以及把失败种类翻译成状态码与原来那句话。
  开火闸门与 hijack 的先后是有排法的：能回干净 JSON 的判断全在切流之前。
 */
export function registerChatRoutes(app: FastifyInstance): void {
/** 停止生成：这一轮不在途就回 404（`{stopped:false}`），GUI 照常收尾、不当成错误。 */
app.post<{ Body: { turnId?: unknown } }>("/api/turns/stop", async (request, reply) => {
  const stopped = stopTurn(request.body?.turnId);
  if (!stopped.ok) return reject(reply, stopped.failure);
  return { stopped: true, scene: stopped.value.scene };
});

/** map-chat 流式版：SSE 推送过程事件（thinking / reading / searching），GUI 借此显示「回复生成中 / 正在读取 xx / 正在检索 xx」。 */
app.post<{ Params: { repositoryId: string }; Body: { content?: string; scopePaths?: string[]; path?: string; threadId?: unknown; style?: unknown; turnId?: unknown; diagramId?: unknown; resumeAsk?: unknown } }>("/api/repositories/:repositoryId/map-chat/stream", async (request, reply) => {
  const threadId = sanitizeThreadId(request.body?.threadId);
  const prepared = prepareMapChat(request.params.repositoryId, { ...(request.body?.content === undefined ? {} : { content: request.body.content }), ...(threadId ? { threadId } : {}) });
  if (!prepared.ok) return reject(reply, prepared.failure);
  markThread(prepared.value.threadId);
  // 闸门的「挡不挡」与失败收尾的「落到哪条审计线」都要那一份挂载对象；用例自己另取，是内存里的一次查表
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reject(reply, "repository-missing");
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  const diagramId = sanitizeDiagramId(request.body?.diagramId);
  const resumeAsk = sanitizeAskId(request.body?.resumeAsk);
  const { send, turnHandle } = beginScopedStream(request, reply, "map_chat", request.body?.turnId);
  try {
    const outcome = await runMapChat(request.params.repositoryId, prepared.value, {
      ...(request.body?.scopePaths ? { scopePaths: sanitizeScopePaths(request.body.scopePaths) } : {}),
      ...(request.body?.path === undefined ? {} : { path: request.body.path }),
      style: validateStyle(request.body?.style),
      ...(diagramId ? { diagramId } : {}),
      ...(resumeAsk ? { resumeAsk } : {})
    }, provider, { send, ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    // 图卡片两条路都要给：中断前可能已经落了几笔改图，那些是真发生过的事
    const diagramFrame = outcome.diagram ? { diagram: outcome.diagram } : {};
    if (outcome.interrupted) {
      // 不出成品的一轮：不回放正文，只把原因交给界面那条 warn 条（带重试）
      send({ type: "done", interrupted: outcome.interrupted, provider: outcome.provider, ...diagramFrame });
    } else {
      replayTypewriter(send, outcome.reply);
      send({ type: "done", reply: outcome.reply, provider: outcome.provider, ...diagramFrame, ...(outcome.asked ? { asked: outcome.asked } : {}) });
    }
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "map_chat", turnHandle, provider: provider.modelVersion, threadId: prepared.value.threadId, error, fallbackError: "LLM 对话失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});

app.post<{ Params: { repositoryId: string }; Body: { content?: string; exerciseId?: string; threadId?: unknown; style?: unknown; turnId?: unknown } }>("/api/repositories/:repositoryId/practice-chat", async (request, reply) => {
  const threadId = sanitizeThreadId(request.body?.threadId);
  const checked = preparePracticeChat(request.params.repositoryId, { ...(request.body?.content === undefined ? {} : { content: request.body.content }), ...(threadId ? { threadId } : {}), ...(request.body?.exerciseId ? { exerciseId: request.body.exerciseId } : {}) });
  if (!checked.ok) return reject(reply, checked.failure);
  markThread(checked.value.threadId);
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reject(reply, "repository-missing");
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  // 练习查询留在 hijack 前：404 还是干净的 JSON，确定要开火了才切 SSE
  const turn = loadPracticeExercise(request.params.repositoryId, checked.value);
  if (!turn.ok) return reject(reply, turn.failure);
  const { send, turnHandle } = beginScopedStream(request, reply, "practice_chat", request.body?.turnId);
  try {
    const outcome = await runPracticeChat(request.params.repositoryId, turn.value, validateStyle(request.body?.style), provider, { send, ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    replayTypewriter(send, outcome.reply);
    send({ type: "done", reply: outcome.reply, provider: outcome.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", turnHandle, provider: provider.modelVersion, ...(turn.value.threadId ? { threadId: turn.value.threadId } : {}), error, fallbackError: "LLM 对话失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});

/**
  失败种类 → 状态码与原来那句话，一字未改。逐种列全（少一种编译不过）：
  「仓打不开」与「这条会话没了」「题不存在」都是 404，但三句文案是不同的事，不能并成一条。
*/
function reject(reply: FastifyReply, failure: ChatFailure): FastifyReply {
  switch (failure) {
    case "repository-missing": return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
    case "content-empty": return reply.code(400).send({ error: "消息内容不能为空" });
    case "thread-missing": return reply.code(409).send({ error: "这个会话已经不在了，请新建一个再问。" });
    case "exercise-context-missing": return reply.code(400).send({ error: "缺少练习上下文；请先在练习页生成一道练习。" });
    case "exercise-thread-mismatch": return reply.code(409).send({ error: "该会话属于另一道练习；请新建会话后再追问。" });
    case "exercise-missing": return reply.code(404).send({ error: "练习不存在或已被清理；请重新生成练习。" });
    case "turn-not-in-flight": return reply.code(404).send({ stopped: false });
  }
}
}
