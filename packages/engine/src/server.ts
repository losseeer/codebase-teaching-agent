import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as _perf } from "node:perf_hooks";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { SUPPORTED_EXERCISE_KINDS } from "@codebase-tutor/shared";
import type { ChatScope, ChatThread, CourseNode, Exercise, ExerciseAnswer, ExerciseKind, FlowStage, JournalEvent, ServerEvent, TutorMessage, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { budgetGateNotice, currentPricing, defaultMonthlyBudgetUsd, pricingSourceOf, summarizeCost } from "./cost/cost.js";
import { courseChildren, courseOverview, findCourseNode } from "./coursetree/projection.js";
import { suggestModuleEntriesCached } from "./coursetree/entry-suggest.js";
import type { ImportedRepository } from "./importer/importer.js";
import { architectureInputOf, generateArchitectureCached, moduleCourseOf, peekCachedArchitecture } from "./coursetree/architecture.js";
import { commitOverride, parseOverrideArguments, type OverrideIntent, type OverrideVia } from "./coursetree/override-writer.js";
import type { ArchitectureToolContext } from "./source/tool-loop.js";
import { impactRadius, graphFromData } from "./depgraph/graph.js";
import { languageProfileOf } from "./depgraph/language-profile.js";
import { formatSeamReport, seamReportFor } from "./depgraph/seams.js";
import { fileStructureOf } from "./depgraph/roles.js";
import { ExerciseService } from "./exercises/exercises.js";
import { degradedFlow, generateRepositoryFlowCached, resolveFlowEntry } from "./flows/flow.js";
import { respondWithProvider, createSession } from "./harness/harness.js";
import { assembleContext } from "./harness/context.js";
import { ImportService } from "./importer/importer.js";
import { indexRepository } from "./indexer/indexer.js";
import { catalogRepositoryId, id, isWithin, turnTextPayload } from "./lib.js";
import { loadDotEnv } from "./config/dotenv.js";
import { defaultTutorSettings, policyFor, validateSettings, validateStyle } from "./tutor-settings/tutor-settings.js";
import { createSummaryProvider, LocalSummaryProvider } from "./summarizer/summary-provider.js";
import { summarizeFiles } from "./summarizer/summarizer.js";
import { LATEST_SUMMARY_LIMIT, TutorDatabase } from "./store/database.js";
import { overlayCounts, patchOverlays, readOverlays, removeOverlayKeys, type OverlaysPatch } from "./store/overlays.js";
import { Journal, isEngineOwnedEventType, isUiJournalEventType, readJournal } from "./store/journal.js";
import { isTrustedOrigin } from "./security/origins.js";
import { isolationStatus, reprobeIsolation } from "./sandbox/isolation.js";
import { appendMessages, createThread, getThread, isChatScope, latestThreadForNode, listThreads, readMessages, readThreadState, renameThread, saveThreadState, softDeleteThread, type NewMessage, type TeachingThreadState } from "./store/chat-store.js";
import { markThread, runWithTrace } from "./trace/context.js";
import { traceEngine } from "./trace/engine-log.js";
import { abortTurn, beginTurn, type TurnHandle, type TurnScene } from "./turns/registry.js";
import { dedupeFileReads, pathReadBlock } from "./source/read-file.js";
import { buildSearchCorpus, type SearchCorpus } from "./source/search-code.js";
import type { CrossRepoContext } from "./source/tool-loop.js";
import { checkTurnInvariants, invariantTailNotice, screenNotice, screenReply } from "./eval/scorers.js";
import { deriveLearnerProfile } from "./learner/model.js";
import { LlmAbortedError, resolveLlmConfig, teachingProviderStatus, type LlmProvider } from "./llm/provider.js";
import { isThinkingEffortSupported, resolveThinkingCapability, supportedThinkingEfforts } from "./llm/thinking.js";
import { buildLlmRuntimeProvider, effectiveLlmConfig, getLlmRuntimeSettings, LLM_PROVIDERS, normalizeRate, PRICING_KEYS, publicLlmSettings, restoreLlmRuntimeSettings, setLlmRuntimeSettings, THINKING_EFFORTS } from "./llm/runtime.js";
import { mapChat, practiceChat, type MapChatProgress, type ScopedChatResult, type ScopedChatTurn } from "./scopechat/scopechat.js";

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

/** 导出只为给路由级测试用 `app.inject()`（见 server-routes.test.ts）；产品路径仍然是本文件自己 listen。 */
export const app = Fastify({
  // traceId 即 reqId：pino 的请求行、本进程记的 trace 事件、llm.log 与 journal 共享同一个 id
  genReqId: () => id(),
  logger: { level: process.env.LOG_LEVEL ?? "warn" }
});
// CORS 必须先于认证钩子注册：钩子按注册顺序跑，认证若是第一个，401 就会被它短路——
// 跨来源部署时那个响应**没有 access-control-allow-origin**，浏览器里只剩一句「网络错误」，
// 用户看不到引擎说的那句中文原因（本机 vite 代理下同源，才看不出这个顺序问题）。
// 来源不再反射任意值：只有可信来源才给 `access-control-allow-origin`（判据一处：`security/origins.ts`）。
// 旧写法 `{ origin: true }` 等于对浏览器说「谁来的都给你读」，而引擎只听 127.0.0.1——
// 本机任意网页照样能把请求打过来，缺的只是读响应这一步，而它正好被这行补上。
await app.register(cors, { origin: (origin, callback) => callback(null, Boolean(origin && isTrustedOrigin(origin))) });
tboot("cors registered");
// 请求级 trace 上下文：`run(id, done)` 让后续钩子与 handler 继承该 store（传播原理见 trace/context.ts）
app.addHook("onRequest", (request, _reply, done) => { runWithTrace(request.id, done); });

/**
  来源闸：不可信的 `Origin` 当场 403，**handler 一行都不执行**。
  光靠 CORS 不给回头只挡住「浏览器读到响应」，服务端该干的活照样干了（写类路由会把状态改掉）；
  这一道把它挪到执行之前。预检交给 CORS 插件——非可信来源拿不到回头的预检响应，实际请求根本到不了这儿。
  ⚠️ 这一道**不豁免 `/api/health`**：健康读数里有服务商、模型名与沙箱闸门状态——那是给下一步攻击踩点用的，
  别让任意网页白拿。（2026-10-15 之前这里有两条同义钩子，一条豁免 health、一条不豁免，
  实际生效的是「不豁免」那条而文案来自另一条——同一条判据抄两遍迟早分叉，现收成一处。）
  认证闸（API key / 按仓 ACL）同日整体撤除，理由与保留边界见开发日志 §64；
  这一道只管「浏览器里哪个页面能碰这台引擎」，**本机进程不在它的管辖范围内**。
  */
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (!origin || request.method === "OPTIONS" || isTrustedOrigin(origin)) return;
  return reply.code(403).send({ error: `来源「${origin}」不在可信清单里：引擎默认只服务本机浏览器（回环来源）。跨来源部署请把该来源写进 TUTOR_ALLOWED_ORIGINS。`, reason: "origin_not_trusted" });
});

app.addHook("onResponse", (request, reply, done) => {
  traceEngine("http", { method: request.method, url: request.url, status: reply.statusCode }, { traceId: request.id, durationMs: Math.round(reply.elapsedTime) });
  done();
});
tboot("Fastify constructed");

const importer = new ImportService();
// 启动**只读地址簿**（一串路径），一条产物都不读、一个 fs 监听都不开：
// 挂载推迟到 GUI 真的访问某个仓库时（见 preHandler 懒挂载），超出的按 LRU 驱逐。
tboot(`ImportService（地址簿 ${importer.catalog().length} 条，挂载 0 条）`);

/**
  关停钩子只管 fs 监听这一件事：LRU 驱逐与 `forget` 各自会关自己那条，但 `app.close()` 不会。
  `fs.FSWatcher` 是活跃 handle——不摘掉就是「HTTP 已经关了、监听还替引擎抱着一个目录」，
  路由级测试收尾删掉临时仓后正是这种状态（handle 指向一个已不存在的目录）。
  */
app.addHook("onClose", async () => { for (const repository of importer.mountedRepositories()) repository.watcher?.close(); });

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


/**
  全局事件流的订阅者（GET /api/events）：导入进度这类「无请求边界的推送」走这里；对话回放走各自请求的 SSE 响应流。
  一路订阅连着它的**身份**一起存：这条流是常开连接，onRequest 那道按 URL 判的 ACL 够不到后来的每一帧。
  */
const subscribers = new Set<{ send: (event: ServerEvent) => void; request: FastifyRequest }>();

/** 事件流心跳间隔：25s 卡在常见反向代理 60s 空闲超时之内，又是浏览器完全无感的一档。 */
const EVENT_STREAM_PING_MS = 25_000;

/**
  广播：某一路订阅者写不进去（它的连接刚被掐掉）是它自己那一路的事，摘掉就好。
  这里必须兜住异常——`broadcast` 挂在 `importer.emit("event")` 的**同步链**上，
  一路死订阅者抛出的 write 异常会一路冒到 `ImportService.run` 的 catch，把一次已经算完的导入判成 failed。
  删除正在迭代的 Set 元素是安全的（已访问的不动、未访问的跳过）。
  ⚠️ 帧**不按归属过滤**：认证闸撤了之后没有「谁的名单」这个东西可过滤（§64）。
  载荷里带着目标仓的绝对路径与改动文件名，所以这条长连接的可见面等于本机的可见面。
  */
