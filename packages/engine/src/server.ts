import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as _perf } from "node:perf_hooks";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { EXERCISE_KINDS } from "@codebase-tutor/shared";
import type { CourseNode, Exercise, ExerciseAnswer, ExerciseKind, JournalEvent, ServerEvent, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import type { FastifyReply } from "fastify";
import { summarizeCost, defaultMonthlyBudgetUsd } from "./cost/service.js";
import { courseChildren, courseOverview, findCourseNode } from "./coursetree/projection.js";
import { suggestModuleEntriesCached } from "./coursetree/entry-suggest.js";
import { impactRadius, graphFromData } from "./depgraph/graph.js";
import { fileStructureOf } from "./depgraph/roles.js";
import { ExerciseService } from "./exercises/service.js";
import { degradedFlow, generateRepositoryFlowCached, resolveFlowEntry } from "./flows/flow.js";
import { respondWithProvider, createSession } from "./harness/harness.js";
import { findLatestSessionForNode, restoreSessionFromJournal } from "./harness/restore.js";
import { assembleContext } from "./harness/context.js";
import { ImportService } from "./importer/service.js";
import { indexRepository } from "./indexer/indexer.js";
import { id, isWithin, turnTextPayload } from "./lib.js";
import { loadDotEnv } from "./config/dotenv.js";
import { defaultTutorSettings, policyFor, validateSettings, validateStyle } from "./policy/policy.js";
import { createSummaryProvider, LocalSummaryProvider } from "./summarizer/provider.js";
import { summarizeFiles } from "./summarizer/summarizer.js";
import { TutorDatabase } from "./store/database.js";
import { Journal, isJournalEventType, readJournal } from "./store/journal.js";
import { runWithTrace } from "./trace/context.js";
import { traceEngine } from "./trace/engine-log.js";
import { dedupeFileReads } from "./source/read-file.js";
import { buildSearchCorpus, type SearchCorpus } from "./source/search-code.js";
import { deriveLearnerProfile } from "./learner/model.js";
import { resolveModelSlug, teachingProviderStatus, type LlmProvider } from "./llm/provider.js";
import { isThinkingEffortSupported, resolveThinkingCapability, supportedThinkingEfforts } from "./llm/thinking.js";
import { buildLlmRuntimeProvider, getLlmRuntimeSettings, setLlmRuntimeSettings } from "./llm/runtime.js";
import { mapChat, practiceChat, type MapChatProgress, type ScopedChatTurn } from "./scopechat/service.js";

// .env 必须在任何 provider 创建之前加载（teachingProvider/lightLlmProvider 在下方立即读环境变量）
loadDotEnv();

/** engine version: 单源 = packages/engine/package.json. 读不到时回落到 0.0.0. */
const engineVersion: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

/** 启动耗时分段计时：始终落引擎日志（kind: boot），控制台回显由 TUTOR_BOOT_TIMING=1 控制。 */
const T0 = _perf.now();
const tboot = (label: string): void => {
  const durationMs = Math.round(_perf.now() - T0);
  if (process.env.TUTOR_BOOT_TIMING === "1") console.log(`[boot] +${String(durationMs).padStart(5)}ms ${label}`);
  traceEngine("boot", { phase: label }, { traceId: null, durationMs });
};

tboot("imports resolved");

const app = Fastify({
  // traceId 即 reqId：pino 的请求行、本进程记的 trace 事件、llm.log 与 journal 共享同一个 id
  genReqId: () => id(),
  logger: { level: process.env.LOG_LEVEL ?? "warn" }
});
// 请求级 trace 上下文：`run(id, done)` 让后续钩子与 handler 继承该 store（传播原理见 trace/context.ts）
app.addHook("onRequest", (request, _reply, done) => { runWithTrace(request.id, done); });
app.addHook("onResponse", (request, reply, done) => {
  traceEngine("http", { method: request.method, url: request.url, status: reply.statusCode }, { traceId: request.id, durationMs: Math.round(reply.elapsedTime) });
  done();
});
tboot("Fastify constructed");

const importer = new ImportService();
// 启动恢复（单槽）：把注册表里那一个仓库的 .tutor 分析结果重新挂进内存并监听（GUI 旧 workspace 不再 404，无需重新导入重烧润色）
const restoredRepositories = importer.restorePersisted();
if (restoredRepositories) console.log("[startup] 已从 .tutor 恢复上次挂载的仓库，无需重新导入");
tboot("ImportService");

const exercises = new ExerciseService();
tboot("ExerciseService");

// LLM 走运行时构建器：模型覆盖与思考档位来自内存态设置（GUI PUT /api/llm/settings 可改，重启回落 .env）。
// 只有一套配置；teaching / light 是**运行时角色**（差别只在思考开关），不是两份配置。
let teachingProvider = buildLlmRuntimeProvider("teaching");
let lightLlmProvider = buildLlmRuntimeProvider("light");
// 受限 agent loop：模型从固定动作菜单提议教学动作，状态机降级为守门校验层；TUTOR_AGENT_LOOP=off 退回纯 workflow
const actionLoopEnabled = (process.env.TUTOR_AGENT_LOOP ?? "on").toLowerCase() !== "off";
tboot("createLlmProvider");

const sessions = new Map<string, TutorSession>();
const clients = new Set<{ send(data: string): void; readyState: number }>();

/**
  会话解析：内存命中直接返回；未命中（引擎重启把内存 Map 清零）时，从当前挂载仓库的 journal
  按 sessionId 重放回内存（`restoreSessionFromJournal`，见 harness/restore.ts 的诚实边界）。
  恢复后仓库须仍在挂载态——否则会话引用的节点/文件已不在引擎里，宁可 404 让 GUI 走新建，不挂半截会话。
  */
function resolveSession(sessionId: string): TutorSession | undefined {
  const live = sessions.get(sessionId);
  if (live) return live;
  for (const repository of importer.mountedRepositories()) {
    const restored = restoreSessionFromJournal(readJournal(repository.path), sessionId);
    if (restored && restored.repositoryId === repository.index.repositoryId) {
      sessions.set(restored.id, restored);
      return restored;
    }
  }
  return undefined;
}

await app.register(cors, { origin: true });
tboot("cors registered");

await app.register(websocket);
tboot("websocket registered");

tboot("before listen");

function broadcast(event: ServerEvent): void {
  const serialized = JSON.stringify(event);
  for (const client of clients) if (client.readyState === 1) client.send(serialized);
}

function repositoryOr404(repositoryId: string) {
  return importer.getRepository(repositoryId);
}

function repositorySettings(repositoryPath: string, repositoryId: string): { monthlyBudgetUsd: number } {
  return readRepositorySettings(repositoryPath, repositoryId);
}

/** 每仓可持久化的设置形态（settings_json 里的一个子集；refinement 标记等内部键不在此列、读写都须保留）。 */
interface RepositorySettingsPayload {
  monthlyBudgetUsd: number;
  summaryHeaderComments: boolean;
}

function readRepositorySettings(repositoryPath: string, repositoryId: string): RepositorySettingsPayload {
  const database = new TutorDatabase(repositoryPath);
  const settings = database.getSettings<{ monthlyBudgetUsd?: number; summaryHeaderComments?: boolean }>(repositoryId);
  database.close();
  return {
    monthlyBudgetUsd: typeof settings?.monthlyBudgetUsd === "number" && settings.monthlyBudgetUsd >= 0 ? settings.monthlyBudgetUsd : defaultMonthlyBudgetUsd,
    summaryHeaderComments: settings?.summaryHeaderComments === true
  };
}

/** L1 摘要表 → `path → 一句话职责`（流程证据、search 语料、推荐入口共用）。 */
function latestFileSummaries(repositoryPath: string): Map<string, string> {
  const database = new TutorDatabase(repositoryPath);
  const rows = database.getLatestFileSummaries();
  database.close();
  return new Map(rows.map((row) => [row.path, row.summary]));
}

/** search_code 语料：已分析路径 + 图符号表 + L1 一句话职责。
    coverageLow 不再扣用（09-22 拍板）：anchor-v2 判低的残余只是「纯中文行为描述、没复述符号名」，
    扣掉等于把职责线索也丢出语料；判据保留为 metrics 读数。
    每次请求现建：纯 CPU 毫秒级、且永远跟随最新一次导入的产物，不值得也没有失效语义可缓存。 */
function searchCorpusFor(repository: NonNullable<ReturnType<typeof repositoryOr404>>): SearchCorpus {
  return buildSearchCorpus(repository.index, repository.analysis, latestFileSummaries(repository.path));
}

/** GUI 上送的 scopePaths（架构图 chip 的文件清单）：只留非空字符串、去重封顶。它是提示而非裁决——未知路径由引擎交集丢弃。 */
function sanitizeScopePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 400))];
  return paths.length ? paths.slice(0, 1_000) : undefined;
}

