import { REPOSITORY_NOT_MOUNTED } from "../../../../infrastructure/composition-root.js";
import { createThreadUseCase, deleteThreadUseCase, listScopeThreads, readThreadMessages, renameThreadUseCase, type ThreadsFailure } from "../../../../application/use-case/threads.js";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
  会话线程的入站翻译（作用域 `teach | map | practice`）：入参交给用例，结果翻成状态码与响应体。
  业务判断住在 `application/use-case/threads.ts`。
  */
const REJECTED: Record<ThreadsFailure, { status: 400 | 404; error: string }> = {
  "repository-missing": { status: 404, error: REPOSITORY_NOT_MOUNTED },
  "scope-invalid": { status: 400, error: "scope 只能是 teach / map / practice" },
  "thread-missing": { status: 404, error: "会话不存在或已删除。" },
  "title-empty": { status: 400, error: "标题不能为空" }
};

const rejected = (reply: FastifyReply, failure: ThreadsFailure): FastifyReply => reply.code(REJECTED[failure].status).send({ error: REJECTED[failure].error });

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function registerThreadRoutes(app: FastifyInstance): void {
  app.get<{ Params: { repositoryId: string }; Querystring: { scope?: string; current?: string } }>("/api/repositories/:repositoryId/threads", async (request, reply) => {
    const result = listScopeThreads(request.params.repositoryId, request.query.scope, request.query.current);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.post<{ Params: { repositoryId: string }; Body: { scope?: unknown; scopeRef?: unknown; exerciseId?: unknown; title?: unknown } }>("/api/repositories/:repositoryId/threads", async (request, reply) => {
    const body = request.body ?? {};
    const result = createThreadUseCase(request.params.repositoryId, { scope: text(body.scope), scopeRef: text(body.scopeRef), exerciseId: text(body.exerciseId), title: text(body.title) });
    return result.ok ? reply.code(201).send({ thread: result.value.thread }) : rejected(reply, result.failure);
  });

  app.get<{ Params: { threadId: string } }>("/api/threads/:threadId/messages", async (request, reply) => {
    const result = readThreadMessages(request.params.threadId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.patch<{ Params: { threadId: string }; Body: { title?: unknown } }>("/api/threads/:threadId", async (request, reply) => {
    const result = renameThreadUseCase(request.params.threadId, text(request.body?.title));
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
    const result = deleteThreadUseCase(request.params.threadId);
    return result.ok ? { deleted: true, threadId: result.value.threadId } : rejected(reply, result.failure);
  });
}