function broadcast(event: ServerEvent): void {
  for (const client of subscribers) {
    try {
      client.send(event);
    } catch {
      subscribers.delete(client);
      traceEngine("degrade", { what: "sse_subscriber_dropped" });
    }
  }
}

/**
  SSE 单帧写出（四处出口共用的一条判据）。
  判 `destroyed` 不只看 `writableEnded`：客户端硬断（关页面、切走）时 `writableEnded` 仍是 false，
  这时 write 会抛——四条出口是一条判据，分开写迟早只改一处（10-06 复审就是这么发现广播会崩导入的）。
  */
function sseFrame(reply: FastifyReply, frame: string): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  reply.raw.write(frame);
}

function sseWriter(reply: FastifyReply): (event: unknown) => void {
  return (event) => sseFrame(reply, `data: ${JSON.stringify(event)}\n\n`);
}

/**
  建立 SSE：写头 + **立刻发一帧注释把响应头推到网路上**。
  只调 `writeHead` 时 Node 把头部留在缓冲区，客户端要等到第一个 `data:` 帧才拿得到响应。
  10-12 实测：空转的 `/api/events` 三秒收到 0 字节——本机直连只是「看起来连着」，
  而共享部署那层反向代理（nginx 默认 `proxy_read_timeout` 60s）会把这种「有连接、零字节」的上游直接掐掉，
  界面就退回「导入进度停在 0%，任务其实跑完了」那一档。
  `:` 开头在 SSE 规范里是注释，任何解析器都跳过；读流循环只认 `data: ` 行，所以这一帧不带语义。

  头里还必须自己带上 CORS：`hijack()` 之后响应不再经 `@fastify/cors` 收尾，
  跨来源部署的浏览器一帧都读不到（与 §47 那个钩子顺序是同一类事故）。
  */
function openSseStream(request: FastifyRequest, reply: FastifyReply): (event: unknown) => void {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {})
  });
  sseFrame(reply, ": open\n\n");
  return sseWriter(reply);
}

/** 打字机回放的块长：三作用域同款，改一处就全改（真 token 流式要 provider 层改造，这里先消除「整段落下」）。 */
const TYPEWRITER_CHUNK = 72;

function replayTypewriter(send: (event: unknown) => void, text: string): void {
  for (const delta of chunk(text, TYPEWRITER_CHUNK)) send({ type: "delta", delta });
}

/**
  开一轮作用域对话流：hijack → 首帧落网 → 登记回合。三处顺序一致，且 `dispose()` 必须留在调用方的 finally 里——
  漏一处就是往回合登记表里塞一个永不摘除的在途条目，之后「停止生成」按名字也掐不到它。
*/
function beginScopedStream(request: FastifyRequest, reply: FastifyReply, scene: TurnScene, turnId: unknown): { send: (event: unknown) => void; turnHandle: TurnHandle } {
  reply.hijack();
  return { send: openSseStream(request, reply), turnHandle: beginTurn(turnId, scene) };
}

/**
  回合失败的收尾（三作用域同一口径）：中止与出错是两件事，先判中止——只有它带着登记过的 turnId，
  出错分支什么都不知道。用户点了停止就按「作废」收：journal 留一条 `turn_aborted`、不伪造正文也不写 `turn_text`。
*/
function failScopedTurn(input: {
  send: (event: unknown) => void;
  repositoryPath: string;
  repositoryId: string;
  scene: TurnScene;
  turnHandle: TurnHandle;
  threadId?: string;
  error: unknown;
  fallbackError: string;
}): void {
  if (!input.turnHandle.signal?.aborted) {
    input.send({ type: "error", error: input.error instanceof Error ? input.error.message : input.fallbackError });
    return;
  }
  new Journal(input.repositoryPath, input.repositoryId).append("turn_aborted", { scene: input.scene, turn_id: input.turnHandle.turnId ?? "unregistered", aborted_by: "user_stop" }, input.threadId);
  input.send({ type: "aborted", scene: input.scene });
}

function repositoryOr404(repositoryId: string) {
  return importer.getRepository(repositoryId);
}

/**
  懒挂载钩子：`/api/repositories/:repositoryId/*` 的每个请求先确保该仓已挂进内存。
  引擎启动时不读任何产物，所以「GUI 切回上周那个仓」的第一次请求才去读它的 `.tutor`、开它的监听——
  用户感知是一次稍慢的点击，换来的是 boot 零 IO、零 watcher，以及地址簿里剩下的几十条完全不占资源。

  挂载失败按原因回 404 + `reason`：GUI 要靠它分清「工作区确实失效（清掉）」与
  「目录挪走了/产物不全（留着让用户处置）」。**任何一支都不会触发重新分析**——重跑是花钱动作，只由用户点头。

  唯一豁免是移出地址簿那条 DELETE：它要处理的恰恰是「挂不起来的仓」，钩子若先拦它，用户就被锁在自己的地址簿外面。
  */
app.addHook("preHandler", async (request, reply) => {
  const repositoryId = (request.params as { repositoryId?: unknown })?.repositoryId;
  if (typeof repositoryId !== "string" || !repositoryId) return;
  if (request.method === "DELETE" && request.routeOptions?.url === "/api/repositories/:repositoryId") return;
  const result = importer.ensureMounted(repositoryId);
  if (result.ok) return;
  return reply.code(404).send({ error: result.message, reason: result.reason });
});

/** 地址簿清单（不读产物）：GUI 的仓库切换器数据源。 */
app.get("/api/repositories", async () => ({ repositories: importer.catalog() }));

/** 显式挂载一个仓库并回报新鲜度：GUI 切换仓库时调它，好把「这是三天前的分析」说在打开之前。 */
app.post<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/mount", async (request, reply) => {
  const result = importer.ensureMounted(request.params.repositoryId);
  if (!result.ok) return reply.code(404).send({ error: result.message, reason: result.reason });
  return { repositoryId: result.repository.index.repositoryId, repositoryPath: result.repository.path, freshness: result.repository.freshness };
});

/** 把某仓移出地址簿（并就地卸载）。只动引擎的注册表，不碰仓库里的 `.tutor/`。 */
app.delete<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId", async (request) => {
  importer.forget(request.params.repositoryId);
  return { repositories: importer.catalog() };
});

/**
  编辑期免打扰：按仓挂起 / 恢复 fs 增量监听。存在的理由很具体——**引擎在学它自己的仓**，
  改代码的人与被打扰的学习者是同一个进程里的两件事：一轮编辑会叫醒一次重分析并烧 light 调用
  （10-15 实测一次 8 条，金额按当天单价约 ¥0.4）。

  三条口径：
  - 挂起**不丢东西**：产物与内存照用，只是磁盘改动不再自动重分析；恢复时重算一次新鲜度，
    脏了由界面横幅如实说，要不要重烧仍由人点（引擎绝不自动重分析这条纪律不变）。
  - 挂起活过驱逐与重新挂载：登记在 `ImportService` 里，LRU 把仓挤出去再点回来时开关仍然有效。
  - 到点自动恢复（缺省 30 分钟，限死在 1 分钟~6 小时）：一个忘在手上的开关不该永久关掉增量更新。
  */
app.post<{ Params: { repositoryId: string }; Body: { paused?: unknown; ttlMs?: unknown } }>("/api/repositories/:repositoryId/watch", async (request) => {
  // 不需要在这里再判一次「仓在不在」：URL 带 `:repositoryId` 的路由都由懒挂载钩子先把仓挂上，
  // 地址簿里没有 / 目录没了 / 产物不全在那一步就已经 404 了（reason=not_in_catalog 等）。
  const repositoryId = request.params.repositoryId;
  const paused = request.body?.paused !== false; // 缺省 = 挂起（这条路由是来关监听的，不是来问状态的）
  const ttlMs = typeof request.body?.ttlMs === "number" ? request.body.ttlMs : undefined;
  if (!paused) return { repositoryId, paused: false, woken: importer.resumeWatching(repositoryId).woken, watching: importer.getRepository(repositoryId)?.watch ?? null };
  const result = importer.pauseWatching(repositoryId, ttlMs);
  return { repositoryId, paused: true, until: new Date(result.until).toISOString(), watching: false };
});

/**
  重跑一次沙箱隔离探测。存在的理由：探测失败会把代码题整域禁用（fail-closed，这是对的），
  但**恢复不能只有「重启引擎」这一条路**——换完 Xcode 命令行工具、补好 `sandbox-exec`、
  或者从受限 CI 回到本机之后，人应该能当场让它再验一遍（§64 之前记的 #164）。
  这项能力不降级：`level !== "enforced"` 时代码题域照旧禁用，这里只负责给出新的实测读数。
  */
app.post("/api/sandbox/reprobe", async () => {
  const sandbox = await reprobeIsolation();
  console.log(`[engine] 沙箱重探：${sandbox.level === "enforced" ? `强制隔离已验（${sandbox.checks.length} 项 canary 全过 · ${sandbox.backend} · ${sandbox.durationMs}ms）` : `**未通过——代码题域继续禁用**：${sandbox.reason}`}`);
  return { sandbox };
});

/** 每仓可持久化的设置形态（settings_json 里的一个子集；refinement 标记等内部键不在此列、读写都须保留）。 */
interface RepositorySettingsPayload {
  monthlyBudgetUsd: number;
  summaryHeaderComments: boolean;
}

