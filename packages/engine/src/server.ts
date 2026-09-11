import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { ClaudePostToolUseEvent, CompanionAction, CourseNode, ExerciseAnswer, ExerciseKind, ServerEvent, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { CompanionService } from "./companion/service.js";
import { summarizeCost, defaultMonthlyBudgetUsd } from "./cost/service.js";
import { courseChildren, courseOverview, findCourseNode } from "./coursetree/projection.js";
import { impactRadius, graphFromData } from "./depgraph/graph.js";
import { createExperiment, exportExperimentCsv, getExperiment } from "./experiment/service.js";
import { ExerciseService } from "./exercises/service.js";
import { respondWithProvider, createSession } from "./harness/harness.js";
import { assembleContext } from "./harness/context.js";
import { filterTeachMoment, type HookEvent } from "./hooks/filter.js";
import { ImportService } from "./importer/service.js";
import { isWithin } from "./lib.js";
import { defaultTutorSettings, policyFor, validateSettings } from "./policy/policy.js";
import { TutorDatabase } from "./store/database.js";
import { Journal, readJournal } from "./store/journal.js";
import { deriveLearnerProfile } from "./learner/model.js";
import { createTeachingProvider, teachingProviderStatus } from "./llm/provider.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });
const importer = new ImportService();
const exercises = new ExerciseService();
const companion = new CompanionService();
const teachingProvider = createTeachingProvider();
const sessions = new Map<string, TutorSession>();
const clients = new Set<{ send(data: string): void; readyState: number }>();

await app.register(cors, { origin: true });
await app.register(websocket);

function broadcast(event: ServerEvent): void {
  const serialized = JSON.stringify(event);
  for (const client of clients) if (client.readyState === 1) client.send(serialized);
}

function repositoryOr404(repositoryId: string) {
  return importer.getRepository(repositoryId);
}

function repositorySettings(repositoryPath: string, repositoryId: string): { monthlyBudgetUsd: number } {
  const database = new TutorDatabase(repositoryPath);
  const settings = database.getSettings<{ monthlyBudgetUsd?: number }>(repositoryId);
  database.close();
  return { monthlyBudgetUsd: typeof settings?.monthlyBudgetUsd === "number" && settings.monthlyBudgetUsd >= 0 ? settings.monthlyBudgetUsd : defaultMonthlyBudgetUsd };
}

importer.on("event", broadcast);

app.get("/api/health", async () => {
  const teaching = teachingProviderStatus(teachingProvider);
  return { status: "ok", service: "codebase-tutor-engine", version: "0.2.0", summaryProvider: process.env.TUTOR_SUMMARY_PROVIDER ?? "local", teachingProvider: teaching.provider, teachingModel: teaching.model, teachingMode: teaching.mode };
});

app.get("/ws", { websocket: true }, (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
});

app.post<{ Body: { path?: string } }>("/api/imports", async (request, reply) => {
  try { return reply.code(202).send(importer.submit(request.body?.path ?? "")); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "无法提交导入任务" }); }
});

app.get<{ Params: { jobId: string } }>("/api/imports/:jobId", async (request, reply) => {
  const job = importer.getJob(request.params.jobId);
  return job ?? reply.code(404).send({ error: "导入任务不存在" });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/index", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository?.index ?? reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/course", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository?.course ?? reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/overview", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository ? courseOverview(repository.course, repository.index) : reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.get<{ Params: { repositoryId: string }; Querystring: { parentId?: string; offset?: string; limit?: string } }>("/api/repositories/:repositoryId/course/nodes", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const parentId = request.query.parentId;
  if (!repository || !parentId) return reply.code(400).send({ error: "请提供课程父节点" });
  const page = courseChildren(repository.course, parentId, Number(request.query.offset ?? 0), Number(request.query.limit ?? 30));
  return page ?? reply.code(404).send({ error: "课程节点不存在" });
});

