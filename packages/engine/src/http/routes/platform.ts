import type { JournalEvent } from "@codebase-tutor/shared";
import { engineVersion } from "../../boot.js";
import { openEventStream } from "../../http/sse.js";
import { teachingProviderStatus } from "../../llm/provider.js";
import { getLlmRuntimeSettings } from "../../llm/runtime.js";
import { externalToolSurface, mcpConfigFile, readMcpConfigs } from "../../mcp/clients.js";
import { isolationStatus, reprobeIsolation } from "../../sandbox/isolation.js";
import { importer, lightLlm, repositoryOr404, teachingLlm } from "../../services.js";
import { listSkills, skillDirectories } from "../../skills/skills.js";
import { Journal, isEngineOwnedEventType, isUiJournalEventType } from "../../store/journal.js";
import { createSummaryProvider } from "../../summarizer/summary-provider.js";
import type { FastifyInstance } from "fastify";

/**
  引擎自己的运维面：地址簿、挂载与免打扰开关、外部能力面读数、健康与沙箱、事件流、导入任务、界面动作事件出口。
  这一组与「某个仓库的产物」无关（除 journal 那条按仓落盘），所以它们合住一个文件：
  排查「引擎活着吗 / 挂上了吗 / 闸门在不在生效」时只翻这一处。
 */
export function registerPlatformRoutes(app: FastifyInstance): void {
/** 地址簿清单（不读产物）：GUI 的仓库切换器数据源。 */
app.get("/api/repositories", async () => ({ repositories: importer.catalog() }));

/**
  外部能力面的读数口（零 token）：装了哪些技能、配置文件里有哪些 server、这轮真并进请求的工具清单，
  以及连不上的原因。**读它会顺带把没连上的 server 拉起一次**——「连不上」必须是实测的，不能是猜的。
  界面没有这一格（能力优先做成工具），排查靠 curl 与 `pnpm run-trace`。
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
  - 到点自动恢复（默认 30 分钟，限死在 1 分钟~6 小时）：一个忘在手上的开关不该永久关掉增量更新。
  */
app.post<{ Params: { repositoryId: string }; Body: { paused?: unknown; ttlMs?: unknown } }>("/api/repositories/:repositoryId/watch", async (request) => {
  // 不需要在这里再判一次「仓在不在」：URL 带 `:repositoryId` 的路由都由懒挂载钩子先把仓挂上，
  // 地址簿里没有 / 目录没了 / 产物不全在那一步就已经 404 了（reason=not_in_catalog 等）。
  const repositoryId = request.params.repositoryId;
  const paused = request.body?.paused !== false; // 默认 = 挂起（这条路由是来关监听的，不是来问状态的）
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

app.get("/api/health", async () => {
  const llm = teachingProviderStatus(teachingLlm());
  return {
    status: "ok", service: "codebase-tutor-engine", version: engineVersion,
    // 摘要档由真源工厂报出：直接读 TUTOR_SUMMARY_PROVIDER 会把「没设环境变量 = 走轻量档」说成 "local"，
    // 而 .env 里那行空值会让这个字段回成空串——健康页的读数不能反过来误导人
    summaryProvider: createSummaryProvider({ llm: lightLlm() }).name,
    llmProvider: llm.provider, llmModel: llm.model, llmMode: llm.mode,
    thinking: getLlmRuntimeSettings().thinking,
    // 沙箱闸门状态原样给出（含逐项 canary 读数）：代码题能不能出，看这个节点，不看界面自己猜
    sandbox: isolationStatus()
  };
});

app.get("/api/events", async (request, reply) => {
  // 开局、心跳与断开摘除都在 `http/sse.ts`；这里只负责「谁可以连」（来源闸已经跑过了）。
  // 断线重连与「空闲超时只掐这一条连接」由前端 `subscribeServerEvents` 自己管（fetch 读流才掐得住，见 §47）。
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
  UI 动作事件出口（设计文档第 8 章 PRINCIPLE 03「可观测」）：
  每一次切节点、打开文件、切换模块、提交练习都必须有 journal 事件可查——缺事件的 UI 操作是设计漏洞。

  契约要点：
  - **只收界面侧那张表**（`UI_JOURNAL_EVENTS`，成员以那张表为准，这里不抄条数）；两张表怎么分、为什么必须分，见 shared 里两张表的注释与下面的行内判据（§46）。
  - `payload` 仅允许标量（`string | number | boolean | null`）：结构化对象会随版本漂移。
  - `sessionId` **不做存在性校验**（只校验是字符串且有长度上限）：journal 是 append-only 事件流，
    sessionId 是关联属性而非外键。三作用域的会话续命都走 `chat_session`/`chat_message`（见 resolveTeachingState），
    不依赖这里的关联值——若按外键拒绝，前端会把能写的事件丢掉，那才是真的把可观测性弄丢。
  */
app.post<{ Params: { repositoryId: string }; Body: { type?: unknown; payload?: unknown; sessionId?: unknown } }>("/api/repositories/:repositoryId/journal", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const { type, payload, sessionId } = request.body ?? {};
  // 只收界面侧那张表里的类型：审计线里 `file_read` / `code_egress` / `token_usage` 是「哪些代码出过门」的证据，
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
}