/** 作用域对话上送的最近历史回合（入参守卫）：角色白名单 + 内容非空截长，只留最后 6 条；窗口渲染口径在 scopechat/service.ts。 */
function sanitizeChatHistory(value: unknown): ScopedChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ScopedChatTurn[] => {
    if (typeof item !== "object" || item === null) return [];
    const turn = item as { role?: unknown; content?: unknown };
    if (turn.role !== "user" && turn.role !== "assistant") return [];
    if (typeof turn.content !== "string" || !turn.content.trim()) return [];
    return [{ role: turn.role, content: turn.content.trim().slice(0, 2_000) }];
  }).slice(-6);
}

/** 作用域对话上送的窗口外问题脉络（入参守卫）：只留非空字符串并截长，封顶 8 条；渲染口径在 scopechat/service.ts。 */
function sanitizeEarlierQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => (typeof item === "string" && item.trim() ? [item.trim().slice(0, 400)] : [])).slice(-8);
}

importer.on("event", broadcast);

app.get("/api/health", async () => {
  const llm = teachingProviderStatus(teachingProvider);
  return {
    status: "ok", service: "codebase-tutor-engine", version: engineVersion,
    summaryProvider: process.env.TUTOR_SUMMARY_PROVIDER ?? "local",
    llmProvider: llm.provider, llmModel: llm.model, llmMode: llm.mode,
    thinking: getLlmRuntimeSettings().thinking,
    agentLoop: actionLoopEnabled
  };
});