function readRepositorySettings(repositoryPath: string, repositoryId: string): RepositorySettingsPayload {
  // close 走 finally：这个 helper 挂在每个请求的读路径上，中途抛错就是每请求漏一个 SQLite 句柄
  const database = new TutorDatabase(repositoryPath);
  try {
    const settings = database.getSettings<{ monthlyBudgetUsd?: number; summaryHeaderComments?: boolean }>(repositoryId);
    return {
      monthlyBudgetUsd: typeof settings?.monthlyBudgetUsd === "number" && settings.monthlyBudgetUsd >= 0 ? settings.monthlyBudgetUsd : defaultMonthlyBudgetUsd,
      summaryHeaderComments: settings?.summaryHeaderComments === true
    };
  } finally {
    database.close();
  }
}

/**
  付费分支的统一闸门口径：`mode === "degraded"` 就传 `undefined` provider（八处消费方同一判据，别各写一遍）。
  单价没配时这里恒为 false——那是闸门失效，不是「还剩很多额度」，读数见 `budgetGateNotice` 与启动那条 degrade。
  `monthlyBudgetUsd` 一起交出去：教学回合收尾还要按**同一份**预算算本会话成本，再读一次设置就是第二份口径。
  */
function budgetGate(repositoryPath: string, repositoryId: string): { monthlyBudgetUsd: number; degraded: boolean } {
  const monthlyBudgetUsd = readRepositorySettings(repositoryPath, repositoryId).monthlyBudgetUsd;
  return { monthlyBudgetUsd, degraded: summarizeCost(repositoryPath, monthlyBudgetUsd).mode === "degraded" };
}

function budgetDegraded(repositoryPath: string, repositoryId: string): boolean {
  return budgetGate(repositoryPath, repositoryId).degraded;
}

/** L1 摘要表 → `path → 一句话职责`（流程证据、search 语料、推荐入口共用）。 */
function latestFileSummaries(repositoryPath: string): Map<string, string> {
  const database = new TutorDatabase(repositoryPath);
  try {
    // 触顶不是静默少文件：缺口要在日志里点名（上限本身只有一份定义，在 store/database.ts）
    const rows = database.getLatestFileSummaries(LATEST_SUMMARY_LIMIT);
    if (rows.length >= LATEST_SUMMARY_LIMIT) console.warn(`[engine] ${repositoryPath} 的摘要行数达到读取上限 ${LATEST_SUMMARY_LIMIT}，超出的旧路径本次没有摘要可用（流程证据与检索语料会缺这些文件）`);
    return new Map(rows.map((row) => [row.path, row.summary]));
  } finally {
    database.close();
  }
}

/** search_code 语料：已分析路径 + 图符号表 + L1 一句话职责。
    coverageLow 不再扣用（09-22 拍板）：anchor-v2 判低的残余只是「纯中文行为描述、没复述符号名」，
    扣掉等于把职责线索也丢出语料；判据保留为 metrics 读数。
    每次请求现建：纯 CPU 毫秒级、且永远跟随最新一次导入的产物，不值得也没有失效语义可缓存。 */
function searchCorpusFor(repository: NonNullable<ReturnType<typeof repositoryOr404>>): SearchCorpus {
  return buildSearchCorpus(repository.index, repository.analysis, latestFileSummaries(repository.path));
}

/**
  跨仓访问上下文——**界面上没有「跨仓」这个入口了**（原来那条接缝面板删了），跨仓只经由 agent 的
  `read_file(repo=)` / `search_code(repo=)` / `cross_repo_link` 三个工具发生：用户问「点了这个按钮之后代码在哪」，
  由模型自己去对端拿证据。三条口径：
  - **只有地址簿里真有第二个仓时才回东西**。没有对端时工具清单逐字不变（多一个 schema 字段就是每轮白付 token，
    还会诱使模型去猜不存在的对端）。
  - **对端按需挂载**：`corpusOf` / `links` 里才 `ensureMounted`，模型不开口就不读第二个仓的产物。
    挂载会占 LRU 名额（可能把当前仓挤出去），但当前这一回合握的是内存引用，不受影响。
  - **守卫不另起一套**：跨仓读走的是同一个 `executeReadFile(根, …)`，所以仓内边界、拒读名单、软链接复核
    在对端仓上一样成立——这一条是这套能力唯一的安全边界。
  - **边界只有一层，就是仓内边界**：跨仓读走的是同一个 `executeReadFile(根, …)`，所以仓内边界、拒读名单、软链接复核
    在对端仓上一样成立。地址簿里有的仓就对模型全部可见（认证闸撤了之后没有「名单外」这一档，§64）。
  */
function crossRepoFor(repository: NonNullable<ReturnType<typeof repositoryOr404>>, handedOut: Map<string, number>): CrossRepoContext | undefined {
  const targets = new Map<string, { id: string; path: string }>();
  for (const entry of importer.catalog()) {
    if (entry.repositoryId === repository.index.repositoryId || !entry.exists) continue;
    // 两个仓可能同名（都叫 backend）：撞名就给 id 前缀，否则模型报了名字我们不知道选哪个
    const name = targets.has(entry.name) ? `${entry.name}#${entry.repositoryId.slice(0, 6)}` : entry.name;
    targets.set(name, { id: entry.repositoryId, path: entry.repositoryPath });
  }
  if (!targets.size) return undefined;
  const mount = (name: string) => {
    const target = targets.get(name);
    if (!target) return undefined;
    const mounted = importer.ensureMounted(target.id);
    return mounted.ok ? mounted.repository : undefined;
  };
  const view = (item: NonNullable<ReturnType<typeof repositoryOr404>>) => ({ repositoryId: item.index.repositoryId, path: item.path, files: item.index.files, versionStamp: item.analysis.versionStamp });
  const register = (item: NonNullable<ReturnType<typeof repositoryOr404>>, path: string) => { handedOut.set(path, item.index.files.find((file) => file.path === path)?.lines ?? 1); };
  return {
    roots: Object.fromEntries([...targets].map(([name, target]) => [name, target.path])),
    corpusOf: (name) => { const other = mount(name); return other ? searchCorpusFor(other) : undefined; },
    links: (name, filter) => {
      const other = mount(name);
      if (!other) return targets.has(name) ? `仓「${name}」挂不起来（目录被挪走或 .tutor 产物不全），这次给不出跨仓落点。` : `未知仓库「${name}」；可配对的其他仓：${[...targets.keys()].join(" / ")}。`;
      const report = seamReportFor(view(repository), view(other));
      // 递给模型的每一行落点都登记下来：回合收尾的复检要认它，否则「引擎自己给的对端行号」会被判成编造
      for (const link of report.outbound.links) register(other, link.provider.path);
      for (const link of report.inbound.links) register(other, link.consumer.path);
      // 这是一次读了两个仓源码的动作：配上几条、跟谁配的必须可查（面板时代靠这条路由留痕，现在由工具留）
      new Journal(repository.path, repository.index.repositoryId).append("repository_paired", { other_repository_id: other.index.repositoryId, outbound: report.outbound.matched, inbound: report.inbound.matched, via: "tool" });
      return formatSeamReport(name, report, filter);
    },
    maxCrossReads: 2,
    onHandedOut: (name, path) => { const other = mount(name); if (other) register(other, path); }
  };
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
  窗口大小就是下面这两个字面量（6 / 8）——**这里才是选行的地方**。scopechat 的
  `HISTORY_TURNS` / `EARLIER_QUESTIONS_MAX` 只在那一侧做渲染期再裁剪，对这里交出去的条数是恒等操作，
  所以调窗口要改本函数，只改那边不会跟着变（逐行截断确实只在那边）。

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
    // 摘要档由真源工厂报出：直接读 TUTOR_SUMMARY_PROVIDER 会把「没设环境变量 = 走轻量档」说成 "local"，
    // 而 .env 里那行空值会让这个字段回成空串——健康页的读数不能反过来骗人
    summaryProvider: createSummaryProvider({ llm: lightLlmProvider }).name,
    llmProvider: llm.provider, llmModel: llm.model, llmMode: llm.mode,
    thinking: getLlmRuntimeSettings().thinking,
    // 沙箱闸门状态原样给出（含逐项 canary 读数）：代码题能不能出，看这一格，不看界面自己猜
    sandbox: isolationStatus()
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
    /**
      单价的「现在生效值 + 每一档从哪来」：界面上留空那格显示的是 .env 的数，
      不说清来源就会变成「我明明填了 0.28 怎么还显示 0」这类无从自查的读数。
      */
    pricing: currentPricing(),
    pricingSources: { input: pricingSourceOf("input"), output: pricingSourceOf("output"), cacheHit: pricingSourceOf("cacheHit") },
    activeModel: active.model,
    activeProvider: active.provider,
    activeMode: active.mode,
    // 能力按「实际生效的模型 slug」解析（运行时覆盖优先，回落 .env），与 provider 工厂同一套解析
    thinkingCapability: describeThinking(effectiveLlmConfig().model)
  };
}

/**
  GUI 运行时 LLM 设置：读取（含 .env 回落值、预设模型清单与生效模型的思考能力声明）。
  这一份配置是**全局**的（服务商/端点/密钥影响每一次出境），所以它是管理面——
  认证闸撤了之后，「谁能改端点」这件事完全落在来源闸与本机文件权限上（§64）。
  */
app.get("/api/llm/settings", async () => llmSettingsPayload());

