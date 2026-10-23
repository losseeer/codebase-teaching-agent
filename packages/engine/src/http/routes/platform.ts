import type { JournalEvent } from "@codebase-tutor/shared";
import { engineVersion } from "../../boot.js";
import { openEventStream } from "../../http/sse.js";
import { teachingProviderStatus } from "../../llm/provider.js";
import { getLlmRuntimeSettings } from "../../llm/runtime.js";
import { externalToolSurface, mcpConfigFile, readMcpConfigs } from "../../integrations/clients.js";
import { isolationStatus, reprobeIsolation } from "../../sandbox/isolation.js";
import { importer, lightLlm, REPOSITORY_NOT_MOUNTED, repositoryOr404, teachingLlm } from "../../services.js";
import { listSkills, skillDirectories } from "../../integrations/skills.js";
import { Journal, isEngineOwnedEventType, isUiJournalEventType } from "../../store/journal.js";
import { createSummaryProvider } from "../../summarizer/summary-provider.js";
import type { FastifyInstance } from "fastify";

/**
  引擎自己的运维面：地址簿、挂载与免打扰开关、外部能力面读数、健康与沙箱、事件流、导入任务、界面动作事件出口。
 */
export function registerPlatformRoutes(app: FastifyInstance): void {
/** 地址簿清单（不读产物）：GUI 的仓库切换器数据源。 */
app.get("/api/repositories", async () => ({ repositories: importer.catalog() }));

/**
  外部能力面的读数口（零 token）：装了哪些技能、配置文件里有哪些 server、这轮真并进请求的工具清单，以及连不上的原因。
  读它会顺带把没连上的 server 拉起一次——「连不上」要来自真实尝试，不能是猜的。
*/
app.get("/api/external", async () => {
  const skills = listSkills();
  const surface = await externalToolSurface();
  return {
    skillDirectories: skillDirectories(),
    skills: skills.skills,
    skillSkipped: skills.skipped,
    mcpConfigFile: mcpConfigFile(),
    mcpConfigSkipped: readMcpConfigs().skipped,
    tools: (surface?.tools ?? []).map((tool) => tool.name),
    errors: surface?.errors ?? []
  };
});

/** 显式挂载一个仓库并回报新鲜度：GUI 切换仓库时调它，好把「这份分析有多旧」说在打开之前。 */
app.post<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/mount", async (request, reply) => {
  const result = importer.ensureMounted(request.params.repositoryId);
  if (!result.ok) return reply.code(404).send({ error: result.message, reason: result.reason });
  return { repositoryId: result.repository.index.repositoryId, repositoryPath: result.repository.path, freshness: result.repository.freshness };
});

/** 把某仓移出地址簿（并就地卸载）。默认只动引擎的注册表；`?artifacts=1` 才连该仓 `.tutor/` 里的分析产物、对话记录与运行日志一起删。 */
app.delete<{ Params: { repositoryId: string }; Querystring: { artifacts?: string } }>("/api/repositories/:repositoryId", async (request) => {
  return { repositories: importer.catalog(), ...importer.forget(request.params.repositoryId, request.query.artifacts === "1") };
});

/**
  编辑期免打扰：按仓挂起 / 恢复 fs 增量监听。一轮编辑会叫醒一次重分析并产生轻量档调用。

  三条口径：
  - 挂起不丢东西：产物与内存照用，只是磁盘改动不再自动重分析；恢复时重算一次新鲜度，
    脏了由界面横幅如实说，要不要重跑仍由人点（引擎不自动重分析）。
  - 挂起活过驱逐与重新挂载：登记在 `ImportService` 里，LRU 把仓挤出去再点回来时开关仍然有效。
  - 到点自动恢复（默认 30 分钟，限死在 1 分钟~6 小时）。
  */