/** 生效模型的思考能力声明（按实际生效 slug 解析，随 GET/PUT /api/llm/settings 返回给 GUI）。 */
function describeThinking(model: string): { model: string; style: ReturnType<typeof resolveThinkingCapability>["style"]; efforts: string[] } {
  const capability = resolveThinkingCapability(model);
  return { model, style: capability.style, efforts: supportedThinkingEfforts(capability) };
}

/** GUI 运行时 LLM 设置：读取（含 .env 预设模型清单 + 生效模型的思考能力声明，供 GUI 禁用不支持的档位） */
app.get("/api/llm/settings", async () => {
  const settings = getLlmRuntimeSettings();
  const presets = (process.env.TUTOR_MODEL_PRESETS ?? "").split(",").map((slug) => slug.trim()).filter(Boolean);
  return {
    ...settings,
    presets,
    // 能力按「实际生效的模型 slug」解析（运行时覆盖优先，回落 .env），与 provider 工厂同一套解析
    thinkingCapability: describeThinking(resolveModelSlug({ model: settings.model }))
  };
});

/** GUI 运行时 LLM 设置：更新模型覆盖与思考档位，立即重建 provider（不落盘，重启回落 .env） */
app.put<{ Body: { model?: string; thinking?: string } }>("/api/llm/settings", async (request, reply) => {
  const body = request.body ?? {};
  if (body.thinking !== undefined && !["auto", "off", "low", "high", "max"].includes(body.thinking)) {
    return reply.code(422).send({ error: "thinking 只支持 auto / off / low / high / max" });
  }
  // 思考档位与（新）模型的兼容性提前校验：不支持的组合在保存时就拒绝，而不是等每次对话调用时报错。
  // off 豁免：none/unknown 模型的 off = 不发字段（恒可表达，与 applyThinking 语义一致），不能被这里 422 掉。
  if (body.thinking && body.thinking !== "auto") {
    const model = resolveModelSlug({ model: typeof body.model === "string" ? body.model : undefined });
    if (!isThinkingEffortSupported(model, body.thinking as "auto" | "off" | "low" | "high" | "max")) {
      const supported = supportedThinkingEfforts(resolveThinkingCapability(model));
      return reply.code(422).send({ error: `模型 ${model} 不支持思考档位 "${body.thinking}"（支持：${supported.length ? supported.join("/") : "无"}）` });
    }
  }
  const settings = setLlmRuntimeSettings({
    model: typeof body.model === "string" ? body.model : undefined,
    thinking: body.thinking as never
  });
  teachingProvider = buildLlmRuntimeProvider("teaching");
  lightLlmProvider = buildLlmRuntimeProvider("light");
  const active = teachingProviderStatus(teachingProvider);
  // 响应带生效模型与能力声明：GUI 换模型后无需再 GET 一次即可刷新思考档位的可用状态
  return {
    ...settings,
    activeModel: active.model,
    thinkingCapability: describeThinking(resolveModelSlug({ model: settings.model }))
  };
});

app.get("/ws", { websocket: true }, (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
});