/** GUI 运行时 LLM 设置：更新服务商/模型/端点/密钥/思考档位/单价，立即重建 provider 并落盘（留空 = 回落 .env） */
app.put<{ Body: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; thinking?: string; inputUsdPerMillion?: string; outputUsdPerMillion?: string; cacheHitUsdPerMillion?: string } }>("/api/llm/settings", async (request, reply) => {
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

  /**
    单价三档：留空 = 该项回落 .env，非负数才收。这里必须当场拒绝而不是「存下来再说」——
    这两个值会一路流进成本读数**和预算闸门**（`currentPricing()`），一个 "-3" 或 "abc" 存进去，
    算出的就是负钱或 NaN，而闸门按「钱 ≥ 预算」判断，NaN 恒为 false ⇒ 静默变成「永不超支」。
    判据与落盘恢复共用 `normalizeRate`，不各写一份。
    */
  const PRICING_LABELS: Record<(typeof PRICING_KEYS)[number], string> = {
    inputUsdPerMillion: "输入单价",
    outputUsdPerMillion: "输出单价",
    cacheHitUsdPerMillion: "缓存命中单价"
  };
  const pricingPatch: Partial<Record<(typeof PRICING_KEYS)[number], string>> = {};
  for (const key of PRICING_KEYS) {
    const raw = body[key];
    if (raw === undefined) continue;
    const normalized = normalizeRate(raw);
    if (normalized === undefined) return reply.code(422).send({ error: `${PRICING_LABELS[key]}得是不小于 0 的数字（人民币 / 百万 token），留空表示用 .env 的值`, reason: "pricing_invalid" });
    pricingPatch[key] = normalized;
  }

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
    ...pricingPatch,
    thinking: body.thinking as never
  });
  teachingProvider = buildLlmRuntimeProvider("teaching");
  lightLlmProvider = buildLlmRuntimeProvider("light");
  // 响应带生效状态与能力声明：GUI 换模型/换服务商后无需再 GET 一次即可刷新思考档位的可用状态。
  // 换到「缺密钥」的组合时建不出 provider（activeMode=local），这不算请求失败——把状态如实回给 GUI。
  return llmSettingsPayload();
});

app.get("/api/events", async (request, reply) => {
  // 全局推送流（导入进度这类无请求边界的推送）；对话回放走各自请求的 SSE 响应流。
  // 断线重连由前端 `subscribeServerEvents` 自己管（fetch 读流才能带口令头，见 §47）。
  reply.hijack();
  const client = { send: openSseStream(request, reply), request };
  subscribers.add(client);
  // 心跳：这条例外是「订阅之后可能永远没有第一个事件」——没人导入、没人改仓时连接整天空着。
  // 注释帧既顶住中间层的空闲超时，也让客户端在下一次广播之前就从写入失败里察觉连接已死。
  const ping = setInterval(() => {
    sseFrame(reply, ": ping\n\n");
  }, EVENT_STREAM_PING_MS);
  reply.raw.on("close", () => {
    clearInterval(ping);
    subscribers.delete(client);
  });
});

app.post<{ Body: { path?: string; summaryHeaderComments?: boolean } }>("/api/imports", async (request, reply) => {
  try { return reply.code(202).send(importer.submit(request.body?.path ?? "", typeof request.body?.summaryHeaderComments === "boolean" ? request.body.summaryHeaderComments : undefined)); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "无法提交导入任务" }); }
});

app.get<{ Params: { jobId: string } }>("/api/imports/:jobId", async (request, reply) => {
  const job = importer.getJob(request.params.jobId);
  if (!job) return reply.code(404).send({ error: "导入任务不存在" });
  return job;
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/index", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository?.index ?? reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/course", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  // 模块分级现算（主干/设施/外围）：角色是结构规则的纯函数，所以已导入的仓库不用重烧就能看到分级
  const courseDatabase = new TutorDatabase(repository.path);
  try {
    return moduleCourseOf(repository.course, repository.analysis, repository.index, readOverlays(courseDatabase, repository.index.repositoryId));
  } finally {
    courseDatabase.close();
  }
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

/**
  仓库分析（架构视图与流程视图的共同数据源）。响应里额外挂一份 `languageProfile`：
  本仓语言分布 + 每语言能力档，来自 shared 的 `LANGUAGE_CAPABILITIES`（引擎自报口径）。

  为什么挂在这条**已存在**的只读路由上，而不是新开一条：
  - 架构视图本来就要取这条路由（`DepMap` 的边来自 `analysis.graph.imports`），「这条边有多硬」
    必须和边本身同时到达，另开一条就会有两份时序与两处加载态；
  - 它是读侧现算的元数据：不进 `repository.analysis`（那是落库产物，也是 `backendStamp` 等缓存键的输入），
    只在响应里浅拷贝一次 —— 因此不会引发任何摘要/流程重烧；
  - 语言分布的输入是 `index.files`（内存里已挂载的索引），不读磁盘、不调模型。

  ⚠️ 一条被实测暴露的缺口（10-05）：**引擎没有「重新分析」这条路由**。挂载只读落库产物并报告新鲜度，
  所以依赖边/调用边/入口这三处规则改了之后，已导入的仓仍然用旧图回答（当时 dianping 落库的还是改前的 316 条边、
  UserServiceImpl 7 条出边），且**没有任何读数会提示这件事**——流程 grounding 的前后对比因此一度不可比。
  现在生效的方式只有两条：重新导入（会重走 L1/润色的缓存判定，理论上命中即零 token，但路径更长）或等文件变动触发 watcher 重分析。
 */
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/analysis", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  return { ...repository.analysis, languageProfile: languageProfileOf(repository.index.files, repository.analysis.graph) };
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
  if (kind && !SUPPORTED_EXERCISE_KINDS.includes(kind)) return reply.code(400).send({ error: "不支持的练习题型" });
  const budgetExceeded = budgetDegraded(repository.path, repository.index.repositoryId);
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
  const budgetExhausted = budgetDegraded(repository.path, repository.index.repositoryId);
  const provider = budgetExhausted ? undefined : lightLlmProvider;
  // 「触顶 vs 未配置」分开说的口径与理由见下面 flow 路由；未配置/触顶/判空/失败的用户处置完全不同，不让界面猜。
  // 措辞按文案纪律压过：正文只留第一句，「清单从哪来、排没排序」这类机制交给悬停说明（GUI 侧拼）
  const fallback = "按模块结构列出文件";
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
      return { entries: [], source: "module_files" as const, reason: `${suggestion.declined ? "没有合格入口，不硬凑" : "模型没给出可用入口"}；${fallback}。` };
    }
    return { entries: suggestion.entries, source: "llm" as const };
  } finally {
    database.close();
  }
});

// 架构视图的分层产物（2026-10-16）：层名与模块归层是判断题（light 档，可人工改），
// 跨层箭头与「边界之外」那一栏是事实题（只由静态 import 与外部包名词典算，模型参与不了一格）。
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/architecture", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  /**
    读侧两件事：**provider 照给**（缓存键里有 modelVersion，不给就退成 "none" ⇒ 判好的那份读不回来，
    画布会静默换成静态三层），但 `allowCall: false` 让它没有缓存行时也不发请求。
    所以这条路由不看预算：预算只管「判一次分层」那一下，不管打开画布。
    */
  const database = new TutorDatabase(repository.path);
  try {
    const overlays = readOverlays(database, repository.index.repositoryId);
    const plan = await generateArchitectureCached({ ...architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays }), provider: lightLlmProvider, allowCall: false });
    // 读侧不可能有用量（allowCall: false 那条分支不发请求），所以这里不写 token_usage：钱只在 regenerate 那一下入账
    return plan;
  } finally {
    database.close();
  }
});

// 显式重问一次分层（**花钱**，走预算闸门）。没配模型或触顶就 422 明说：
// 这条路由的语义是「按模型的判断重来」，静默给一份静态三层等于收了钱不办事还指着图说这是分层架构。
app.post<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/architecture/regenerate", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (budgetDegraded(repository.path, repository.index.repositoryId)) return reply.code(422).send({ error: "本月预算已触顶，未调用模型；判一次分层这条路由不降级。" });
  if (!lightLlmProvider) return reply.code(422).send({ error: "未配置模型：判一次分层需要模型判层名与归属。" });
  const database = new TutorDatabase(repository.path);
  try {
    const overlays = readOverlays(database, repository.index.repositoryId);
    const plan = await generateArchitectureCached({ ...architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays }), provider: lightLlmProvider, force: true });
    if (plan.usage) new Journal(repository.path, repository.index.repositoryId).append("token_usage", { input_tokens: plan.usage.inputTokens, output_tokens: plan.usage.outputTokens, cache_hit_tokens: plan.usage.promptCacheHitTokens ?? null, provider: lightLlmProvider.modelVersion, scene: "architecture_map" });
    return plan;
  } finally {
    database.close();
  }
});

// 人工修正通道（覆盖层）。GUI 的拖动、Agent 的 `set_architecture`、浏览器旧值的一次性迁移，三条写路径共用这一处：
// 各写一套合并逻辑，迟早有一处把用户的修正抹掉。数组整份替换、字典按键合并、`remove` 按 key 显式撤。
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/overlays", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const database = new TutorDatabase(repository.path);
  try {
    const overlays = readOverlays(database, repository.index.repositoryId);
    return { repositoryId: repository.index.repositoryId, overlays, counts: overlayCounts(overlays) };
  } finally {
    database.close();
  }
});