app.get<{ Params: { repositoryId: string }; Querystring: { nodeId?: string } }>("/api/repositories/:repositoryId/analysis/node", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const nodeId = request.query.nodeId;
  if (!repository || !nodeId) return reply.code(400).send({ error: "请提供课程节点" });
  if (!findCourseNode(repository.course.root, nodeId)) return reply.code(404).send({ error: "课程节点不存在" });
  return {
    nodeId,
    implementation: repository.analysis.implementations.find((unit) => unit.id === nodeId),
    decision: repository.analysis.decisions.find((unit) => unit.id === nodeId)
  };
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/analysis", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository?.analysis ?? reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.post<{ Params: { repositoryId: string }; Body: { changedPaths?: string[] } }>("/api/repositories/:repositoryId/impact", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const changedPaths = request.body?.changedPaths?.filter((path): path is string => typeof path === "string") ?? [];
  if (!repository || !changedPaths.length) return reply.code(400).send({ error: "请提供至少一个变更路径" });
  return impactRadius(graphFromData(repository.analysis.graph), changedPaths);
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/practice", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository ? exercises.getSummary(repository) : reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/learner", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository
    ? deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path))
    : reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.post<{ Params: { repositoryId: string }; Body: { kind?: ExerciseKind; targetUnitId?: string } }>("/api/repositories/:repositoryId/exercises", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const kind = request.body?.kind;
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (kind && !["output_prediction", "change_localization", "impact_analysis", "decision_defense"].includes(kind)) return reply.code(400).send({ error: "不支持的练习题型" });
  try {
    return reply.code(201).send(exercises.next(repository, { kind, targetUnitId: request.body?.targetUnitId }));
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法生成练习" });
  }
});

app.post<{ Params: { repositoryId: string; exerciseId: string }; Body: ExerciseAnswer }>("/api/repositories/:repositoryId/exercises/:exerciseId/answer", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  try {
    return await exercises.answer(repository, request.params.exerciseId, request.body ?? {});
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法判分" });
  }
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/report", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  return {
    index: repository.index,
    estimate: repository.estimate,
    entrypoints: flatten(repository.course.root).filter((node) => node.kind === "workflow").map((node) => ({ title: node.title, anchors: node.anchors })),
    analysis: { decisions: repository.analysis.decisions.length, implementations: repository.analysis.implementations.length, semanticBackend: repository.analysis.graph.semanticBackend, lspStatus: repository.analysis.graph.lspStatus }
  };
});

app.get<{ Params: { repositoryId: string }; Querystring: { path?: string; line?: string } }>("/api/repositories/:repositoryId/source", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const requestedPath = request.query.path;
  if (!repository || !requestedPath) return reply.code(404).send({ error: "未找到源码" });
  const absolute = join(repository.path, requestedPath);
  if (!isWithin(repository.path, absolute)) return reply.code(400).send({ error: "源码路径越出仓库边界" });
  try { return { path: requestedPath, line: Math.max(1, Number(request.query.line ?? 1)), content: readFileSync(absolute, "utf8") }; }
  catch { return reply.code(404).send({ error: "无法读取该源码文件" }); }
});

app.get<{ Params: { repositoryId: string }; Querystring: { sessionId?: string } }>("/api/repositories/:repositoryId/cost", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  return summarizeCost(repository.path, repositorySettings(repository.path, repository.index.repositoryId).monthlyBudgetUsd, request.query.sessionId);
});

app.put<{ Params: { repositoryId: string }; Body: { monthlyBudgetUsd?: number } }>("/api/repositories/:repositoryId/settings", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const budget = request.body?.monthlyBudgetUsd;
  if (!repository || typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) return reply.code(400).send({ error: "预算必须是非负数字" });
  const database = new TutorDatabase(repository.path);
  database.saveSettings(repository.index.repositoryId, { monthlyBudgetUsd: budget });
  database.close();
  return summarizeCost(repository.path, budget);
});

