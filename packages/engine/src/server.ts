import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as _perf } from "node:perf_hooks";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { EXERCISE_KINDS } from "@codebase-tutor/shared";
import type { ChatScope, ChatThread, CourseNode, Exercise, ExerciseAnswer, ExerciseKind, FlowStage, JournalEvent, ServerEvent, TeachingStage, TutorMessage, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import type { FastifyReply } from "fastify";
import { summarizeCost, defaultMonthlyBudgetUsd } from "./cost/cost.js";
import { annotateModuleTiers, courseChildren, courseOverview, findCourseNode } from "./coursetree/projection.js";
import { suggestModuleEntriesCached } from "./coursetree/entry-suggest.js";
import { impactRadius, graphFromData } from "./depgraph/graph.js";
import { classifyFileRoles, fileStructureOf } from "./depgraph/roles.js";
import { ExerciseService } from "./exercises/exercises.js";
import { degradedFlow, generateRepositoryFlowCached, resolveFlowEntry } from "./flows/flow.js";
import { respondWithProvider, createSession } from "./harness/harness.js";
import { assembleContext } from "./harness/context.js";
import { ImportService } from "./importer/importer.js";
import { indexRepository } from "./indexer/indexer.js";
import { id, isWithin, turnTextPayload } from "./lib.js";
import { loadDotEnv } from "./config/dotenv.js";
import { defaultTutorSettings, policyFor, validateSettings, validateStyle } from "./tutor-settings/tutor-settings.js";
import { createSummaryProvider, LocalSummaryProvider } from "./summarizer/summary-provider.js";
import { summarizeFiles } from "./summarizer/summarizer.js";
import { TutorDatabase } from "./store/database.js";
import { Journal, isJournalEventType, readJournal } from "./store/journal.js";
import { appendMessages, createThread, getThread, isChatScope, latestThreadForNode, listThreads, readMessages, readThreadState, renameThread, saveThreadState, softDeleteThread, type NewMessage, type TeachingThreadState } from "./store/chat-store.js";
import { runWithTrace } from "./trace/context.js";
import { traceEngine } from "./trace/engine-log.js";
import { abortTurn, beginTurn } from "./turns/registry.js";
import { dedupeFileReads } from "./source/read-file.js";
import { buildSearchCorpus, type SearchCorpus } from "./source/search-code.js";
import { deriveLearnerProfile } from "./learner/model.js";
import { LlmAbortedError, resolveLlmConfig, teachingProviderStatus, type LlmProvider } from "./llm/provider.js";
import { isThinkingEffortSupported, resolveThinkingCapability, supportedThinkingEfforts } from "./llm/thinking.js";
import { buildLlmRuntimeProvider, effectiveLlmConfig, getLlmRuntimeSettings, LLM_PROVIDERS, publicLlmSettings, restoreLlmRuntimeSettings, setLlmRuntimeSettings, THINKING_EFFORTS } from "./llm/runtime.js";
import { mapChat, practiceChat, type MapChatProgress, type ScopedChatTurn } from "./scopechat/scopechat.js";

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

// LLM 走运行时构建器：服务商/模型/端点/密钥/思考档位来自运行时设置（GUI PUT /api/llm/settings 可改，
// 落盘持久，重启后仍在；空项回落 .env——.env 是降级策略而非唯一入口）。
// 只有一套配置；teaching / light 是**运行时角色**（差别只在思考开关），不是两份配置。
restoreLlmRuntimeSettings();
const restoredLlmSettings = getLlmRuntimeSettings();
if (restoredLlmSettings.provider || restoredLlmSettings.model || restoredLlmSettings.baseUrl || restoredLlmSettings.apiKey) console.log(`[startup] 已恢复 GUI 的 LLM 设置（${restoredLlmSettings.provider || "服务商回落 .env"} · ${restoredLlmSettings.model || "模型回落 .env"}）`);
let teachingProvider = buildLlmRuntimeProvider("teaching");
let lightLlmProvider = buildLlmRuntimeProvider("light");
// 受限 agent loop：模型从固定动作菜单提议教学动作，状态机降级为守门校验层；TUTOR_AGENT_LOOP=off 退回纯 workflow
const actionLoopEnabled = (process.env.TUTOR_AGENT_LOOP ?? "on").toLowerCase() !== "off";
tboot("createLlmProvider");

const teachingStates = new Map<string, TutorSession>();

/**
  在途教学状态的缓存：key 是 sessionId（= chat_session 的线程 id = GUI 的 threadId，同一个 id 三个名字）。
  库里那份才是真源，本 Map 只是省掉每回合重装配；引擎重启必然清零，所以「未命中」是常态而非异常。

  会话解析：内存命中直接返回；未命中时按 sessionId 从**该仓的 chat_session / chat_message** 装配回内存。
  缺最低证据（线程不在、已软删、或状态快照字段不齐）就返回 undefined——
  调用方照旧 404/400 让 GUI 走新建，绝不编造半截会话。

  09-27 起真源是这两张表，journal 重放（旧 harness/restore.ts）退役：审计线继续按自己的口径记截断摘要，
  但「接着聊」不该依赖审计摘要的 2000 字截断。
  */
function resolveTeachingState(sessionId: string): TutorSession | undefined {
  const live = teachingStates.get(sessionId);
  if (live) return live;
  for (const repository of importer.mountedRepositories()) {
    const restored = restoreThreadAsSession(repository.path, repository.index.repositoryId, sessionId);
    if (restored) {
      teachingStates.set(restored.id, restored);
      return restored;
    }
  }
  return undefined;
}

/** 教学线程 → TutorSession：正文取原文（不截断），状态取回合收尾写的快照。 */
function restoreThreadAsSession(repositoryPath: string, repositoryId: string, sessionId: string): TutorSession | undefined {
  const thread = getThread(repositoryPath, sessionId);
  if (!thread || thread.repositoryId !== repositoryId || thread.scope !== "teach" || !thread.courseNodeId) return undefined;
  const state = readThreadState(repositoryPath, sessionId);
  if (!state) return undefined;
  const settings = validateSettings(state.settings);
  return {
    id: thread.id,
    repositoryId: thread.repositoryId,
    courseNodeId: thread.courseNodeId,
    style: settings.style,
    settings,
    stage: state.stage,
    fallbackCount: state.fallbackCount,
    messages: readMessages(repositoryPath, sessionId) as TutorMessage[],
    createdAt: thread.createdAt
  };
}

/**
  教学回合落库：正文（user + assistant 全文，不截断）+ 回合结束后的状态快照。
  线程行不在就按同一个 id 补建再写——回合正文是产品数据，丢了比多一行严重得多；
  反过来如果静默跳过写入，GUI 重启后就会看到「聊过但没记录」的空会话。
  */
function persistTeachingTurn(repositoryPath: string, repositoryId: string, courseNodeId: string, title: string, sessionId: string, messages: NewMessage[], state: TeachingThreadState): void {
  if (!appendMessages(repositoryPath, sessionId, messages)) {
    createThread({ repositoryPath, repositoryId, scope: "teach", id: sessionId, courseNodeId, title });
    appendMessages(repositoryPath, sessionId, messages);
  }
  saveThreadState(repositoryPath, sessionId, state);
}

await app.register(cors, { origin: true });
tboot("cors registered");

tboot("before listen");

/** 全局事件流的订阅者（GET /api/events）：导入进度这类「无请求边界的推送」走这里；对话回放走各自请求的 SSE 响应流。 */
const subscribers = new Set<(event: ServerEvent) => void>();

function broadcast(event: ServerEvent): void {
  for (const subscriber of subscribers) subscriber(event);
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

/** 线程 id 入参守卫：非空字符串、截长；没给就是「无会话线程」（单次提问，不带历史也不落库）。 */
function sanitizeThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/**
  线程正文 → 模型上下文：最近 6 条进「最近对话」窗口，窗口外只留学习者提问作问题脉络。
  两条口径（6 条 / 8 条、逐行截断）住在 scopechat/scopechat.ts 的渲染常量里，这里只负责选行。

  它替换掉的是「客户端回传 history + earlierQuestions」那条通路（09-27 会话持久化）：
  进模型上下文的东西必须能在库里考据到——客户端临时拼的窗口正文既可能是旧的、也可能被改，
  与「上下文≠选中项」是同一类事故。
  */
function threadScopedHistory(repositoryPath: string, threadId: string | undefined): { history: ScopedChatTurn[]; earlierQuestions: string[] } {
  const messages = threadId ? readMessages(repositoryPath, threadId) : [];
  const boundary = Math.max(0, messages.length - 6);
  return {
    history: messages.slice(boundary).map((message) => ({ role: message.role, content: message.content })),
    earlierQuestions: messages.slice(0, boundary).filter((message) => message.role === "user").slice(-8).map((message) => message.content)
  };
}

/**
  取线程并核归属：不在库里 / 已软删 / 属于别的仓库 / 属于别的作用域一律 `undefined`（调用方据此拒绝本轮）。
  跨作用域复用线程会把教学问答喂进宏观设计的上下文，这种串味比一个 409 难查得多。
  */
function scopedThread(repository: NonNullable<ReturnType<typeof repositoryOr404>>, threadId: string | undefined, scope: ChatScope) {
  if (!threadId) return undefined;
  const thread = getThread(repository.path, threadId);
  if (!thread || thread.repositoryId !== repository.index.repositoryId || thread.scope !== scope) return undefined;
  return thread;
}

/** 流程视图选中环节（入参守卫）：逐字段核类型并截长后重建——请求体是外部输入，形状不可信；字段不齐即视为没选环节。 */
function sanitizeChatFocus(value: unknown): FlowStage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const stage = value as { order?: unknown; kind?: unknown; title?: unknown; detail?: unknown; files?: unknown; branches?: unknown; loopsTo?: unknown };
  if (typeof stage.order !== "number" || !Number.isFinite(stage.order)) return undefined;
  if (typeof stage.title !== "string" || !stage.title.trim()) return undefined;
  const kinds = ["entry", "stage", "decision", "loop", "exit"] as const;
  const kind = kinds.find((item) => item === stage.kind) ?? "stage";
  const files = Array.isArray(stage.files)
    ? stage.files.flatMap((item): { path: string; line: number; note?: string }[] => {
        if (typeof item !== "object" || item === null) return [];
        const file = item as { path?: unknown; line?: unknown; note?: unknown };
        if (typeof file.path !== "string" || !file.path.trim() || file.path.length > 400) return [];
        const line = typeof file.line === "number" && Number.isFinite(file.line) ? Math.max(0, Math.trunc(file.line)) : 1;
        return [{ path: file.path.trim(), line, ...(typeof file.note === "string" && file.note.trim() ? { note: file.note.trim().slice(0, 120) } : {}) }];
      }).slice(0, 200)
    : [];
  const branches = Array.isArray(stage.branches)
    ? stage.branches.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 160)).slice(0, 20)
    : [];
  return {
    order: Math.trunc(stage.order),
    kind,
    title: stage.title.trim().slice(0, 120),
    detail: typeof stage.detail === "string" ? stage.detail.trim().slice(0, 600) : "",
    files,
    branches,
    ...(typeof stage.loopsTo === "number" && Number.isFinite(stage.loopsTo) ? { loopsTo: Math.trunc(stage.loopsTo) } : {})
  };
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