app.post<{ Params: { repositoryId: string }; Body: { paused?: unknown; ttlMs?: unknown } }>("/api/repositories/:repositoryId/watch", async (request) => {
  // 不必在这里再判一次「仓在不在」：URL 带 `:repositoryId` 的路由都由懒挂载钩子先把仓挂上，
  // 地址簿里没有 / 目录没了 / 产物不全在那一步就已经 404
  const repositoryId = request.params.repositoryId;
  const paused = request.body?.paused !== false; // 默认挂起：这条路由是来关监听的，不是来问状态的
  const ttlMs = typeof request.body?.ttlMs === "number" ? request.body.ttlMs : undefined;
  if (!paused) return { repositoryId, paused: false, woken: importer.resumeWatching(repositoryId).woken, watching: importer.getRepository(repositoryId)?.watch ?? null };
  const result = importer.pauseWatching(repositoryId, ttlMs);
  return { repositoryId, paused: true, until: new Date(result.until).toISOString(), watching: false };
});

/**
  重跑一次沙箱隔离探测：探测失败会把代码题整域禁用（fail-closed），
  这里提供除重启引擎之外的当场再验一遍。能力不降级：`level !== "enforced"` 时代码题域照旧禁用。
  */
app.post("/api/sandbox/reprobe", async () => {
  const sandbox = await reprobeIsolation();
  console.log(`[engine] 沙箱重探：${sandbox.level === "enforced" ? `强制隔离已验（${sandbox.checks.length} 项 canary 全过 · ${sandbox.backend} · ${sandbox.durationMs}ms）` : `未通过——代码题域继续禁用：${sandbox.reason}`}`);
  return { sandbox };
});

app.get("/api/health", async () => {
  const llm = teachingProviderStatus(teachingLlm());
  return {
    status: "ok", service: "codebase-tutor-engine", version: engineVersion,
    // 摘要档由真源工厂报出：直接读 TUTOR_SUMMARY_PROVIDER 会把「没设环境变量」与「设成空值」两种情况都报歪
    summaryProvider: createSummaryProvider({ llm: lightLlm() }).name,
    llmProvider: llm.provider, llmModel: llm.model, llmMode: llm.mode,
    thinking: getLlmRuntimeSettings().thinking,
    // 沙箱闸门状态原样给出（含逐项 canary 读数）：代码题能不能出看这个节点
    sandbox: isolationStatus()
  };
});

app.get("/api/events", async (request, reply) => {
  // 开局、心跳与断开摘除都在 `http/sse.ts`；这里只负责建立连接（来源闸已经跑过了）
  openEventStream(request, reply);
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

/**
  UI 动作事件出口：每一次切节点、打开文件、切换模块、提交练习都要有 journal 事件可查。

  契约要点：
  - 只收界面侧那张表（`UI_JOURNAL_EVENTS`，成员以那张表为准）；两张表怎么分见 shared 里那张表的注释与下面的行内判据。
  - `payload` 仅允许标量（`string | number | boolean | null`）：结构化对象会随版本漂移。
  - `sessionId` 只校验是字符串且有长度上限，不做存在性校验：journal 是 append-only 事件流，
    sessionId 是关联属性而非外键。
  */
app.post<{ Params: { repositoryId: string }; Body: { type?: unknown; payload?: unknown; sessionId?: unknown } }>("/api/repositories/:repositoryId/journal", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const { type, payload, sessionId } = request.body ?? {};
  // 只收界面侧那张表里的类型：`file_read` / `code_egress` / `token_usage` 是审计证据，
  // 而这条接口本机任何进程都调得到，照全集合放行等于让被审计的一方自己填账
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
    // 超长 sessionId 会永久占进 append-only 的审计线，而它只是关联属性，所以拒掉而不是截断
    return reply.code(400).send({ error: "sessionId 必须是不超过 200 字符的字符串。" });
  }
  const event = new Journal(repository.path, repository.index.repositoryId)
    .append(type, scalars as JournalEvent["payload"], sessionId as string | undefined);
  return reply.code(201).send(event);
});
}