app.post<{ Params: { repositoryId: string }; Body: HookEvent }>("/api/repositories/:repositoryId/hooks/filter", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不存在" });
  const result = filterTeachMoment(request.body ?? {});
  new Journal(repository.path, repository.index.repositoryId).append("teach_moment", { accepted: result.accepted, reason: result.reason, latency_ms: result.latencyMs });
  return result;
});

app.get<{ Params: { repositoryId: string }; Querystring: { includeLater?: string } }>("/api/repositories/:repositoryId/companion/suggestions", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不存在" });
  return { suggestions: companion.list(repository, request.query.includeLater === "true"), summary: companion.summary(repository) };
});

app.post<{ Params: { repositoryId: string }; Body: ClaudePostToolUseEvent }>("/api/repositories/:repositoryId/companion/hooks/post-tool-use", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不存在" });
  const result = await companion.receivePostToolUse(repository, request.body ?? {});
  if (result.suggestion) broadcast({ type: "companion.suggestion", payload: { repositoryId: repository.index.repositoryId, suggestion: result.suggestion } });
  return reply.code(202).send(result);
});

app.post<{ Body: ClaudePostToolUseEvent }>("/api/companion/hooks/post-tool-use", async (request, reply) => {
  const cwd = request.body?.cwd;
  const repository = typeof cwd === "string" ? importer.findRepositoryForPath(cwd) : undefined;
  if (!repository) return reply.code(404).send({ error: "未找到与 hook cwd 对应的已导入仓库" });
  const result = await companion.receivePostToolUse(repository, request.body ?? {});
  if (result.suggestion) broadcast({ type: "companion.suggestion", payload: { repositoryId: repository.index.repositoryId, suggestion: result.suggestion } });
  return reply.code(202).send(result);
});

app.post<{ Params: { repositoryId: string; suggestionId: string }; Body: { action?: CompanionAction } }>("/api/repositories/:repositoryId/companion/suggestions/:suggestionId/actions", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const action = request.body?.action;
  if (!repository) return reply.code(404).send({ error: "仓库不存在" });
  if (action !== "accepted" && action !== "dismissed" && action !== "later") return reply.code(400).send({ error: "不支持的建议动作" });
  try { return companion.act(repository, request.params.suggestionId, action); }
  catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : "无法处理建议" }); }
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/experiment", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不存在" });
  return getExperiment(repository.path) ?? reply.code(404).send({ error: "尚未创建实验配置" });
});

app.post<{ Params: { repositoryId: string }; Body: { name?: string; participantId?: string } }>("/api/repositories/:repositoryId/experiment", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不存在" });
  return reply.code(201).send(createExperiment(repository.path, repository.index.repositoryId, request.body?.name ?? "M1 三组对照", request.body?.participantId));
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/experiment/export.csv", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不存在" });
  return reply.header("content-type", "text/csv; charset=utf-8").send(exportExperimentCsv(repository.path));
});

app.post<{ Body: { repositoryId?: string; courseNodeId?: string; settings?: Partial<TutorSettings>; style?: unknown } }>("/api/sessions", async (request, reply) => {
  const repository = repositoryOr404(request.body?.repositoryId ?? "");
  const node = repository && flatten(repository.course.root).find((item) => item.id === request.body?.courseNodeId);
  if (!repository || !node) return reply.code(404).send({ error: "课程节点不存在" });
  const experiment = getExperiment(repository.path);
  if (experiment?.assignedGroup === "C_no_assistant") return reply.code(403).send({ error: "当前实验组不提供教学辅助。" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : undefined);
  const hasExplicitSettings = Boolean(request.body?.settings && Object.keys(request.body.settings).length) || typeof request.body?.style === "number";
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  let settings = hasExplicitSettings
    ? validateSettings({ ...defaultTutorSettings, ...request.body?.settings, style: requestedStyle })
    : learnerProfile.recommended.settings;
  if (experiment?.assignedGroup === "B_direct_answer") settings = { ...settings, pedagogy: "explanatory" };
  const session = createSession(repository.index.repositoryId, node.id, settings);
  sessions.set(session.id, session);
  new Journal(repository.path, repository.index.repositoryId).append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "session_created" }, session.id);
  return reply.code(201).send({ session, recommendedSettings: learnerProfile.recommended, faded: learnerProfile.fadedByUnit[node.id] ?? learnerProfile.faded, policy: policyFor(session.settings), context: assembleContext(node, policyFor(session.settings), []) });
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  const session = sessions.get(request.params.sessionId);
  return session ?? reply.code(404).send({ error: "会话不存在" });
});