// 单条修正的落地（agent 的 `set_architecture` 与这条路由；GUI 只剩「模块档位」下拉还在用它，画布已只读）。
// 与 Agent 工具共用 `applyOverrideIntent`：两条路都写同一份覆盖层、同一条审计、同一个通知。
app.post<{ Params: { repositoryId: string }; Body: { intent?: OverrideIntent; via?: OverrideVia } }>("/api/repositories/:repositoryId/overlays/apply", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const intent = request.body?.intent;
  if (!intent || typeof intent !== "object" || !("kind" in intent)) return reply.code(400).send({ error: "intent 缺失：要 move_module / rename_layer / set_tier / reset 之一（形状见 override-writer）" });
  const database = new TutorDatabase(repository.path);
  try {
    const outcome = applyOverrideIntent(repository, database, intent, request.body?.via === "agent" ? "agent" : "gui");
    // 拒写时把引擎那句原话同时放进 `error`：GUI 的 fetch 封装只认非 2xx 的 `error` 字段，
    // 不在这里镜像一份就会给用户看一句通用的「没送达」——而它其实送到了、还被讲清了为什么不行
    return reply.code(outcome.ok ? 200 : 422).send(outcome.ok ? outcome : { ...outcome, error: outcome.text });
  } finally {
    database.close();
  }
});

app.post<{ Params: { repositoryId: string }; Body: OverlaysPatch & { remove?: { modules?: { tier?: string[]; renamed?: string[] }; architecture?: { moduleLayer?: string[] } } } }>("/api/repositories/:repositoryId/overlays", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const database = new TutorDatabase(repository.path);
  try {
    const body = request.body ?? {};
    let overlays = body.remove ? removeOverlayKeys(database, repository.index.repositoryId, body.remove) : readOverlays(database, repository.index.repositoryId);
    if (body.modules || body.architecture) overlays = patchOverlays(database, repository.index.repositoryId, { modules: body.modules, architecture: body.architecture });
    // 回读一次再交出去：调用方要看到的是**落盘之后**的覆盖层，而不是自己发出去的那份意图
    const after = readOverlays(database, repository.index.repositoryId);
    return { repositoryId: repository.index.repositoryId, overlays: after ?? overlays, counts: overlayCounts(after ?? overlays) };
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
  // 流程生成走**主力档**（2026-09-18 由轻量档改过来）：它是「看着整仓证据推断编排」的重任务，
  // 而轻量档现在承担 L1 的文件级摘要（量大、单条简单）。两者不共用一档。
  const budgetExhausted = budgetDegraded(repository.path, repository.index.repositoryId);
  const provider = budgetExhausted ? undefined : teachingProvider;
  // 「触顶」与「没配模型」分开说：处置分别是调预算、配密钥，合成一句就把人往错的方向支
  // （尤其「模型主动判空/降级」被写成「还没配 LLM」会把人引去配密钥；推荐入口路由沿用同一口径）
  if (!provider) return degradedFlow(repository.analysis, entry, budgetExhausted ? "本月预算已触顶，未调用主力档 LLM" : "未配置主力档 LLM");
  const database = new TutorDatabase(repository.path);
  try {
    const summaries = latestFileSummaries(repository.path);
    /**
      L1 摘要是「每文件最新一条」的**有界**读取（上限见 `LATEST_SUMMARY_LIMIT`），所以大仓上部分路径会静默缺席；
      从未摘要的文件也一样缺席。流程模型只看得到剩下的那批，这必须是一条**读数**而不是只有一次性的 console 行。
      ⚠️ 刻意不进 flow 的 digest：进键就等于每改一次读取上限、每多一个文件没摘要，全仓流程缓存一起翻
      （≈¥0.17/条），而「证据少了几个文件」并不改变这条流程该说什么。
      */
    const missingSummaries = repository.index.files.filter((file) => !summaries.has(file.path));
    if (missingSummaries.length) {
      traceEngine("degrade", {
        what: "flow_evidence_gap",
        repositoryId: repository.index.repositoryId,
        entry: entry.path.split("/").pop() ?? entry.path,
        indexed: repository.index.files.length,
        missing: missingSummaries.length,
        sample: missingSummaries.slice(0, 5).map((file) => file.path).join("、")
      });
    }
    const generated = await generateRepositoryFlowCached({
      repositoryPath: repository.path,
      index: repository.index,
      analysis: repository.analysis,
      entry,
      provider,
      summaries,
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
  const provider = budgetDegraded(repository.path, repository.index.repositoryId) ? undefined : lightLlmProvider;
  try {
    return await exercises.answer(repository, request.params.exerciseId, request.body ?? {}, provider);
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法判分" });
  }
});

/**
  按需讲评（代码题）：判分已经落库，这一趟只补一段解释；未配模型或预算触顶时**照旧 422**，
  不回落成本地拼一句模板话——那是 §51 里撤掉的那类「看起来答完了、其实没走模型」。
*/
app.post<{ Params: { repositoryId: string; exerciseId: string }; Body: ExerciseAnswer }>("/api/repositories/:repositoryId/exercises/:exerciseId/explain", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const provider = budgetDegraded(repository.path, repository.index.repositoryId) ? undefined : lightLlmProvider;
  try {
    return await exercises.explain(repository, request.params.exerciseId, request.body ?? {}, provider);
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法生成讲评" });
  }
});

// 三条作用域对话（宏观设计 / 代码问答 / 练习评估）共用的闸门：单轮 LLM 讨论，无阶梯无本地兜底；
// 预算触顶或未配置 LLM 时显式 422（不静默回落）。`gate` 由调用方在开火前算好传进来，避免同一次请求读两趟成本。
function scopedChatProviderOr422(reply: FastifyReply, repositoryPath: string, repositoryId: string, gate?: { monthlyBudgetUsd: number; degraded: boolean }): LlmProvider | undefined {
  if ((gate ?? budgetGate(repositoryPath, repositoryId)).degraded) {
    void reply.code(422).send({ error: "本月预算已触顶，此作用域的 LLM 对话不可用；可在设置中调整预算。" });
    return undefined;
  }
  if (!teachingProvider) {
    // 指路要指当前的入口：GUI 的 LLM 设置优先，`TUTOR_TEACHING_*` 只是仍在读的废弃别名（写进 .env 也不再是主路径）
    void reply.code(422).send({ error: "尚未配置 LLM（在设置里选服务商与模型，或在 .env 写 TUTOR_LLM_PROVIDER / TUTOR_LLM_MODEL），此作用域的 LLM 对话不可用。" });
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

  `threadId` 缺席 = 单次提问，按设计不落库；**线程在但写不进去**（这一轮期间被软删、库写不动）是真丢正文：
  GUI 已经拿到回放，库里却查无此人，下次进会话就是「聊过但没记录」。静默跳过等于把失败说成成功，
  所以这里必须留下一条能在 engine.jsonl 查到的读数（`chat-store.appendMessages` 的契约也是这么写的）。
  */
function persistScopedTurn(repositoryPath: string, scene: "map_chat" | "practice_chat", threadId: string | undefined, question: string, answer: string): void {
  if (!threadId) return;
  if (appendMessages(repositoryPath, threadId, [{ role: "user", content: question }, { role: "assistant", content: answer }])) return;
  traceEngine("degrade", { what: "turn_body_dropped", scene, thread_id: threadId });
  console.warn(`[engine] ${scene} 这一轮的正文没能写进线程 ${threadId}（线程已被删除或库写不动）；journal 的 turn_text 仍在，产品线缺这一行`);
}

/**
  运行期不变量复检（B 档第 2 刀的那三条，零 token / 纯函数 / 微秒级）。
  外部批评说「回合一旦生成就不再被复核」——这一刀把话收回来：合格也记一条 `turn_invariant`，
  分母因此在环成立；引用没能核实时在正文尾部补一行明示，学习者读到的是被核过的文本。

  能在尾部补话而不打断体验，靠的是一个实现事实：三种作用域都是**模型算完之后分块回放**
  （`replayTypewriter`，块长 `TYPEWRITER_CHUNK`），不是真 token 流。哪天真流式了，这行提示就得改成独立事件（记在这里防忘）。

  判据与 `phaseB:eval` 第 4 节共用 `checkTurnInvariants` 同一个函数，不分两份实现。
  */
function recheckTurn(input: {
  repository: NonNullable<ReturnType<typeof repositoryOr404>>;
  journal: Journal;
  sessionId?: string;
  scene: "teach" | "map_chat" | "practice_chat";
  /**
    本回合经 `cross_repo_link` / 跨仓 read_file **由引擎亲手递给模型**的对端路径（裸路径 → 总行数）。
    没有这份登记，模型引用后端 controller 的行号会被判成「未在当前仓库核实」——那是引擎给它的证据，
    判它编造是假阳性；但只有登记过的路径算数，模型自己凭空写一个后端文件照样过不去。
   */
  crossFiles?: Map<string, number>;
  question: string;
  answer: string;
  style?: number;
}): { answer: string; failed: string[] } {
  // 先过筛再复检：判的必须是「用户将会看到的那一份」，且密钥不能等到下发之后才挡
  const screened = screenReply(input.answer);
  const verdict = checkTurnInvariants({
    sessionId: input.sessionId ?? "unscoped",
    at: new Date().toISOString(),
    question: input.question,
    answer: screened.text,
    style: input.style ?? 0,
    answerTruncated: false,
    scene: input.scene
  }, new Map<string, number>([...input.repository.index.files.map((file) => [file.path, file.lines] as [string, number]), ...(input.crossFiles ?? [])]));
  input.journal.append("turn_invariant", {
    scene: input.scene,
    applicable: verdict.applicable.join("、") || null,
    failed: verdict.failed.join("、") || null,
    evidence: Object.entries(verdict.evidence).map(([id, text]) => `${id}=${text}`).join(" ｜ ") || null,
    // 过筛只记数量与首个样例（不记原文——那正是不能外泄的东西）：审计线要能回答「这轮被改过没有」
    masked_secrets: screened.secrets || null,
    masked_paths: screened.paths || null,
    masked_samples: screened.samples.join("、") || null
  }, input.sessionId);
  const notice = `${screenNotice(screened) ?? ""}${invariantTailNotice(verdict) ?? ""}`;
  return { answer: notice ? `${screened.text}${notice}` : screened.text, failed: verdict.failed };
}

/**
  map_chat 回合的统一收尾（非流式与流式两条路由共用这一份）：运行期复检（零 token）→ 线程正文落库 → 审计线。
  引用核不上就在正文尾部补一行明示；此后落库、回放、审计读的是同一份文本。
*/
function finishMapChatTurn(repository: NonNullable<ReturnType<typeof repositoryOr404>>, provider: LlmProvider, threadId: string | undefined, question: string, result: ScopedChatResult, crossFiles: Map<string, number>): void {
  const journal = new Journal(repository.path, repository.index.repositoryId);
  result.reply = recheckTurn({ repository, journal, sessionId: threadId, scene: "map_chat", question, answer: result.reply, crossFiles }).answer;
  persistScopedTurn(repository.path, "map_chat", threadId, question, result.reply);
  if (result.usage) journal.append("token_usage", {
    input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
    cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map_chat"
  }, threadId);
  // 同一轮对同一路径的重复读取（重试/换窗口）在 journal 归并为一条：审计回答「看过哪些文件」
  for (const read of dedupeFileReads(result.fileReads ?? [])) {
    journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, masked: read.masked ?? 0, error: read.error ?? null }, threadId);
  }
  // 检索漏斗：搜了什么、命中多少、前几条落在哪——「先搜后读」的转化率要靠这条读数
  for (const search of result.codeSearches ?? []) {
    journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、"), segmented: search.segmented === true }, threadId);
  }
  // 作用域验收信号：降级次数是「上下文≠选中项」的负向代理指标（设计方案 §10 层2），必须留痕可聚合
  if (result.scopeDegraded) {
    journal.append("scope_degraded", { node_id: result.scopeDegraded.nodeId, scope_paths: result.scopeDegraded.scopePathsCount }, threadId);
  }
  journal.append("loop_round", { scene: "map_chat", decision: "deterministic", proposed: null, executed: null, tool_rounds: result.toolRounds, tool_reads: (result.fileReads ?? []).length, tool_searches: (result.codeSearches ?? []).length }, threadId);
  journal.append("turn_text", turnTextPayload("map_chat", question, result.reply), threadId);
}

/**
  架构修正工具的装配（**只在 map_chat 且这一轮绑到了模块地图里的节点**时才有；practice_chat 永远不给）。
  两条纪律：
  - 校验层名用的是「现在图上的层」，从缓存产物读，**绝不为了校验去发一发模型**——
    用户说一句「把它挪到编排层」不该变成一笔重判的钱；
  - 落盘走 `commitOverride`，与 GUI 拖动同一条写路径：校验、写盘、审计、通知四步一次做完。
*/
/** 一次人工修正的落地：校验 → 写盘 → 审计 → 通知。GUI 的拖动与 Agent 的工具都走这一个函数。 */
function applyOverrideIntent(repository: ImportedRepository, database: TutorDatabase, intent: OverrideIntent, via: OverrideVia, sessionId?: string) {
  const overlays = readOverlays(database, repository.index.repositoryId);
  if (!lightLlmProvider) return { ok: false, text: "没改：这份产物还没配模型，图上没有可改的层。", overlays };
  /** 与两条读出口同一份输入构造（tier 现算 + 覆盖层）——这里曾经少叠一档，结果真仓上每次拖动都被自己的层名校验拒掉 */
  const input = architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays });
  const peek = peekCachedArchitecture({ ...input, provider: lightLlmProvider });
  const outcome = commitOverride({
    database,
    repositoryId: repository.index.repositoryId,
    course: input.course,
    layers: peek.layers,
    blocks: peek.blocks,
    journal: { append: (type, payload) => new Journal(repository.path, repository.index.repositoryId).append(type, payload, sessionId) },
    onApplied: (event) => broadcast({ type: "architecture_updated", payload: { repositoryId: event.repositoryId, module: event.module ?? null, via: event.via } })
  }, intent, via);
  return { ...outcome, layers: peek.layers };
}