/** GET/PUT 共用的响应装配：运行时设置（**密钥只以掩码出现**）+ .env 回落值 + 生效状态 + 思考能力声明。 */
function llmSettingsPayload(): Record<string, unknown> {
  // envFallback 用「无任何覆盖」解析一次，得到纯 .env（+ 协议默认）的口径，GUI 才能把空字段说明成「留空 = 用 .env 的 xxx」
  const fallback = resolveLlmConfig({});
  const active = teachingProviderStatus(teachingProvider);
  return {
    ...publicLlmSettings(),
    presets: (process.env.TUTOR_MODEL_PRESETS ?? "").split(",").map((slug) => slug.trim()).filter(Boolean),
    envFallback: { provider: fallback.provider, model: fallback.model, baseUrl: fallback.baseUrl, hasApiKey: Boolean(fallback.apiKey) },
    activeModel: active.model,
    activeProvider: active.provider,
    activeMode: active.mode,
    // 能力按「实际生效的模型 slug」解析（运行时覆盖优先，回落 .env），与 provider 工厂同一套解析
    thinkingCapability: describeThinking(effectiveLlmConfig().model)
  };
}

/** GUI 运行时 LLM 设置：读取（含 .env 回落值、预设模型清单与生效模型的思考能力声明） */
app.get("/api/llm/settings", async () => llmSettingsPayload());