app.post<{ Body: { path?: string; summaryHeaderComments?: boolean } }>("/api/imports", async (request, reply) => {
  try { return reply.code(202).send(importer.submit(request.body?.path ?? "", typeof request.body?.summaryHeaderComments === "boolean" ? request.body.summaryHeaderComments : undefined)); }
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
    implementation: repository.analysis.implementations.find((unit) => unit.id === nodeId)
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

app.post<{ Params: { repositoryId: string }; Body: { kind?: ExerciseKind; targetUnitId?: string; moduleId?: string; moduleIds?: string[]; family?: "comprehension" | "llm"; tag?: string; tagId?: string; variantNonce?: number } }>("/api/repositories/:repositoryId/exercises", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const kind = request.body?.kind;
  const family = request.body?.family === "llm" ? "llm" as const : "comprehension" as const;
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (family === "llm" && !(request.body?.tag ?? "").trim()) return reply.code(400).send({ error: "LLM 出题需要提供主题标签" });
  if (kind && !EXERCISE_KINDS.includes(kind)) return reply.code(400).send({ error: "不支持的练习题型" });
  const monthlyBudget = repositorySettings(repository.path, repository.index.repositoryId).monthlyBudgetUsd;
  const budgetExceeded = summarizeCost(repository.path, monthlyBudget).mode === "degraded";
  try {
    return reply.code(201).send(await exercises.next(repository, {
      kind,
      targetUnitId: request.body?.targetUnitId,
      moduleId: request.body?.moduleId,
      moduleIds: request.body?.moduleIds,
      family,
      tag: request.body?.tag,
      tagId: request.body?.tagId,
      variantNonce: request.body?.variantNonce
    }, budgetExceeded ? undefined : lightLlmProvider));
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法生成练习" });
  }
});

// 教学模块「推荐入口」：LLM 从课程树候选节点中挑选（单轮调用）；未配置 LLM / 预算触顶时返回空列表，GUI 回落关键词分类
app.get<{ Params: { repositoryId: string }; Querystring: { module?: string; hint?: string } }>("/api/repositories/:repositoryId/module-entries", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const moduleLabel = (request.query.module ?? "").trim();
  if (!moduleLabel) return reply.code(400).send({ error: "请提供模块名称" });
  const monthlyBudget = repositorySettings(repository.path, repository.index.repositoryId).monthlyBudgetUsd;
  const provider = summarizeCost(repository.path, monthlyBudget).mode === "degraded" ? undefined : lightLlmProvider;
  if (!provider) return { entries: [], source: "heuristic" as const };
  const database = new TutorDatabase(repository.path);
  try {
    const suggestion = await suggestModuleEntriesCached({
      tree: repository.course, moduleLabel, moduleHint: (request.query.hint ?? "").trim(), provider,
      fileSummaries: latestFileSummaries(repository.path),
      // 零分候选的补位信号（P3）：入口点在前、高频改动的热点文件其次——比路径字典序靠谱得多
      boostPaths: [...new Set([
        ...(repository.analysis.graph.entrypoints ?? []).map((entrypoint) => entrypoint.path),
        ...repository.index.hotspots.slice(0, 20).map((hotspot) => hotspot.path)
      ])],
      repositoryId: repository.index.repositoryId,
      // 「近期仓库变更」参考段的数据源（A2）：只进选择层 user 消息，不进缓存键
      analysis: repository.analysis,
      database
    });
    if (suggestion.usage) new Journal(repository.path, repository.index.repositoryId).append("token_usage", {
      input_tokens: suggestion.usage.inputTokens,
      output_tokens: suggestion.usage.outputTokens,
      cache_hit_tokens: suggestion.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "module_entries"
    });
    return { entries: suggestion.entries, source: "llm" as const };
  } finally {
    database.close();
  }
});

// 宏观设计「流程视图」：按入口用 LLM 生成执行流程（静态调用链作为证据输入 + 降级视图）。
// 缓存命中零成本；未配置 LLM / 预算触顶 / 调用失败都返回静态调用链并带 reason，不静默降级。
app.get<{ Params: { repositoryId: string }; Querystring: { entry?: string } }>("/api/repositories/:repositoryId/flow", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const entries = repository.analysis.graph.entrypoints;
  const wanted = (request.query.entry ?? "").trim();
  // 入口识别是启发式（package.json 清单 + 约定文件名），识别不到/识别错时允许人工指定任意已索引文件作为起点
  const entry = resolveFlowEntry(wanted, entries, repository.index.files, repository.analysis.graph);
  if (!entry) {
    const reason = wanted
      ? "该路径不在仓库索引里，无法作为流程入口。"
      : "该仓库没有识别到执行入口，也未手动指定；请在流程视图里从文件清单中选择一个起点。";
    return reply.code(404).send({ error: reason });
  }
  const monthlyBudget = repositorySettings(repository.path, repository.index.repositoryId).monthlyBudgetUsd;
  // 流程生成走**主力档**（2026-09-18 由轻量档改过来）：它是「看着整仓证据推断编排」的重任务，
  // 而轻量档现在承担 L1 的文件级摘要（量大、单条简单）。两者不共用一档。
  const provider = summarizeCost(repository.path, monthlyBudget).mode === "degraded" ? undefined : teachingProvider;
  if (!provider) return degradedFlow(repository.analysis, entry, "未配置主力档 LLM 或本月预算已触顶");
  const database = new TutorDatabase(repository.path);
  try {
    const generated = await generateRepositoryFlowCached({
      repositoryPath: repository.path,
      index: repository.index,
      analysis: repository.analysis,
      entry,
      provider,
      summaries: latestFileSummaries(repository.path),
      repositoryId: repository.index.repositoryId,
      database
    });
    if (generated.usage) new Journal(repository.path, repository.index.repositoryId).append("token_usage", {
      input_tokens: generated.usage.inputTokens,
      output_tokens: generated.usage.outputTokens,
      cache_hit_tokens: generated.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "flow_map"
    });
    return { flow: generated.flow, source: generated.source, ...(generated.reason ? { reason: generated.reason } : {}) };
  } finally {
    database.close();
  }
});

