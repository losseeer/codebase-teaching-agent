import type { TutorSettings } from "@codebase-tutor/domain";

import { createTeachingSession, prepareTeachingTurn, readTeachingSession, runTeachingTurn } from "../../../../application/use-case/teaching.js";
import type { TeachingFailure } from "../../../../application/use-case/teaching.js";
import { budgetGate } from "../../../../application/orchestration/paid-turn.js";
import { scopedChatProviderOr422 } from "../budget-gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../stream.js";
import { markThread } from "@codebase-tutor/platform";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
  教学会话的建立与回合（SSE）：判断在 `application/use-case/teaching.ts`，这一层只剩取形、
  开火闸门、流的开与关，以及把失败种类翻成状态码与原来那句话。
*/
export function registerTeachingRoutes(app: FastifyInstance): void {
/** 建会话（会话即线程）：201 带首屏上下文、画像推荐与策略读数。 */
app.post<{ Body: { repositoryId?: string; scopeRef?: string; settings?: Partial<TutorSettings>; style?: unknown } }>("/api/sessions", async (request, reply) => {
  const created = createTeachingSession({
    repositoryId: request.body?.repositoryId,
    scopeRef: request.body?.scopeRef,
    settings: request.body?.settings,
    // 老客户端把风格档位平铺在 body 根上：只有真是数字才算「显式填了」
    style: typeof request.body?.style === "number" ? request.body.style : undefined
  });
  if (!created.ok) return reject(reply, created.failure);
  return reply.code(201).send(created.value);
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  const read = readTeachingSession(request.params.sessionId);
  if (!read.ok) return reject(reply, read.failure);
  return read.value.session;
});

app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; style?: unknown; turnId?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const prepared = prepareTeachingTurn(request.params.sessionId, {
    content: request.body?.content,
    settings: request.body?.settings,
    style: typeof request.body?.style === "number" ? request.body.style : undefined
  });
  if (!prepared.ok) return reject(reply, prepared.failure);
  const { repository, session } = prepared.value;
  // 教学侧的 sessionId 就是 chat_session 的线程 id，llm.log 直接沿用它做线程聚合
  markThread(session.id);
  // 与 map/practice 同一条闸门：没配模型、或本月预算已达到上限就在开火前 422，这一域没有本地兜底那一档
  const gate = budgetGate(repository.handle);
  const provider = scopedChatProviderOr422(reply, repository.handle, gate);
  if (!provider) return reply;
  // 与 map/practice 同款 SSE：过程提示与 delta 回放并入本请求的响应流
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

/** 失败种类 → 状态码与原来那句话，一字未改（逐种列全，少一种编译不过）。 */
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