function architectureToolFor(repository: ImportedRepository, nodeId: string | undefined, database: TutorDatabase, sessionId?: string): ArchitectureToolContext | undefined {
  const branch = repository.course.root.children.find((node: CourseNode) => node.id === "modules");
  if (!(branch?.children ?? []).some((node: CourseNode) => node.id === nodeId)) return undefined;
  if (!lightLlmProvider) return undefined;
  return {
    apply: (argumentsJson: string) => {
      const parsed = parseOverrideArguments(argumentsJson);
      const note = parsed.ignored.length ? `（多余字段 ${parsed.ignored.join(" / ")} 已忽略：边、模块清单与文件路径不在可改范围内）` : "";
      if (parsed.error) return `没改：${parsed.error}。${note}`;
      return `${applyOverrideIntent(repository, database, parsed.intent as OverrideIntent, "agent", sessionId).text}${note}`;
    }
  };
}

app.post<{ Params: { repositoryId: string }; Body: { content?: string; nodeId?: string; scopePaths?: string[]; path?: string; focus?: unknown; threadId?: unknown; style?: unknown } }>("/api/repositories/:repositoryId/map-chat", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const content = request.body?.content?.trim();
  if (!content) return reply.code(400).send({ error: "消息内容不能为空" });
  const turn = scopedThreadTurn(repository, request.body?.threadId, "map");
  // 线程无效（跨仓库 / 跨作用域 / 已软删）在开火前拒绝：一个干净的 409 比「模型拿错上下文自信作答」便宜得多
  if (!turn) return reply.code(409).send({ error: "会话线程不存在、已删除或不属于本仓库的宏观设计作用域；请新建会话后再问。" });
  // 线程就地标注：llm.log 的每条 provider 调用都带上它，前缀缓存才能按「同一线程相邻两轮」算间隔
  markThread(turn.threadId);
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flatten(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  // 覆盖层的读写要一条库连接；工具闭包与回合共用它，收尾统一 close（句柄泄漏的旧坑见 §37.4）
  const overlayDatabase = new TutorDatabase(repository.path);
  try {
    const crossFiles = new Map<string, number>();
    const toolContext = architectureToolFor(repository, request.body?.nodeId, overlayDatabase, turn.threadId);
    const result = await mapChat({ repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, focus: sanitizeChatFocus(request.body?.focus), content, history: turn.history, earlierQuestions: turn.earlierQuestions, provider, style: validateStyle(request.body?.style), search: searchCorpusFor(repository), cross: crossRepoFor(repository, crossFiles), threadId: turn.threadId, ...(toolContext ? { architecture: toolContext } : {}) });
    finishMapChatTurn(repository, provider, turn.threadId, content, result, crossFiles);
    return { reply: result.reply, provider: result.provider };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "LLM 对话失败" });
  } finally {
    overlayDatabase.close();
  }
});

/** 「停止生成」的带外入口（三作用域共用）：GUI 点停止时先打这里，再断开自己的 SSE 连接。
    为什么单独一条而不是「连接断了就中止」：客户端消失分不出是用户要停还是网络波动/刷新页面——
    后者引擎必须把这一轮**算完并落库**，用户回来才有账可补（见 turns/registry.ts）。
    未命中 = 这一轮已经结束或本来就没登记，回 404，GUI 照常收尾、不当成错误。
    认证闸撤了之后**这台机器上谁都能停任何回合**（原来按 key 归属判的那道 403 一起没了，§64）。 */