app.post<{ Params: { repositoryId: string; exerciseId: string }; Body: ExerciseAnswer }>("/api/repositories/:repositoryId/exercises/:exerciseId/answer", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const monthlyBudget = repositorySettings(repository.path, repository.index.repositoryId).monthlyBudgetUsd;
  const provider = summarizeCost(repository.path, monthlyBudget).mode === "degraded" ? undefined : lightLlmProvider;
  try {
    return await exercises.answer(repository, request.params.exerciseId, request.body ?? {}, provider);
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法判分" });
  }
});

// 作用域对话（宏观设计 / 练习评估）：单轮 LLM 开放讨论，无教学状态机；预算触顶或未配置 LLM 时显式 422（不静默回落）
function scopedChatProviderOr422(reply: FastifyReply, repositoryPath: string, repositoryId: string): LlmProvider | undefined {
  const monthlyBudget = repositorySettings(repositoryPath, repositoryId).monthlyBudgetUsd;
  if (summarizeCost(repositoryPath, monthlyBudget).mode === "degraded") {
    void reply.code(422).send({ error: "本月预算已触顶，此作用域的 LLM 对话不可用；可在设置中调整预算。" });
    return undefined;
  }
  if (!teachingProvider) {
    void reply.code(422).send({ error: "尚未配置 LLM（TUTOR_TEACHING_PROVIDER/MODEL），此作用域的 LLM 对话不可用。" });
    return undefined;
  }
  return teachingProvider;
}

app.post<{ Params: { repositoryId: string }; Body: { content?: string; nodeId?: string; scopePaths?: string[]; path?: string; history?: unknown; earlierQuestions?: unknown; style?: unknown } }>("/api/repositories/:repositoryId/map-chat", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flatten(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  try {
    const result = await mapChat({ repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, content, history: sanitizeChatHistory(request.body?.history), earlierQuestions: sanitizeEarlierQuestions(request.body?.earlierQuestions), provider, style: validateStyle(request.body?.style), search: searchCorpusFor(repository) });
    const journal = new Journal(repository.path, repository.index.repositoryId);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map_chat"
    });
    // 同一轮对同一路径的重复读取（重试/换窗口）在 journal 归并为一条：审计回答「看过哪些文件」
    for (const read of dedupeFileReads(result.fileReads ?? [])) {
      journal.append("file_read", {
        path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, error: read.error ?? null
      });
    }
    // 检索漏斗：搜了什么、命中多少、前几条落在哪——「先搜后读」的转化率要靠这条读数
    for (const search of result.codeSearches ?? []) {
      journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、") });
    }
    // 作用域验收信号：降级次数是「上下文≠选中项」的负向代理指标（设计方案 §10 层2），必须留痕可聚合
    if (result.scopeDegraded) {
      journal.append("scope_degraded", { node_id: result.scopeDegraded.nodeId, scope_paths: result.scopeDegraded.scopePathsCount });
    }
    journal.append("turn_text", turnTextPayload("map_chat", content, result.reply));
    return { reply: result.reply, provider: result.provider };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "LLM 对话失败" });
  }
});