app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; style?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const current = sessions.get(request.params.sessionId);
  if (!current || !request.body?.content?.trim()) return reply.code(400).send({ error: "会话或消息无效" });
  const repository = repositoryOr404(current.repositoryId);
  const node = repository && flatten(repository.course.root).find((item) => item.id === current.courseNodeId);
  if (!repository || !node) return reply.code(404).send({ error: "课程节点不可用" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : current.settings.style);
  const settings = validateSettings({ ...current.settings, ...request.body?.settings, style: requestedStyle });
  const styleChanged = JSON.stringify(settings) !== JSON.stringify(current.settings);
  const session = { ...current, style: settings.style, settings };
  const monthlyBudget = repositorySettings(repository.path, repository.index.repositoryId).monthlyBudgetUsd;
  const currentCost = summarizeCost(repository.path, monthlyBudget);
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  const faded = learnerProfile.fadedByUnit[node.id] ?? learnerProfile.faded;
  const outcome = await respondWithProvider(session, node, request.body.content.trim(), currentCost.mode === "degraded" ? undefined : teachingProvider, faded);
  sessions.set(outcome.session.id, outcome.session);
  const journal = new Journal(repository.path, repository.index.repositoryId);
  if (styleChanged) journal.append("style_shift", { style: settings.style, pedagogy: settings.pedagogy, depth: settings.depth, trigger: "manual" }, session.id);
  journal.append("hint_depth", { unit_id: node.id, depth: outcome.hintDepth, stage: outcome.session.stage, resolved_by: outcome.event === "dependency" ? "answer_circuit_breaker" : "learner_attempt" }, session.id);
  if (outcome.event === "dependency") journal.append("dependency_event", { unit_id: node.id, after_attempts: 2, reason: "two_consecutive_step_downs" }, session.id);
  if (outcome.event === "confirmation") journal.append("unit_mastered", { unit_id: node.id, method: "source_backed_explanation" }, session.id);
  const tokenEvent = journal.append("token_usage", { input_tokens: outcome.usage?.inputTokens ?? Math.ceil(request.body.content.length / 4), output_tokens: outcome.usage?.outputTokens ?? Math.ceil(outcome.assistant.content.length / 4), provider: outcome.provider ?? "local-heuristic-v1" }, session.id);
  const cost = summarizeCost(repository.path, monthlyBudget, session.id);
  if (cost.mode === "degraded") journal.append("token_usage", { input_tokens: 0, output_tokens: 0, provider: outcome.provider ?? "local-heuristic-v1", mode: "degraded", cause: "monthly_budget_reached" }, session.id);
  for (const delta of chunk(outcome.assistant.content, 72)) broadcast({ type: "session.delta", payload: { sessionId: session.id, messageId: outcome.assistant.id, delta } });
  broadcast({ type: "session.complete", payload: { sessionId: session.id, message: outcome.assistant, stage: outcome.session.stage, cost, tokenEventId: tokenEvent.id } });
  return { session: outcome.session, message: outcome.assistant, policy: policyFor(settings), cost };
});

function flatten(root: CourseNode): CourseNode[] { return [root, ...root.children.flatMap(flatten)]; }
function chunk(content: string, width: number): string[] { return content.match(new RegExp(`.{1,${width}}`, "g")) ?? [content]; }

const port = Number(process.env.ENGINE_PORT ?? 3001);
await app.listen({ port, host: "127.0.0.1" });