/** GUI 运行时 LLM 设置：更新服务商/模型/端点/密钥/思考档位，立即重建 provider 并落盘（留空 = 回落 .env） */
app.put<{ Body: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; thinking?: string } }>("/api/llm/settings", async (request, reply) => {
  const body = request.body ?? {};
  if (body.thinking !== undefined && !(THINKING_EFFORTS as readonly string[]).includes(body.thinking)) {
    return reply.code(422).send({ error: `thinking 只支持 ${THINKING_EFFORTS.join(" / ")}` });
  }
  const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : undefined;
  if (provider !== undefined && provider !== "" && !(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    return reply.code(422).send({ error: `服务商只支持 ${LLM_PROVIDERS.join(" / ")}（留空 = 用 .env）` });
  }
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : undefined;
  if (baseUrl) {
    // 只认 http(s)：填了 file:// 之类的协议会在 fetch 时以晦涩错误失败，不如在保存时就拒绝
    let protocol = "";
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {
      return reply.code(422).send({ error: "接口地址不是合法 URL（需带 http:// 或 https:// 前缀）" });
    }
    if (protocol !== "http:" && protocol !== "https:") return reply.code(422).send({ error: "接口地址只接受 http:// 或 https://" });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
  // 密钥里的空白几乎总是粘贴带进来的换行，存下来只会变成「401 但看不出为什么」的排查黑洞
  if (apiKey !== undefined && /\s/.test(apiKey)) return reply.code(422).send({ error: "API Key 不能含空格或换行" });

  // 思考档位与（新）服务商/模型的兼容性提前校验：不支持的组合在保存时就拒绝，而不是等每次对话调用时报错。
  // off 豁免：none/unknown 模型的 off = 不发字段（恒可表达，与 applyThinking 语义一致），不能被这里 422 掉。
  if (body.thinking && body.thinking !== "auto") {
    const model = resolveLlmConfig({ ...getLlmRuntimeSettings(), ...(provider === undefined ? {} : { provider }), ...(typeof body.model === "string" ? { model: body.model } : {}) }).model;
    if (!isThinkingEffortSupported(model, body.thinking as "auto" | "off" | "low" | "high" | "max")) {
      const supported = supportedThinkingEfforts(resolveThinkingCapability(model));
      return reply.code(422).send({ error: `模型 ${model} 不支持思考档位 "${body.thinking}"（支持：${supported.length ? supported.join("/") : "无"}）` });
    }
  }
  setLlmRuntimeSettings({
    ...(provider === undefined ? {} : { provider }),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    thinking: body.thinking as never
  });
  teachingProvider = buildLlmRuntimeProvider("teaching");
  lightLlmProvider = buildLlmRuntimeProvider("light");
  // 响应带生效状态与能力声明：GUI 换模型/换服务商后无需再 GET 一次即可刷新思考档位的可用状态。
  // 换到「缺密钥」的组合时建不出 provider（activeMode=local），这不算请求失败——把状态如实回给 GUI。
  return llmSettingsPayload();
});

app.get("/api/events", async (_request, reply) => {
  // SSE 替代原 /ws：EventSource 自带断线自动重连，浏览器兼容面与普通 HTTP 一致
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const subscriber = (event: ServerEvent): void => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  subscribers.add(subscriber);
  reply.raw.on("close", () => subscribers.delete(subscriber));
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
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  // 模块分级现算（主干/设施/外围）：角色是结构规则的纯函数，所以已导入的仓库不用重烧就能看到分级
  const roles = classifyFileRoles(fileStructureOf(repository.index.files, graphFromData(repository.analysis.graph)));
  return annotateModuleTiers(repository.course, roles);
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

app.post<{ Params: { repositoryId: string }; Body: { kind?: ExerciseKind; targetUnitId?: string; family?: "comprehension" | "llm"; tag?: string; tagId?: string; variantNonce?: number } }>("/api/repositories/:repositoryId/exercises", async (request, reply) => {
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
  const budgetExhausted = summarizeCost(repository.path, monthlyBudget).mode === "degraded";
  const provider = budgetExhausted ? undefined : lightLlmProvider;
  // 落到「模块自己的文件清单」的原因由引擎说，不让界面替用户猜（未配置/触顶/判空/失败几件事的用户处置完全不同，
  // 尤其「模型主动判空」是可信答案，被写成「还没配 LLM」会把人引去配密钥——与流程层 reason 同一套口径）
  const fallback = "以下按模块结构列出文件（模块地图给的清单，未排序）";
  if (!provider) return { entries: [], source: "module_files" as const, reason: `${budgetExhausted ? "本月预算已触顶，未调用 LLM" : "未配置 LLM"}；${fallback}。` };
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
    // 空列表分两种，必须说清：主动判空（declined）是可信答案、会进缓存；没调成或返回不合法不是。
    if (!suggestion.entries.length) {
      return { entries: [], source: "module_files" as const, reason: `${suggestion.declined ? "LLM 判断这些候选里没有真正合格的入口（不硬凑）" : "LLM 未给出可用入口（候选池为空或调用未成功）"}；${fallback}。` };
    }
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

/** 作用域回合的线程上下文三件套：解析 threadId → 核归属 → 从库里取历史。`threadId` 缺席即「单次提问」（不带历史、不落库）。 */
function scopedThreadTurn(repository: NonNullable<ReturnType<typeof repositoryOr404>>, value: unknown, scope: ChatScope): { threadId: string | undefined; history: ScopedChatTurn[]; earlierQuestions: string[] } | undefined {
  const threadId = sanitizeThreadId(value);
  if (!threadId) return { threadId: undefined, history: [], earlierQuestions: [] };
  const thread = scopedThread(repository, threadId, scope);
  if (!thread) return undefined;
  return { threadId: thread.id, ...threadScopedHistory(repository.path, thread.id) };
}

/**
  回合正文落库（用户问 + 助手答，全文不截断）：这是产品线，与 journal 的 `turn_text`（审计线，2000 字截断）
  是**有意的双写**——一份供模型下一轮读，一份供指标与裁判读。软删线程不会动这里的行，只让它查不到。
  */
function persistScopedTurn(repositoryPath: string, threadId: string | undefined, question: string, answer: string): void {
  if (!threadId) return;
  appendMessages(repositoryPath, threadId, [{ role: "user", content: question }, { role: "assistant", content: answer }]);
}

app.post<{ Params: { repositoryId: string }; Body: { content?: string; nodeId?: string; scopePaths?: string[]; path?: string; focus?: unknown; threadId?: unknown; style?: unknown } }>("/api/repositories/:repositoryId/map-chat", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const turn = scopedThreadTurn(repository, request.body?.threadId, "map");
  // 线程无效（跨仓库 / 跨作用域 / 已软删）在开火前拒绝：一个干净的 409 比「模型拿错上下文自信作答」便宜得多
  if (!turn) return reply.code(409).send({ error: "会话线程不存在、已删除或不属于本仓库的宏观设计作用域；请新建会话后再问。" });
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flatten(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  try {
    const result = await mapChat({ repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, focus: sanitizeChatFocus(request.body?.focus), content, history: turn.history, earlierQuestions: turn.earlierQuestions, provider, style: validateStyle(request.body?.style), search: searchCorpusFor(repository) });
    persistScopedTurn(repository.path, turn.threadId, content, result.reply);
    const journal = new Journal(repository.path, repository.index.repositoryId);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map_chat"
    }, turn.threadId);
    // 同一轮对同一路径的重复读取（重试/换窗口）在 journal 归并为一条：审计回答「看过哪些文件」
    for (const read of dedupeFileReads(result.fileReads ?? [])) {
      journal.append("file_read", {
        path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, error: read.error ?? null
      }, turn.threadId);
    }
    // 检索漏斗：搜了什么、命中多少、前几条落在哪——「先搜后读」的转化率要靠这条读数
    for (const search of result.codeSearches ?? []) {
      journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、") }, turn.threadId);
    }
    // 作用域验收信号：降级次数是「上下文≠选中项」的负向代理指标（设计方案 §10 层2），必须留痕可聚合
    if (result.scopeDegraded) {
      journal.append("scope_degraded", { node_id: result.scopeDegraded.nodeId, scope_paths: result.scopeDegraded.scopePathsCount }, turn.threadId);
    }
    journal.append("loop_round", { scene: "map_chat", decision: "deterministic", proposed: null, executed: null, tool_rounds: result.toolRounds, tool_reads: (result.fileReads ?? []).length, tool_searches: (result.codeSearches ?? []).length }, turn.threadId);
    journal.append("turn_text", turnTextPayload("map_chat", content, result.reply), turn.threadId);
    return { reply: result.reply, provider: result.provider };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "LLM 对话失败" });
  }
});

/** 「停止生成」的带外入口（三作用域共用）：GUI 点停止时先打这里，再断开自己的 SSE 连接。
    为什么单独一条而不是「连接断了就中止」：客户端消失分不出是用户要停还是网络波动/刷新页面——
    后者引擎必须把这一轮**算完并落库**，用户回来才有账可补（见 turns/registry.ts）。
    未命中 = 这一轮已经结束或本来就没登记，回 404，GUI 照常收尾、不当成错误。 */
app.post<{ Body: { turnId?: unknown } }>("/api/turns/stop", async (request, reply) => {
  const stopped = abortTurn(request.body?.turnId);
  if (!stopped.aborted) return reply.code(404).send({ stopped: false });
  traceEngine("turn_stop", { scene: stopped.scene, turn_id: stopped.turnId, waited_ms: stopped.waitedMs });
  return { stopped: true, scene: stopped.scene };
});

/** map-chat 流式版：SSE 推送过程事件（thinking / reading / searching），GUI 借此显示「回复生成中 / 正在读取 xx / 正在检索 xx」。 */
app.post<{ Params: { repositoryId: string }; Body: { content?: string; nodeId?: string; scopePaths?: string[]; path?: string; focus?: unknown; threadId?: unknown; style?: unknown; turnId?: unknown } }>("/api/repositories/:repositoryId/map-chat/stream", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const turn = scopedThreadTurn(repository, request.body?.threadId, "map");
  if (!turn) return reply.code(409).send({ error: "会话线程不存在、已删除或不属于本仓库的宏观设计作用域；请新建会话后再问。" });
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flatten(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: unknown): void => {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const turnHandle = beginTurn(request.body?.turnId, "map_chat");
  try {
    const result = await mapChat({
      repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, focus: sanitizeChatFocus(request.body?.focus), content, history: turn.history, earlierQuestions: turn.earlierQuestions, provider,
      style: validateStyle(request.body?.style),
      search: searchCorpusFor(repository),
      onProgress: (progress: MapChatProgress) => send(progress),
      ...(turnHandle.signal ? { signal: turnHandle.signal } : {})
    });
    // 与教学回合同款收尾：中止若晚于最后一趟 LLM 到达，这一轮照样作废，不落库也不回放
    if (turnHandle.signal?.aborted) throw new LlmAbortedError();
    persistScopedTurn(repository.path, turn.threadId, content, result.reply);
    const journal = new Journal(repository.path, repository.index.repositoryId);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map_chat"
    }, turn.threadId);
    for (const read of dedupeFileReads(result.fileReads ?? [])) {
      journal.append("file_read", {
        path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, error: read.error ?? null
      }, turn.threadId);
    }
    for (const search of result.codeSearches ?? []) {
      journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、") }, turn.threadId);
    }
    if (result.scopeDegraded) {
      journal.append("scope_degraded", { node_id: result.scopeDegraded.nodeId, scope_paths: result.scopeDegraded.scopePathsCount }, turn.threadId);
    }
    journal.append("loop_round", { scene: "map_chat", decision: "deterministic", proposed: null, executed: null, tool_rounds: result.toolRounds, tool_reads: (result.fileReads ?? []).length, tool_searches: (result.codeSearches ?? []).length }, turn.threadId);
    journal.append("turn_text", turnTextPayload("map_chat", content, result.reply), turn.threadId);
    // 打字机回放（三作用域同款 72 字分块）：真 token 流式需 provider 层改造，这里先消除「整段落下」
    for (const delta of chunk(result.reply, 72)) send({ type: "delta", delta });
    send({ type: "done", reply: result.reply, provider: result.provider });
  } catch (error) {
    if (turnHandle.signal?.aborted) {
      new Journal(repository.path, repository.index.repositoryId).append("turn_aborted", { scene: "map_chat", turn_id: turnHandle.turnId ?? "unregistered", aborted_by: "user_stop" }, turn.threadId);
      send({ type: "aborted", scene: "map_chat" });
    } else {
      send({ type: "error", error: error instanceof Error ? error.message : "LLM 对话失败" });
    }
  } finally {
    turnHandle.dispose();
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
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  // 练习查询留在 hijack 前：404 还是干净的 JSON，只有确定要开火了才切 SSE
  const database = new TutorDatabase(repository.path);
  let stored: { exercise: Exercise } | undefined;
  try {
    stored = database.getExerciseCacheById<{ exercise: Exercise }>(repository.index.repositoryId, request.body.exerciseId);
  } finally {
    database.close();
  }
  if (!stored) return reply.code(404).send({ error: "练习不存在或已被清理；请重新生成练习。" });
  const { history, earlierQuestions } = threadScopedHistory(repository.path, thread?.id);
  // 与 map-chat/stream 同款 SSE：delta 打字机回放 + done/error——GUI 三作用域的流式解析共用一条路径
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: unknown): void => {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const turnHandle = beginTurn(request.body?.turnId, "practice_chat");
  try {
    const result = await practiceChat({ repoPath: repository.path, exercise: stored.exercise, content, history, earlierQuestions, provider, style: validateStyle(request.body?.style), ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    // 与教学回合同款收尾：中止若晚于最后一趟 LLM 到达，这一轮照样作废，不落库也不回放
    if (turnHandle.signal?.aborted) throw new LlmAbortedError();
    persistScopedTurn(repository.path, thread?.id, content, result.reply);
    const journal = new Journal(repository.path, repository.index.repositoryId);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "practice_chat"
    }, thread?.id);
    journal.append("turn_text", turnTextPayload("practice_chat", content, result.reply), thread?.id);
    for (const delta of chunk(result.reply, 72)) send({ type: "delta", delta });
    send({ type: "done", reply: result.reply, provider: result.provider });
  } catch (error) {
    if (turnHandle.signal?.aborted) {
      new Journal(repository.path, repository.index.repositoryId).append("turn_aborted", { scene: "practice_chat", turn_id: turnHandle.turnId ?? "unregistered", aborted_by: "user_stop" }, thread?.id);
      send({ type: "aborted", scene: "practice_chat" });
    } else {
      send({ type: "error", error: error instanceof Error ? error.message : "LLM 对话失败" });
    }
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
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
  // 会话即线程：id 由 createSession 生成后原样落库，GUI 存的就是这个 id
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scope: "teach", id: session.id, courseNodeId: node.id, title: node.title });
  saveThreadState(repository.path, session.id, { stage: session.stage, fallbackCount: session.fallbackCount, settings: session.settings });
  teachingStates.set(session.id, session);
  const journal = new Journal(repository.path, repository.index.repositoryId);
  journal.append("session_created", threadJournalPayload(thread, "created"), session.id);
  journal.append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "session_created" }, session.id);
  return reply.code(201).send({ session, recommendedSettings: learnerProfile.recommended, faded: learnerProfile.fadedByUnit[node.id] ?? learnerProfile.faded, policy: policyFor(session.settings), context: assembleContext({ node, policy: policyFor(session.settings), history: [], repositoryPath: repository.path, analysis: repository.analysis }) });
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  const session = resolveTeachingState(request.params.sessionId);
  return session ?? reply.code(404).send({ error: "会话不存在" });
});