app.post<{ Body: { turnId?: unknown } }>("/api/turns/stop", async (request, reply) => {
  const stopped = abortTurn(request.body?.turnId);
  if (!stopped.aborted) {
    return reply.code(404).send({ stopped: false });
  }
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
  markThread(turn.threadId);
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId);
  if (!provider) return reply;
  const node = request.body?.nodeId ? flatten(repository.course.root).find((item) => item.id === request.body?.nodeId) : undefined;
  const { send, turnHandle } = beginScopedStream(request, reply, "map_chat", request.body?.turnId);
  const crossFiles = new Map<string, number>();
  const overlayDatabase = new TutorDatabase(repository.path);
  try {
    const toolContext = architectureToolFor(repository, request.body?.nodeId, overlayDatabase, turn.threadId);
    const result = await mapChat({
      repoPath: repository.path, analysis: repository.analysis, node, nodeId: request.body?.nodeId, scopePaths: sanitizeScopePaths(request.body?.scopePaths), path: request.body?.path, focus: sanitizeChatFocus(request.body?.focus), content, history: turn.history, earlierQuestions: turn.earlierQuestions, provider,
      style: validateStyle(request.body?.style),
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
      threadId: turn.threadId,
      onProgress: (progress: MapChatProgress) => send(progress),
      ...(toolContext ? { architecture: toolContext } : {}),
      ...(turnHandle.signal ? { signal: turnHandle.signal } : {})
    });
    // 与教学回合同款收尾：中止若晚于最后一趟 LLM 到达，这一轮照样作废，不落库也不回放
    if (turnHandle.signal?.aborted) throw new LlmAbortedError();
    finishMapChatTurn(repository, provider, turn.threadId, content, result, crossFiles);
    // 打字机回放（三作用域同款 72 字分块）：真 token 流式需 provider 层改造，这里先消除「整段落下」
    replayTypewriter(send, result.reply);
    send({ type: "done", reply: result.reply, provider: result.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "map_chat", turnHandle, threadId: turn.threadId, error, fallbackError: "LLM 对话失败" });
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
  markThread(thread?.id);
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
  const { send, turnHandle } = beginScopedStream(request, reply, "practice_chat", request.body?.turnId);
  try {
    const result = await practiceChat({ repoPath: repository.path, exercise: stored.exercise, content, history, earlierQuestions, provider, style: validateStyle(request.body?.style), ...(thread?.id ? { threadId: thread.id } : {}), ...(turnHandle.signal ? { signal: turnHandle.signal } : {}) });
    // 与教学回合同款收尾：中止若晚于最后一趟 LLM 到达，这一轮照样作废，不落库也不回放
    if (turnHandle.signal?.aborted) throw new LlmAbortedError();
    const journal = new Journal(repository.path, repository.index.repositoryId);
    // 运行期复检（零 token）：练习答疑也在环内——它同样会引用仓库里的代码位置
    result.reply = recheckTurn({ repository, journal, sessionId: thread?.id, scene: "practice_chat", question: content, answer: result.reply }).answer;
    persistScopedTurn(repository.path, "practice_chat", thread?.id, content, result.reply);
    if (result.usage) journal.append("token_usage", {
      input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
      cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "practice_chat"
    }, thread?.id);
    journal.append("turn_text", turnTextPayload("practice_chat", content, result.reply), thread?.id);
    replayTypewriter(send, result.reply);
    send({ type: "done", reply: result.reply, provider: result.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "practice_chat", turnHandle, ...(thread?.id ? { threadId: thread.id } : {}), error, fallbackError: "LLM 对话失败" });
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

/**
  源码查看（GUI 的源码面板与练习锚点用）。

  ⚠️ 只放**已索引的文件**，不是「仓库里的任何文件」：`source/read-file.ts` 那条「.env / 私钥 / 凭据载体禁读」
  的名单在索引扩展名白名单里天然不存在（`.env`、`id_rsa` 都没有被收进索引），所以按索引集合放行就等于
  借用了同一份边界；裸 `readFileSync` 则是给引擎开了一条绕过名单的口子——本机任意进程、
  乃至任意打开的网页（CORS 是全放开的）都能拿它把被学习仓库里的密钥读出来。
  GUI 的取参来源本来就全是锚点 / 文件树（都在索引里），收紧不改变正常动线。
  */
app.get<{ Params: { repositoryId: string }; Querystring: { path?: string; line?: string } }>("/api/repositories/:repositoryId/source", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const requestedPath = request.query.path?.replaceAll("\\", "/");
  if (!repository || !requestedPath) return reply.code(404).send({ error: "未找到源码" });
  // 先判边界、再判收录：越界是「请求本身不合法」(400)，未收录是「这个文件我不给」(404)，两种失败界面要能分开
  const absolute = join(repository.path, requestedPath);
  if (!isWithin(repository.path, absolute)) return reply.code(400).send({ error: "源码路径越出仓库边界" });
  // 名单 + 软链接那一关与 `read_file` 共用一份判据（`pathReadBlock`）：字面路径过了闸不代表链接目标过了闸
  const blocked = pathReadBlock(repository.path, requestedPath);
  if (blocked) return reply.code(404).send({ error: `该文件不开放读取：${blocked}` });
  if (!repository.index.files.some((file) => file.path === requestedPath)) return reply.code(404).send({ error: "该文件不在本仓索引里（未收录的类型与密钥/凭据文件不提供源码）" });
  // line 是给界面定位用的：非数字/负数按 1，不能把 NaN 回出去（JSON 里会变成 null）
  const line = Number(request.query.line ?? 1);
  try { return { path: requestedPath, line: Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1, content: readFileSync(absolute, "utf8") }; }
  catch { return reply.code(404).send({ error: "无法读取该源码文件" }); }
});

app.get<{ Params: { repositoryId: string }; Querystring: { sessionId?: string } }>("/api/repositories/:repositoryId/cost", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  return summarizeCost(repository.path, readRepositorySettings(repository.path, repository.index.repositoryId).monthlyBudgetUsd, request.query.sessionId);
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
  try {
    // 读-合并-写：settings_json 里还存着 refinement 标记等内部键，整体覆盖会把它们抹掉
    const stored = database.getSettings<{ monthlyBudgetUsd?: number; summaryHeaderComments?: boolean; refinement?: unknown }>(repository.index.repositoryId) ?? {};
    const merged = {
      ...stored,
      ...(hasBudget ? { monthlyBudgetUsd: budget } : {}),
      ...(hasToggle ? { summaryHeaderComments: request.body.summaryHeaderComments } : {})
    };
    database.saveSettings(repository.index.repositoryId, merged);
  } finally {
    database.close();
  }
  const next = readRepositorySettings(repository.path, repository.index.repositoryId);
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
  const lightProvider = budgetDegraded(repository.path, repository.index.repositoryId) ? undefined : buildLlmRuntimeProvider("light");
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
  const mounted = importer.ensureMounted(request.body?.repositoryId ?? "");
  if (!mounted.ok) return reply.code(404).send({ error: mounted.message, reason: mounted.reason });
  const repository = mounted.repository;
  const node = flatten(repository.course.root).find((item) => item.id === request.body?.courseNodeId);
  if (!node) return reply.code(404).send({ error: "课程节点不存在" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : undefined);
  const hasExplicitSettings = Boolean(request.body?.settings && Object.keys(request.body.settings).length) || typeof request.body?.style === "number";
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  let settings = hasExplicitSettings
    ? validateSettings({ ...defaultTutorSettings, ...request.body?.settings, style: requestedStyle })
    : learnerProfile.recommended.settings;
  const session = createSession(repository.index.repositoryId, node.id, settings);
  // 会话即线程：id 由 createSession 生成后原样落库，GUI 存的就是这个 id
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scope: "teach", id: session.id, courseNodeId: node.id, title: node.title });
  saveThreadState(repository.path, session.id, { settings: session.settings });
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
/**
  线程住在**哪个仓的库**里，就读那个库——不能只看挂在内存里的那几个。
  挂载集有上限（`maxMounted()`，其余按 LRU 驱逐），而被驱逐的仓只是不在内存，它的 `.tutor/tutor.db` 一字未动。
  过去这三条线程路由只扫挂载集，于是切够几次仓再点开旧对话，就得到一句「会话不存在或已删除」，
  改名和删除也跟着 404——库里明明还在。兜法是把地址簿逐仓核一趟：每条只开一次 SQLite（读完即关）、纯本地读，零 token。
  ⚠️ 这里**刻意不挂回该仓**：三条路由要的只是库路径与仓 id（id 就写在线程行上），
  挂回来反而会把「产物读不动」误报成「会话没了」，还为一次读历史付一趟挂载的代价。
  */
function locateThread(threadId: string): { repositoryPath: string; repositoryId: string; thread: ChatThread } | undefined {
  for (const repository of importer.mountedRepositories()) {
    const thread = getThread(repository.path, threadId);
    if (thread) return { repositoryPath: repository.path, repositoryId: repository.index.repositoryId, thread };
  }
  for (const entry of importer.catalog()) {
    if (entry.mounted || !entry.exists) continue;
    const thread = getThread(entry.repositoryPath, threadId);
    if (thread) return { repositoryPath: entry.repositoryPath, repositoryId: thread.repositoryId, thread };
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
  同时从内存 Map 摘掉教学会话——否则删掉的会话还能被同进程继续聊，重启后又消失，行为会分成两段。
  */
app.delete<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
  const located = locateThread(request.params.threadId);
  if (!located || !softDeleteThread(located.repositoryPath, located.thread.id)) return reply.code(404).send({ error: "会话不存在或已删除。" });
  teachingStates.delete(located.thread.id);
  new Journal(located.repositoryPath, located.repositoryId).append("session_deleted", threadJournalPayload(located.thread, "user_deleted"), located.thread.id);
  return { deleted: true, threadId: located.thread.id };
});

app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; style?: unknown; turnId?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const current = resolveTeachingState(request.params.sessionId);
  if (!current || !request.body?.content?.trim()) return reply.code(400).send({ error: "会话或消息无效" });
  // 教学侧的 sessionId 就是 chat_session 的线程 id（一个 id 三个名字），llm.log 直接沿用它做线程聚合
  markThread(current.id);
  /**
    同上：URL 里没有 `:repositoryId`，钩子够不到，这里补挂一次。
    会话还活在内存里、它的仓却已被 LRU 驱逐时，继续聊该像别的仓路由那样把它挂回来，
    而不是回一句「课程节点不可用」——那会把一次正常追问判成产物丢失，用户只会去重新导入（花钱）。
    */
  const mounted = importer.ensureMounted(current.repositoryId);
  if (!mounted.ok) return reply.code(404).send({ error: mounted.message, reason: mounted.reason });
  const repository = mounted.repository;
  const node = flatten(repository.course.root).find((item) => item.id === current.courseNodeId);
  if (!node) return reply.code(404).send({ error: "课程节点不可用" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : current.settings.style);
  const settings = validateSettings({ ...current.settings, ...request.body?.settings, style: requestedStyle });
  const styleChanged = JSON.stringify(settings) !== JSON.stringify(current.settings);
  const session = { ...current, style: settings.style, settings };
  // 闸门与 map/practice 同一条：没配模型、或本月预算已触顶，就在开火前 422。
  // 教学状态机撤掉之后这一域**不再有本地兜底那一档**——「看起来答完了、其实没走模型」是这条线上最难查的事故形状。
  const gate = budgetGate(repository.path, repository.index.repositoryId);
  const provider = scopedChatProviderOr422(reply, repository.path, repository.index.repositoryId, gate);
  if (!provider) return reply;
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  const faded = learnerProfile.fadedByUnit[node.id] ?? learnerProfile.faded;
  // 与 map/practice 同款 SSE：过程提示 + delta 回放并入本请求的响应流（事件天然按请求隔离，连接断开自动清理）
  const { send, turnHandle } = beginScopedStream(request, reply, "teach", request.body?.turnId);
  const crossFiles = new Map<string, number>();
  try {
    const outcome = await respondWithProvider(session, node, request.body.content.trim(), provider, faded, repository.path, {
      analysis: repository.analysis,
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
      onProgress: (progress) => send({ type: "progress", payload: progress }),
      ...(turnHandle.signal ? { signal: turnHandle.signal } : {})
    });
    // 中止可能赶在最后一趟 LLM 返回之后才到：那时没人抛错，这一轮会照常走到落库。
    // 用户点了停止就按「作废」收尾——不落库、不回放，否则 GUI 那句「这一轮没有落库」成了假话，
    // 下次进会话还会冒出一条自己掐掉的回复。断线（没点停止）才是另一条路：照常算完并落库，等着补账。
    if (turnHandle.signal?.aborted) throw new LlmAbortedError();
    teachingStates.set(outcome.session.id, outcome.session);
    const journal = new Journal(repository.path, repository.index.repositoryId);
    // 运行期复检（零 token）：撤掉阶梯后教学回合也只剩「引用能不能落地」这一条有对象（另两条吃 stage/问句），
    // 引用核不上就在正文尾部补一行明示，让「落库的正文 / 回放的正文 / journal 的 turn_text」是同一份。
    outcome.assistant.content = recheckTurn({
      repository,
      journal,
      sessionId: outcome.session.id,
      scene: "teach",
      crossFiles,
      question: request.body.content.trim(),
      answer: outcome.assistant.content,
      style: outcome.session.settings.style
    }).answer;
    // 回合正文 + 设置快照落库：GUI 重启后接着聊、以及「这一轮用的是哪档设置」都从这里取
    persistTeachingTurn(repository.path, repository.index.repositoryId, node.id, node.title, outcome.session.id, [
      { role: "user", content: request.body.content.trim() },
      { role: "assistant", content: outcome.assistant.content }
    ], { settings: outcome.session.settings });
    if (styleChanged) journal.append("style_shift", { style: settings.style, pedagogy: settings.pedagogy, depth: settings.depth, trigger: "manual" }, session.id);
    // 没有 `usage` 就是端点这趟没回报用量，**这一轮不进 token_usage**：
    // 拿字数÷4 造一份估算进账本，等于让不存在的钱吃掉预算——触顶后付费分支会被这些假账反过来关掉。
    // 写成「有 usage 才记」还与 map/practice 三处同一口径；成本页的「计费回合」= token_usage 行数。
    if (outcome.usage) journal.append("token_usage", { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens, cache_hit_tokens: outcome.usage.promptCacheHitTokens ?? null, provider: outcome.provider, scene: "teach" }, session.id);
    // 回合文本落盘（B 档第 2/3 刀的被测输入）：问题+回复双边，各截 2000 字并留痕
    journal.append("turn_text", turnTextPayload("teach", request.body.content.trim(), outcome.assistant.content), session.id);
    // 问答回合的 read_file 审计：与宏观设计作用域同一事件类型；同路径重复读取归并为一条
    for (const read of dedupeFileReads(outcome.fileReads ?? [])) {
      journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, masked: read.masked ?? 0, error: read.error ?? null }, session.id);
    }
    for (const search of outcome.codeSearches ?? []) {
      journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、"), segmented: search.segmented === true }, session.id);
    }
    // 回合摘要：状态机那三列（decision/proposed/executed）随阶梯一起停写，这里只留工具循环的轮次与次数
    journal.append("loop_round", { scene: "teach", tool_rounds: outcome.toolRounds ?? 0, tool_reads: (outcome.fileReads ?? []).length, tool_searches: (outcome.codeSearches ?? []).length }, session.id);
    const cost = summarizeCost(repository.path, gate.monthlyBudgetUsd, session.id);
    replayTypewriter(send, outcome.assistant.content);
    send({ type: "done", session: outcome.session, message: outcome.assistant, policy: policyFor(settings), cost, provider: outcome.provider });
  } catch (error) {
    // 用户点了停止：这一轮没有成品。不伪造 assistant 正文、不写 turn_text，只留一条中止痕迹
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "teach", turnHandle, threadId: session.id, error, fallbackError: "教学回合失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});

/**
  UI 动作事件出口（设计文档第 8 章 PRINCIPLE 03「可观测」）：
  每一次切节点、打开文件、切换模块、提交练习都必须有 journal 事件可查——缺事件的 UI 操作是设计漏洞。

  契约要点：
  - **只收界面侧那张表**（`UI_JOURNAL_EVENTS`，10 类）；两张表怎么分、为什么必须分，见 shared 里两张表的注释与下面的行内判据（§46）。
  - `payload` 仅允许标量（`string | number | boolean | null`）：结构化对象会随版本漂移。
  - `sessionId` **不做存在性校验**（只校验是字符串且有长度上限）：journal 是 append-only 事件流，
    sessionId 是关联属性而非外键。三作用域的会话续命都走 `chat_session`/`chat_message`（见 resolveTeachingState），
    不依赖这里的关联值——若按外键拒绝，前端会把能写的事件丢掉，那才是真的把可观测性弄丢。
  */
app.post<{ Params: { repositoryId: string }; Body: { type?: unknown; payload?: unknown; sessionId?: unknown } }>("/api/repositories/:repositoryId/journal", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const { type, payload, sessionId } = request.body ?? {};
  // 只收界面侧那 10 类：审计线里 `file_read` / `code_egress` / `token_usage` 是「哪些代码出过门」的证据，
  // 而这条接口本机任何进程都调得到——照全集合放行，等于让被审计的一方自己填账（§46）。
  if (!isUiJournalEventType(type)) {
    const owned = isEngineOwnedEventType(type);
    return reply.code(400).send(owned
      ? { error: "这类事件由引擎在状态机、工具循环与装配里写，界面接口不收（同一事实只写一处）。", reason: "engine_owned_event" }
      : { error: "事件类型不在 journal 契约内。", reason: "unknown_event" });
  }
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return reply.code(400).send({ error: "payload 必须是对象。" });
  }
  const scalars = (payload ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(scalars)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") continue;
    if (typeof value !== "string") return reply.code(400).send({ error: `payload.${key} 仅允许 string | number | boolean | null。` });
    if (value.length > 2000) return reply.code(400).send({ error: `payload.${key} 过长（上限 2000 字符）。` });
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > 200)) {
    // 上面那段契约承诺了「有长度上限」：一个超长 sessionId 会永久占进 append-only 的审计线，而它只是关联属性，截不动不如拒掉
    return reply.code(400).send({ error: "sessionId 必须是不超过 200 字符的字符串。" });
  }
  const event = new Journal(repository.path, repository.index.repositoryId)
    .append(type, scalars as JournalEvent["payload"], sessionId as string | undefined);
  return reply.code(201).send(event);
});

