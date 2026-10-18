import { locateThread, threadJournalPayload } from "../../application/threads.js";
import { repositoryOr404 } from "../../services.js";
import { createThread, isChatScope, listThreads, readMessages, renameThread, softDeleteThread } from "../../store/chat-store.js";
import { Journal } from "../../store/journal.js";
import type { FastifyInstance } from "fastify";

/**
  会话线程的增删改查（三作用域共用）。线程 id 由引擎发，正文落 chat_message，删除是软删。
 */
export function registerThreadRoutes(app: FastifyInstance): void {
/**
  会话线程管理（三作用域共用，作用域是 `teach | map | practice`）。

  线程 id 由**引擎**发（`createThread` 里的 UUID），GUI 只持有与回传——这是「上下文≠选中项」那一轮的同一条纪律：
  凡是要进模型上下文的东西都得能在库里考据到，客户端临时拼的窗口正文不算。
  `map` / `practice` 的对话正文靠这些线程累积，服务端在流式回合里自己取历史、自己落正文。
  */
app.get<{ Params: { repositoryId: string }; Querystring: { scope?: string } }>("/api/repositories/:repositoryId/threads", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (!isChatScope(request.query.scope)) return reply.code(400).send({ error: "scope 只能是 teach / map / practice" });
  return { threads: listThreads(repository.path, repository.index.repositoryId, request.query.scope) };
});

app.post<{ Params: { repositoryId: string }; Body: { scope?: unknown; nodeId?: unknown; exerciseId?: unknown; title?: unknown } }>("/api/repositories/:repositoryId/threads", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (!isChatScope(request.body?.scope)) return reply.code(400).send({ error: "scope 只能是 teach / map / practice" });
  const scope = request.body.scope;
  // 归属对象（节点 / 练习题）由调用方给出，服务端只截长不校验存在性：节点树会重烧、练习会重生成，
  // 拿「此刻查得到」当写入闸门会把会话管理变成又一次上下文同步事故
  const courseNodeId = typeof request.body?.nodeId === "string" && request.body.nodeId.trim() ? request.body.nodeId.trim().slice(0, 200) : undefined;
  const exerciseId = typeof request.body?.exerciseId === "string" && request.body.exerciseId.trim() ? request.body.exerciseId.trim().slice(0, 200) : undefined;
  const title = typeof request.body?.title === "string" ? request.body.title : undefined;
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scope, ...(courseNodeId ? { courseNodeId } : {}), ...(exerciseId ? { exerciseId } : {}), ...(title ? { title } : {}) });
  new Journal(repository.path, repository.index.repositoryId).append("session_created", threadJournalPayload(thread, "created"), thread.id);
  return reply.code(201).send({ thread });
});

/** 线程正文（产品线）：GUI 刷新或引擎重启后按 threadId 取回对话展示。软删线程一律 404（读侧恒带 `deleted_at IS NULL`）。 */
app.get<{ Params: { threadId: string } }>("/api/threads/:threadId/messages", async (request, reply) => {
  const located = locateThread(request.params.threadId);
  if (!located) return reply.code(404).send({ error: "会话不存在或已删除。" });
  return { thread: located.thread, messages: readMessages(located.repositoryPath, located.thread.id) };
});

app.patch<{ Params: { threadId: string }; Body: { title?: unknown } }>("/api/threads/:threadId", async (request, reply) => {
  const located = locateThread(request.params.threadId);
  if (!located) return reply.code(404).send({ error: "会话不存在或已删除。" });
  const title = typeof request.body?.title === "string" ? request.body.title : "";
  if (!title.trim()) return reply.code(400).send({ error: "标题不能为空" });
  const thread = renameThread(located.repositoryPath, located.thread.id, title);
  return thread ? { thread } : reply.code(404).send({ error: "会话不存在或已删除。" });
});

/**
  软删：chat_session 打时间戳，chat_message 原文一行不动，journal 追加一条 session_deleted（不删任何既有事件行）。
  同时从内存 Map 移除教学会话——否则删掉的会话还能被同进程继续聊，重启后又消失，行为会分成两段。
  */
app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
  const located = locateThread(request.params.threadId);
  if (!located || !softDeleteThread(located.repositoryPath, located.thread.id)) return reply.code(404).send({ error: "会话不存在或已删除。" });
  new Journal(located.repositoryPath, located.repositoryId).append("session_deleted", threadJournalPayload(located.thread, "user_deleted"), located.thread.id);
  return { deleted: true, threadId: located.thread.id };
});
}
