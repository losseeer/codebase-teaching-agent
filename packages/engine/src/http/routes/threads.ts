import { locateThread, threadJournalPayload } from "../../application/threads.js";
import { repositoryOr404 } from "../../services.js";
import { createThread, getThread, isChatScope, listThreads, readMessages, renameThread, softDeleteThread } from "../../store/chat-store.js";
import { Journal } from "../../store/journal.js";
import type { FastifyInstance } from "fastify";

/**
  会话线程的增删改查（三作用域共用，作用域是 `teach | map | practice`）。
  线程 id 由引擎发（`createThread` 里的 UUID），GUI 只持有与回传：
  凡是要进模型上下文的东西都得能在库里考据到，客户端临时拼的窗口正文不算。
  `map` / `practice` 的对话正文靠这些线程累积，服务端在流式回合里自己取历史、自己落正文；删除是软删。
  */
export function registerThreadRoutes(app: FastifyInstance): void {
app.get<{ Params: { repositoryId: string }; Querystring: { scope?: string; current?: string } }>("/api/repositories/:repositoryId/threads", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (!isChatScope(request.query.scope)) return reply.code(400).send({ error: "scope 只能是 teach / map / practice" });
  const threads = listThreads(repository.path, repository.index.repositoryId, request.query.scope);
  /*
    `current` 是界面正打开着的那条：清单只收谈过的会话，所以「还没发言的新会话」不在里面。
    这一格让界面能区分两种情况——「这条空会话还在」与「这条已被删掉/本来不属于这儿」，
    没有它，新建之后的任何一次刷新都会把刚建的那条当残留剪掉。
  */
  const asked = typeof request.query.current === "string" ? request.query.current : "";
  const found = asked ? getThread(repository.path, asked) : undefined;
  const current = found && found.repositoryId === repository.index.repositoryId && found.scope === request.query.scope ? found : null;
  return { threads, current };
});

app.post<{ Params: { repositoryId: string }; Body: { scope?: unknown; scopeRef?: unknown; exerciseId?: unknown; title?: unknown } }>("/api/repositories/:repositoryId/threads", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (!isChatScope(request.body?.scope)) return reply.code(400).send({ error: "scope 只能是 teach / map / practice" });
  const scope = request.body.scope;
  // 归属对象（文件/目录作用域、练习题）由调用方给出，服务端只截长不校验存在性：产物会重新分析
  const scopeRef = typeof request.body?.scopeRef === "string" && request.body.scopeRef.trim() ? request.body.scopeRef.trim().slice(0, 400) : undefined;
  const exerciseId = typeof request.body?.exerciseId === "string" && request.body.exerciseId.trim() ? request.body.exerciseId.trim().slice(0, 200) : undefined;
  const title = typeof request.body?.title === "string" ? request.body.title : undefined;
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scope, ...(scopeRef ? { scopeRef } : {}), ...(exerciseId ? { exerciseId } : {}), ...(title ? { title } : {}) });
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
  软删：chat_session 打 deleted_at，chat_message 原文一行不动，journal 追加一条 session_deleted（不删任何既有事件行）。
  教学会话没有常驻内存态：按 sessionId 每次从这两张表现装配，所以这里没有要清的在途东西。
  读侧恒带 `deleted_at IS NULL`（`getThread`），同进程内被删的线程也立刻取不到。
  */
app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
  const located = locateThread(request.params.threadId);
  if (!located || !softDeleteThread(located.repositoryPath, located.thread.id)) return reply.code(404).send({ error: "会话不存在或已删除。" });
  new Journal(located.repositoryPath, located.repositoryId).append("session_deleted", threadJournalPayload(located.thread, "user_deleted"), located.thread.id);
  return { deleted: true, threadId: located.thread.id };
});
}
