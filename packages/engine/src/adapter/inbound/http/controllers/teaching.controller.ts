import type { TutorSettings } from "@codebase-tutor/domain";

import { createTeachingSession, prepareTeachingTurn, readTeachingSession, runTeachingTurn } from "../../../../application/use-case/teaching.js";
import type { TeachingFailure } from "../../../../application/use-case/teaching.js";
import { budgetGate } from "../../../../application/orchestration/paid-turn.js";
import { scopedChatProviderOr422 } from "../budget-gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../stream.js";
import { markThread } from "@codebase-tutor/platform";
import type { FastifyInstance, FastifyReply } from "fastify";

/** 教学会话的建立与回合（SSE）：取形、预算闸门、流的开与关、失败 → 状态码。 */
export function registerTeachingRoutes(app: FastifyInstance): void {
app.post<{ Body: { repositoryId?: string; scopeRef?: string; settings?: Partial<TutorSettings> } }>("/api/sessions", async (request, reply) => {
  const created = createTeachingSession({
    repositoryId: request.body?.repositoryId,
    scopeRef: request.body?.scopeRef,
    settings: request.body?.settings,
  });
  if (!created.ok) return reject(reply, created.failure);
  return reply.code(201).send(created.value);
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  const read = readTeachingSession(request.params.sessionId);
  if (!read.ok) return reject(reply, read.failure);
  return read.value.session;
});

app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; turnId?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const prepared = prepareTeachingTurn(request.params.sessionId, {
    content: request.body?.content,
    settings: request.body?.settings,
  });
  if (!prepared.ok) return reject(reply, prepared.failure);
  const { repository, session } = prepared.value;
  // 教学侧的 sessionId 即 chat_session 的线程 id
  markThread(session.id);
  // 与 map/practice 共用一条预算与模型配置闸门
  const gate = budgetGate(repository.handle);
  const provider = scopedChatProviderOr422(reply, repository.handle, gate);
  if (!provider) return reply;
  const { send, turnHandle } = beginScopedStream(request, reply, "teach", request.body?.turnId);
  try {
    const outcome = await runTeachingTurn(prepared.value, provider, { send, ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) }, gate.monthlyBudgetUsd);
    replayTypewriter(send, outcome.message.content);
    send({ type: "done", session: outcome.session, message: outcome.message, policy: outcome.policy, cost: outcome.cost, provider: outcome.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "teach", turnHandle, provider: provider.modelVersion, threadId: session.id, error, fallbackError: "教学回合失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});

/** 失败种类 → 状态码与文案；分支必须穷尽。 */
function reject(reply: FastifyReply, failure: TeachingFailure): FastifyReply {
  switch (failure.kind) {
    case "repository-missing": return reply.code(404).send({ error: failure.message, reason: failure.reason });
    case "session-missing": return reply.code(404).send({ error: "会话不存在" });
    case "session-invalid": return reply.code(400).send({ error: "会话或消息无效" });
    case "scope-format": return reply.code(400).send({ error: "教学域格式不对：需要 file:<仓内路径> 或 dir:<仓内目录>" });
    case "scope-empty": return reply.code(404).send({ error: "这里暂时没有可问的代码；请换一个文件或目录。" });
    case "scope-gone": return reply.code(404).send({ error: "这个教学域已不可用；请重新选择一个文件或目录。" });
  }
}
}