/** map-chat 流式版：SSE 推送过程事件（thinking / reading），GUI 借此显示「回复生成中 / 正在读取 xx」。 */
app.post<{ Params: { repositoryId: string }; Body: { content?: string; nodeId?: string; scopePaths?: string[]; path?: string; history?: unknown; earlierQuestions?: unknown; style?: unknown } }>("/api/repositories/:repositoryId/map-chat/stream", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flatten(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: unknown): void => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    const result = await mapChat({
      repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, content, history: sanitizeChatHistory(request.body?.history), earlierQuestions: sanitizeEarlierQuestions(request.body?.earlierQuestions), provider,
      style: validateStyle(request.body?.style),
      search: searchCorpusFor(repository),
      onProgress: (progress: MapChatProgress) => send(progress)
    });
    const journal = new Journal(repository.path, repository.index.repositoryId);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map_chat"
    });
    for (const read of dedupeFileReads(result.fileReads ?? [])) {
      journal.append("file_read", {
        path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, error: read.error ?? null
      });
    }
    for (const search of result.codeSearches ?? []) {
      journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、") });
    }
    if (result.scopeDegraded) {
      journal.append("scope_degraded", { node_id: result.scopeDegraded.nodeId, scope_paths: result.scopeDegraded.scopePathsCount });
    }
    journal.append("turn_text", turnTextPayload("map_chat", content, result.reply));
    send({ type: "done", reply: result.reply, provider: result.provider });
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.message : "LLM 对话失败" });
  }
  reply.raw.end();
});

app.post<{ Params: { repositoryId: string }; Body: { content?: string; exerciseId?: string; history?: unknown; earlierQuestions?: unknown; style?: unknown } }>("/api/repositories/:repositoryId/practice-chat", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  if (!request.body?.exerciseId) return reply.code(400).send({ error: "缺少练习上下文；请先在练习页生成一道练习。" });
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  const database = new TutorDatabase(repository.path);
  try {
    const stored = database.getExerciseCacheById<{ exercise: Exercise }>(repository.index.repositoryId, request.body.exerciseId);
    if (!stored) return reply.code(404).send({ error: "练习不存在或已被清理；请重新生成练习。" });
    const result = await practiceChat({ repoPath: repository.path, exercise: stored.exercise, content, history: sanitizeChatHistory(request.body?.history), earlierQuestions: sanitizeEarlierQuestions(request.body?.earlierQuestions), provider, style: validateStyle(request.body?.style) });
    const journal = new Journal(repository.path, repository.index.repositoryId);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "practice_chat"
    });
    journal.append("turn_text", turnTextPayload("practice_chat", content, result.reply));
    return { reply: result.reply, provider: result.provider };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "LLM 对话失败" });
  } finally {
    database.close();
  }
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/report", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  return {
    index: repository.index,
    estimate: repository.estimate,
    entrypoints: flatten(repository.course.root).filter((node) => node.kind === "workflow").map((node) => ({ title: node.title, anchors: node.anchors })),
    analysis: { implementations: repository.analysis.implementations.length, semanticBackend: repository.analysis.graph.semanticBackend, lspStatus: repository.analysis.graph.lspStatus }
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

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/settings", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  return readRepositorySettings(repository.path, repository.index.repositoryId);
});

app.put<{ Params: { repositoryId: string }; Body: { monthlyBudgetUsd?: number; summaryHeaderComments?: boolean } }>("/api/repositories/:repositoryId/settings", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const budget = request.body?.monthlyBudgetUsd;
  const hasBudget = budget !== undefined;
  const hasToggle = typeof request.body?.summaryHeaderComments === "boolean";
  if (!hasBudget && !hasToggle) return reply.code(400).send({ error: "至少提供 monthlyBudgetUsd 或 summaryHeaderComments 之一" });
  if (hasBudget && (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0)) return reply.code(400).send({ error: "预算必须是非负数字" });
  const database = new TutorDatabase(repository.path);
  // 读-合并-写：settings_json 里还存着 refinement 标记等内部键，整体覆盖会把它们抹掉
  const stored = database.getSettings<{ monthlyBudgetUsd?: number; summaryHeaderComments?: boolean; refinement?: unknown }>(repository.index.repositoryId) ?? {};
  const merged = {
    ...stored,
    ...(hasBudget ? { monthlyBudgetUsd: budget } : {}),
    ...(hasToggle ? { summaryHeaderComments: request.body.summaryHeaderComments } : {})
  };
  database.saveSettings(repository.index.repositoryId, merged);
  database.close();
  const next = { ...readRepositorySettings(repository.path, repository.index.repositoryId) };
  return { ...summarizeCost(repository.path, next.monthlyBudgetUsd), settings: next };
});