function flatten(root: CourseNode): CourseNode[] { return [root, ...root.children.flatMap(flatten)]; }
// s 标志：`.` 默认不匹配换行，回放会把多行回复的 `\n` 全丢掉（打字机预览塌成一行）；加上后逐块保留换行
function chunk(content: string, width: number): string[] { return content.match(new RegExp(`.{1,${width}}`, "gs")) ?? [content]; }

// 测试里不占端口：vitest 会把 VITEST 置为 "true"，此时只用 app.inject() 打路由。
// 不加这道闸，测试会和 pnpm dev 正在跑的引擎抢 3001 端口直接 EADDRINUSE 崩在 import。
const port = Number(process.env.ENGINE_PORT ?? 3001);
if (!process.env.VITEST) {
  await app.listen({ port, host: "127.0.0.1" });
  tboot("listening");
  // 认证闸已于 2026-10-15 整体撤除（§64）：本机没有「谁在调用」这个概念，只剩来源闸管浏览器那一侧。
  console.log("[engine] 访问控制：无认证闸（本机任意进程都能调）｜来源闸生效（只信回环与 TUTOR_ALLOWED_ORIGINS，非可信来源 403）");
  /**
    沙箱隔离探测：逐项 canary 要起十来个进程，放后台跑（不拖监听），但结果必须开机就看得见。
    没过的话代码题域整域禁用（2026-10-14 拍板：不降级成「弱隔离照跑」），这条与认证闸、预算闸同一纪律——
    闸门失效不能等到用户点下按钮才知道（§36.6、§44）。
    */
  void reprobeIsolation().then((sandbox) => {
    console.log(`[engine] 沙箱：${sandbox.level === "enforced" ? `强制隔离已验（${sandbox.checks.length} 项 canary 全过 · ${sandbox.backend} · ${sandbox.durationMs}ms）` : `**未通过——代码题域禁用**：${sandbox.reason}`}`);
    if (sandbox.level !== "enforced") {
      traceEngine("degrade", { what: "sandbox_isolation", reason: sandbox.reason }, { traceId: null });
    }
  });
  // 单价全没配 = 预算闸门失效（有闸门名没有闸门），与认证闸那条同纪律（§36.6）：必须开机就在账面上看得见。
  const gateNotice = budgetGateNotice();
  if (gateNotice) {
    console.warn(`[engine] ${gateNotice}`);
    traceEngine("degrade", { what: "budget_gate", reason: "pricing_unset" }, { traceId: null });
  }
}