/** 该课程节点最近一次教学会话的 id（查 chat_session）：GUI 刷新后即使本地没存过 id，也能找回存量历史。 */
app.get<{ Params: { repositoryId: string }; Querystring: { nodeId?: string } }>("/api/repositories/:repositoryId/latest-session", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库未挂载" });
  const nodeId = request.query.nodeId ?? "";
  return { sessionId: nodeId ? latestThreadForNode(repository.path, repository.index.repositoryId, nodeId)?.id ?? null : null };
});

/**
  会话线程管理（三作用域共用，作用域是 `teach | map | practice`）。

  线程 id 由**引擎**发（`createThread` 里的 UUID），GUI 只持有与回传——这是「上下文≠选中项」那一轮的同一条纪律：
  凡是要进模型上下文的东西都得能在库里考据到，客户端临时拼的窗口正文不算。
  `map` / `practice` 的对话正文靠这些线程累积，服务端在流式回合里自己取历史、自己落正文。
  */
function locateThread(threadId: string): { repository: NonNullable<ReturnType<typeof repositoryOr404>>; thread: ChatThread } | undefined {
  for (const repository of importer.mountedRepositories()) {
    const thread = getThread(repository.path, threadId);
    if (thread) return { repository, thread };
  }
  return undefined;
}

function threadJournalPayload(thread: ChatThread, reason: string): Record<string, string | null> {
  return { scope: thread.scope, thread_id: thread.id, node_id: thread.courseNodeId ?? null, exercise_id: thread.exerciseId ?? null, reason };
}

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
  return { thread: located.thread, messages: readMessages(located.repository.path, located.thread.id) };
});

