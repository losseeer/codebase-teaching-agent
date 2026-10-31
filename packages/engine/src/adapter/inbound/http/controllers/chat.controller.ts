
import { type ChatFailure, loadPracticeExercise, prepareMapChat, preparePracticeChat, runMapChat, runPracticeChat, stopTurn } from "../../../../application/use-case/chat.js";
import { sanitizeAskId, sanitizeDiagramId, sanitizeScopePaths, sanitizeThreadId } from "../dto.js";
import { scopedChatProviderOr422 } from "../budget-gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../stream.js";
import { REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../../../infrastructure/composition-root.js";
import { markThread } from "@codebase-tutor/platform";
import type { FastifyInstance, FastifyReply } from "fastify";

/** 宏观设计与练习答疑两条流式对话路由，外加「停止生成」。 */
export function registerChatRoutes(app: FastifyInstance): void {
app.post<{ Body: { turnId?: unknown } }>("/api/turns/stop", async (request, reply) => {
  const stopped = stopTurn(request.body?.turnId);
  if (!stopped.ok) return reject(reply, stopped.failure);
  return { stopped: true, scene: stopped.value.scene };
});

app.post<{ Params: { repositoryId: string }; Body: { content?: string; scopePaths?: string[]; path?: string; threadId?: unknown; turnId?: unknown; diagramId?: unknown; resumeAsk?: unknown } }>("/api/repositories/:repositoryId/map-chat/stream", async (request, reply) => {
  const threadId = sanitizeThreadId(request.body?.threadId);
  const prepared = prepareMapChat(request.params.repositoryId, { ...(request.body?.content === undefined ? {} : { content: request.body.content }), ...(threadId ? { threadId } : {}) });
  if (!prepared.ok) return reject(reply, prepared.failure);
  markThread(prepared.value.threadId);
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
      ...(diagramId ? { diagramId } : {}),
      ...(resumeAsk ? { resumeAsk } : {})
    }, provider, { send, ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    // 中断前可能已经写入改图结果
    const diagramFrame = outcome.diagram ? { diagram: outcome.diagram } : {};
    if (outcome.interrupted) {
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

app.post<{ Params: { repositoryId: string }; Body: { content?: string; exerciseId?: string; threadId?: unknown; turnId?: unknown } }>("/api/repositories/:repositoryId/practice-chat", async (request, reply) => {
  const threadId = sanitizeThreadId(request.body?.threadId);
  const checked = preparePracticeChat(request.params.repositoryId, { ...(request.body?.content === undefined ? {} : { content: request.body.content }), ...(threadId ? { threadId } : {}), ...(request.body?.exerciseId ? { exerciseId: request.body.exerciseId } : {}) });
  if (!checked.ok) return reject(reply, checked.failure);
  markThread(checked.value.threadId);
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reject(reply, "repository-missing");
  const provider = scopedChatProviderOr422(reply, repository.handle);
  if (!provider) return reply;
  const turn = loadPracticeExercise(request.params.repositoryId, checked.value);
  if (!turn.ok) return reject(reply, turn.failure);
  const { send, turnHandle } = beginScopedStream(request, reply, "practice_chat", request.body?.turnId);
  try {
    const outcome = await runPracticeChat(request.params.repositoryId, turn.value, provider, { send, ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    replayTypewriter(send, outcome.reply);
    send({ type: "done", reply: outcome.reply, provider: outcome.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", turnHandle, provider: provider.modelVersion, ...(turn.value.threadId ? { threadId: turn.value.threadId } : {}), error, fallbackError: "LLM 对话失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});

/** 失败种类 → 状态码与文案；分支必须穷尽。 */
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