/**
  L1 摘要按当前「摘要参考注释」开关重烧（有意的产品写入，与 `l1:reburn` 脚本同一通道）。
  切开关后必须调它，新档位才生效——键前缀分流（slice-v2 / slice-v2c）保证另一档的存量行原样保留。
*/
app.post<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/summaries/rebuild", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const settings = readRepositorySettings(repository.path, repository.index.repositoryId);
  // 预算降级或 light 未配置时不烧钱：与导入路径同口径，确定性档重烧会把 LLM 摘要整表覆盖成兜底
  const lightProvider = summarizeCost(repository.path, settings.monthlyBudgetUsd).mode === "degraded" ? undefined : buildLlmRuntimeProvider("light");
  const provider = createSummaryProvider({ llm: lightProvider, withHeaderComments: settings.summaryHeaderComments });
  if (provider instanceof LocalSummaryProvider) {
    return reply.code(409).send({ error: "摘要档解析为确定性档（轻量模型未配置、或预算已降级）：重烧会把 LLM 摘要整表覆盖成兜底摘要，已中止。" });
  }
  const database = new TutorDatabase(repository.path);
  try {
    const { estimate } = await summarizeFiles({
      structure: fileStructureOf(indexRepository(repository.path).files, graphFromData(repository.analysis.graph)),
      database,
      provider,
      withHeaderComments: settings.summaryHeaderComments
    });
    return estimate;
  } finally {
    database.close();
  }
});

app.post<{ Body: { repositoryId?: string; courseNodeId?: string; settings?: Partial<TutorSettings>; style?: unknown } }>("/api/sessions", async (request, reply) => {
  const repository = repositoryOr404(request.body?.repositoryId ?? "");
  const node = repository && flatten(repository.course.root).find((item) => item.id === request.body?.courseNodeId);
  if (!repository || !node) return reply.code(404).send({ error: "课程节点不存在" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : undefined);
  const hasExplicitSettings = Boolean(request.body?.settings && Object.keys(request.body.settings).length) || typeof request.body?.style === "number";
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  let settings = hasExplicitSettings
    ? validateSettings({ ...defaultTutorSettings, ...request.body?.settings, style: requestedStyle })
    : learnerProfile.recommended.settings;
  const session = createSession(repository.index.repositoryId, node.id, settings);
  sessions.set(session.id, session);
  new Journal(repository.path, repository.index.repositoryId).append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "session_created" }, session.id);
  return reply.code(201).send({ session, recommendedSettings: learnerProfile.recommended, faded: learnerProfile.fadedByUnit[node.id] ?? learnerProfile.faded, policy: policyFor(session.settings), context: assembleContext({ node, policy: policyFor(session.settings), history: [], repositoryPath: repository.path, analysis: repository.analysis }) });
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  const session = resolveSession(request.params.sessionId);
  return session ?? reply.code(404).send({ error: "会话不存在" });
});

/** 该课程节点最近一次教学会话的 id（从 journal 倒扫）：GUI 刷新后即使本地没存过 id，也能找回存量历史。 */
app.get<{ Params: { repositoryId: string }; Querystring: { nodeId?: string } }>("/api/repositories/:repositoryId/latest-session", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库未挂载" });
  return { sessionId: findLatestSessionForNode(readJournal(repository.path), request.query.nodeId ?? "") ?? null };
});