app.patch<{ Params: { threadId: string }; Body: { title?: unknown } }>("/api/threads/:threadId", async (request, reply) => {
  const located = locateThread(request.params.threadId);
  if (!located) return reply.code(404).send({ error: "会话不存在或已删除。" });
  const title = typeof request.body?.title === "string" ? request.body.title : "";
  if (!title.trim()) return reply.code(400).send({ error: "标题不能为空" });
  const thread = renameThread(located.repository.path, located.thread.id, title);
  return thread ? { thread } : reply.code(404).send({ error: "会话不存在或已删除。" });
});

/**
  软删：chat_session 打时间戳，chat_message 原文一行不动，journal 追加一条 session_deleted（不删任何既有事件行）。
  同时从内存 Map 摘掉教学会话——否则删掉的会话还能被同进程继续聊，重启后又消失，行为会分成两段。
  */
app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
  const located = locateThread(request.params.threadId);
  if (!located || !softDeleteThread(located.repository.path, located.thread.id)) return reply.code(404).send({ error: "会话不存在或已删除。" });
  teachingStates.delete(located.thread.id);
  new Journal(located.repository.path, located.repository.index.repositoryId).append("session_deleted", threadJournalPayload(located.thread, "user_deleted"), located.thread.id);
  return { deleted: true, threadId: located.thread.id };
});