app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; style?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const current = resolveSession(request.params.sessionId);
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
  const outcome = await respondWithProvider(session, node, request.body.content.trim(), currentCost.mode === "degraded" ? undefined : teachingProvider, faded, repository.path, {
    classifier: actionLoopEnabled ? undefined : (currentCost.mode === "degraded" ? undefined : lightLlmProvider),
    actionLoop: actionLoopEnabled,
    analysis: repository.analysis,
    search: searchCorpusFor(repository),
    // 过程提示：回合可能持续数秒，把「正在判断动作 / 正在读 xx 文件」实时推给 GUI（ws 广播，不占 HTTP 响应）
    onProgress: (progress) => broadcast({ type: "session.progress", payload: { sessionId: session.id, ...progress } })
  });
  sessions.set(outcome.session.id, outcome.session);
  const journal = new Journal(repository.path, repository.index.repositoryId);
  if (styleChanged) journal.append("style_shift", { style: settings.style, pedagogy: settings.pedagogy, depth: settings.depth, trigger: "manual" }, session.id);
  if (outcome.actionSource === "vetoed") journal.append("action_veto", { unit_id: node.id, proposed: outcome.proposedAction ?? "unknown", enforced: outcome.action ?? "unknown", stage: outcome.session.stage }, session.id);
  journal.append("hint_depth", { unit_id: node.id, depth: outcome.hintDepth, stage: outcome.session.stage, fallback_count: outcome.session.fallbackCount, resolved_by: outcome.event === "dependency" ? "answer_circuit_breaker" : "learner_attempt" }, session.id);
  if (outcome.event === "dependency") journal.append("dependency_event", { unit_id: node.id, after_attempts: 2, reason: "two_consecutive_step_downs" }, session.id);
  if (outcome.event === "confirmation") journal.append("unit_mastered", { unit_id: node.id, method: "source_backed_explanation" }, session.id);
  const tokenEvent = journal.append("token_usage", { input_tokens: outcome.usage?.inputTokens ?? Math.ceil(request.body.content.length / 4), output_tokens: outcome.usage?.outputTokens ?? Math.ceil(outcome.assistant.content.length / 4), cache_hit_tokens: outcome.usage?.promptCacheHitTokens ?? null, provider: outcome.provider ?? "local-heuristic-v1", scene: "teach", intent_source: outcome.intentSource ?? "regex", action_source: outcome.actionSource ?? "deterministic" }, session.id);
  // 回合文本落盘（B 档第 2/3 刀的被测输入）：问题+回复双边，各截 2000 字并留痕；降级轮也记（裁判要看到「这一轮没走 LLM」的成品）
  journal.append("turn_text", turnTextPayload("teach", request.body.content.trim(), outcome.assistant.content), session.id);
  // 教学回合的 read_file 审计：与宏观设计作用域同一事件类型；同路径重复读取归并为一条
  for (const read of dedupeFileReads(outcome.fileReads ?? [])) {
    journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, error: read.error ?? null }, session.id);
  }
  for (const search of outcome.codeSearches ?? []) {
    journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、") }, session.id);
  }
  const cost = summarizeCost(repository.path, monthlyBudget, session.id);
  if (cost.mode === "degraded") {
    journal.append("token_usage", { input_tokens: 0, output_tokens: 0, provider: outcome.provider ?? "local-heuristic-v1", scene: "teach", mode: "degraded", cause: "monthly_budget_reached" }, session.id);
    // 降级必须显式留痕：日志里也要能查到「这一轮为什么没走 LLM」
    traceEngine("degrade", { scope: "teaching", cause: "monthly_budget_reached", session: session.id });
  }
  for (const delta of chunk(outcome.assistant.content, 72)) broadcast({ type: "session.delta", payload: { sessionId: session.id, messageId: outcome.assistant.id, delta } });
  broadcast({ type: "session.complete", payload: { sessionId: session.id, message: outcome.assistant, stage: outcome.session.stage, cost, tokenEventId: tokenEvent.id } });
  return { session: outcome.session, message: outcome.assistant, policy: policyFor(settings), cost, provider: outcome.provider ?? "local-heuristic-v1" };
});

/**
  UI 动作事件出口（设计文档第 8 章 PRINCIPLE 03「可观测」）：
  每一次切节点、打开文件、切换模块、提交练习都必须有 journal 事件可查——缺事件的 UI 操作是设计漏洞。

  契约要点：
  - 白名单与 `Journal.append` **共用**（`isJournalEventType`），不另立一份，避免两处漂移。
  - `payload` 仅允许标量（`string | number | boolean | null`）：结构化对象会随版本漂移。
  - `sessionId` **不做存在性校验**（只校验是字符串且有长度上限）：journal 是 append-only 事件流，
    sessionId 是关联属性而非外键。教学会话虽已能按 sessionId 从 journal 续命恢复（`resolveSession`），
    但 map/practice 对话本就没有会话态、重启窗口期内也查不到——若按外键拒绝，前端会把能写的事件丢掉，
    那才是真的把可观测性弄丢。
  */
app.post<{ Params: { repositoryId: string }; Body: { type?: unknown; payload?: unknown; sessionId?: unknown } }>("/api/repositories/:repositoryId/journal", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const { type, payload, sessionId } = request.body ?? {};
  if (!isJournalEventType(type)) return reply.code(400).send({ error: "事件类型不在 journal 契约内。" });
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return reply.code(400).send({ error: "payload 必须是对象。" });
  }
  const scalars = (payload ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(scalars)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") continue;
    if (typeof value !== "string") return reply.code(400).send({ error: `payload.${key} 仅允许 string | number | boolean | null。` });
    if (value.length > 2000) return reply.code(400).send({ error: `payload.${key} 过长（上限 2000 字符）。` });
  }
  if (sessionId !== undefined && typeof sessionId !== "string") return reply.code(400).send({ error: "sessionId 必须是字符串。" });
  const event = new Journal(repository.path, repository.index.repositoryId)
    .append(type, scalars as JournalEvent["payload"], sessionId as string | undefined);
  return reply.code(201).send(event);
});

function flatten(root: CourseNode): CourseNode[] { return [root, ...root.children.flatMap(flatten)]; }
function chunk(content: string, width: number): string[] { return content.match(new RegExp(`.{1,${width}}`, "g")) ?? [content]; }

const port = Number(process.env.ENGINE_PORT ?? 3001);
await app.listen({ port, host: "127.0.0.1" });
tboot("listening");