app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; style?: unknown; turnId?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const current = resolveTeachingState(request.params.sessionId);
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
  // 与 map/practice 同款 SSE：过程提示 + delta 回放并入本请求的响应流，不再走全局广播（事件天然按请求隔离，连接断开自动清理）
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: unknown): void => {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const turnHandle = beginTurn(request.body?.turnId, "teach");
  try {
    const outcome = await respondWithProvider(session, node, request.body.content.trim(), currentCost.mode === "degraded" ? undefined : teachingProvider, faded, repository.path, {
      classifier: actionLoopEnabled ? undefined : (currentCost.mode === "degraded" ? undefined : lightLlmProvider),
      actionLoop: actionLoopEnabled,
      analysis: repository.analysis,
      search: searchCorpusFor(repository),
      onProgress: (progress) => send({ type: "progress", payload: progress }),
      ...(turnHandle.signal ? { signal: turnHandle.signal } : {})
    });
    // 中止可能赶在最后一趟 LLM 返回之后才到：那时没人抛错，这一轮会照常走到落库。
    // 用户点了停止就按「作废」收尾——不落库、不回放，否则 GUI 那句「这一轮没有落库」成了假话，
    // 下次进会话还会冒出一条自己掐掉的回复。断线（没点停止）才是另一条路：照常算完并落库，等着补账。
    if (turnHandle.signal?.aborted) throw new LlmAbortedError();
    teachingStates.set(outcome.session.id, outcome.session);
    // 回合正文 + 状态快照落库：GUI 重启后接着聊、以及 run-trace 之外的「这一轮停在哪」都从这里取
    persistTeachingTurn(repository.path, repository.index.repositoryId, node.id, node.title, outcome.session.id, [
      { role: "user", content: request.body.content.trim() },
      { role: "assistant", content: outcome.assistant.content, ...(outcome.assistant.stage ? { stage: outcome.assistant.stage } : {}) }
    ], { stage: outcome.session.stage, fallbackCount: outcome.session.fallbackCount, settings: outcome.session.settings });
    const journal = new Journal(repository.path, repository.index.repositoryId);
    if (styleChanged) journal.append("style_shift", { style: settings.style, pedagogy: settings.pedagogy, depth: settings.depth, trigger: "manual" }, session.id);
    if (outcome.actionSource === "vetoed") journal.append("action_veto", { unit_id: node.id, proposed: outcome.proposedAction ?? "unknown", enforced: outcome.action ?? "unknown", stage: outcome.session.stage }, session.id);
    journal.append("hint_depth", { unit_id: node.id, depth: outcome.hintDepth, stage: outcome.session.stage, fallback_count: outcome.session.fallbackCount, resolved_by: outcome.event === "dependency" ? "answer_circuit_breaker" : "learner_attempt" }, session.id);
    if (outcome.event === "dependency") journal.append("dependency_event", { unit_id: node.id, after_attempts: 2, reason: "two_consecutive_step_downs" }, session.id);
    if (outcome.event === "confirmation") journal.append("unit_mastered", { unit_id: node.id, method: "source_backed_explanation" }, session.id);
    journal.append("token_usage", { input_tokens: outcome.usage?.inputTokens ?? Math.ceil(request.body.content.length / 4), output_tokens: outcome.usage?.outputTokens ?? Math.ceil(outcome.assistant.content.length / 4), cache_hit_tokens: outcome.usage?.promptCacheHitTokens ?? null, provider: outcome.provider ?? "local-heuristic-v1", scene: "teach", intent_source: outcome.intentSource ?? "regex", action_source: outcome.actionSource ?? "deterministic" }, session.id);
    // 回合文本落盘（B 档第 2/3 刀的被测输入）：问题+回复双边，各截 2000 字并留痕；降级轮也记（裁判要看到「这一轮没走 LLM」的成品）
    journal.append("turn_text", turnTextPayload("teach", request.body.content.trim(), outcome.assistant.content), session.id);
    // 教学回合的 read_file 审计：与宏观设计作用域同一事件类型；同路径重复读取归并为一条
    for (const read of dedupeFileReads(outcome.fileReads ?? [])) {
      journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, error: read.error ?? null }, session.id);
    }
    for (const search of outcome.codeSearches ?? []) {
      journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、") }, session.id);
    }
    // 回合决策摘要：提议动作 → 守门裁决 → 实际执行 + 工具轮次（run-trace 按 traceId 串起整回合的原始素材）
    journal.append("loop_round", { scene: "teach", decision: outcome.actionSource ?? "deterministic", proposed: outcome.proposedAction ?? null, executed: outcome.action ?? null, tool_rounds: outcome.toolRounds ?? 0, tool_reads: (outcome.fileReads ?? []).length, tool_searches: (outcome.codeSearches ?? []).length }, session.id);
    const cost = summarizeCost(repository.path, monthlyBudget, session.id);
    if (cost.mode === "degraded") {
      journal.append("token_usage", { input_tokens: 0, output_tokens: 0, provider: outcome.provider ?? "local-heuristic-v1", scene: "teach", mode: "degraded", cause: "monthly_budget_reached" }, session.id);
      // 降级必须显式留痕：日志里也要能查到「这一轮为什么没走 LLM」
      traceEngine("degrade", { scope: "teaching", cause: "monthly_budget_reached", session: session.id });
    }
    for (const delta of chunk(outcome.assistant.content, 72)) send({ type: "delta", delta });
    send({ type: "done", session: outcome.session, message: outcome.assistant, policy: policyFor(settings), cost, provider: outcome.provider ?? "local-heuristic-v1" });
  } catch (error) {
    if (turnHandle.signal?.aborted) {
      // 用户点了停止：这一轮没有成品。不伪造 assistant 正文、不写 turn_text，只留一条中止痕迹
      new Journal(repository.path, repository.index.repositoryId).append("turn_aborted", { scene: "teach", turn_id: turnHandle.turnId ?? "unregistered", aborted_by: "user_stop" }, session.id);
      send({ type: "aborted", scene: "teach" });
    } else {
      send({ type: "error", error: error instanceof Error ? error.message : "教学回合失败" });
    }
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});

/**
  UI 动作事件出口（设计文档第 8 章 PRINCIPLE 03「可观测」）：
  每一次切节点、打开文件、切换模块、提交练习都必须有 journal 事件可查——缺事件的 UI 操作是设计漏洞。

  契约要点：
  - 白名单与 `Journal.append` **共用**（`isJournalEventType`），不另立一份，避免两处漂移。
  - `payload` 仅允许标量（`string | number | boolean | null`）：结构化对象会随版本漂移。
  - `sessionId` **不做存在性校验**（只校验是字符串且有长度上限）：journal 是 append-only 事件流，
    sessionId 是关联属性而非外键。教学会话虽已能按 sessionId 从 journal 续命恢复（`resolveTeachingState`），
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
// s 标志：`.` 默认不匹配换行，回放会把多行回复的 `\n` 全丢掉（打字机预览塌成一行）；加上后逐块保留换行
function chunk(content: string, width: number): string[] { return content.match(new RegExp(`.{1,${width}}`, "gs")) ?? [content]; }

const port = Number(process.env.ENGINE_PORT ?? 3001);
await app.listen({ port, host: "127.0.0.1" });
tboot("listening");
