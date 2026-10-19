import { applyOverrideIntent } from "../../application/canvas-tools.js";
import { budgetDegraded, latestFileSummaries } from "../../application/paid-turn.js";
import { architectureInputOf, generateArchitectureCached } from "../../coursetree/architecture.js";
import { suggestModuleEntriesCached } from "../../coursetree/entry-suggest.js";
import type { OverrideIntent, OverrideVia } from "../../coursetree/override-writer.js";
import { degradedFlow, generateRepositoryFlowCached, peekCachedFlow, resolveFlowEntry } from "../../flows/flow.js";
import { lightLlm, repositoryOr404, teachingLlm } from "../../services.js";
import { Journal } from "../../store/journal.js";
import { type OverlaysPatch, overlayCounts, patchOverlays, readOverlays, removeOverlayKeys } from "../../store/overlays.js";
import { traceEngine } from "../../trace/engine-log.js";
import type { FastifyInstance } from "fastify";

/**
  分析视图与人工修正通道：推荐入口、分层产物（读侧 allowCall:false / regenerate 才花钱）、覆盖层三条写路径、流程视图。
  这一组共用的口径：缓存里存原判、覆盖层不进键、读侧永不发请求。
 */
export function registerArchitectureRoutes(app: FastifyInstance): void {
// 教学模块「推荐入口」：LLM 从课程树候选节点中挑选（单轮调用）；未配置 LLM / 预算已达上限时返回空列表，GUI 回落关键词分类
app.get<{ Params: { repositoryId: string }; Querystring: { module?: string; hint?: string } }>("/api/repositories/:repositoryId/module-entries", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const moduleLabel = (request.query.module ?? "").trim();
  if (!moduleLabel) return reply.code(400).send({ error: "请提供模块名称" });
  const budgetExhausted = budgetDegraded(repository.handle);
  const provider = budgetExhausted ? undefined : lightLlm();
  // 「未配置」与「达到预算上限」分开报：处置不同，不让界面猜（flow 路由同一口径）
  const fallback = "按模块结构列出文件";
  if (!provider) return { entries: [], source: "module_files" as const, reason: `${budgetExhausted ? "本月预算已达到预算上限，未调用 LLM" : "未配置 LLM"}；${fallback}。` };
  const database = repository.handle.pin();
  try {
    const suggestion = await suggestModuleEntriesCached({
      tree: repository.course, moduleLabel, moduleHint: (request.query.hint ?? "").trim(), provider,
      fileSummaries: latestFileSummaries(repository.handle),
      // 零分候选的补位信号：入口点在前、高频改动的热点文件其次
      boostPaths: [...new Set([
        ...(repository.analysis.graph.entrypoints ?? []).map((entrypoint) => entrypoint.path),
        ...repository.index.hotspots.slice(0, 20).map((hotspot) => hotspot.path)
      ])],
      repositoryId: repository.index.repositoryId,
      // 「近期仓库变更」参考段的数据源：只进选择层 user 消息，不进缓存键
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
    // 空列表分两种：主动判空（declined）是可信答案、会进缓存；没调成或返回不合法不是
    if (!suggestion.entries.length) {
      return { entries: [], source: "module_files" as const, reason: `${suggestion.declined ? "没有合格入口，不硬凑" : "模型没给出可用入口"}；${fallback}。` };
    }
    return { entries: suggestion.entries, source: "llm" as const };
  } finally {
    repository.handle.unpin();
  }
});

/**
  架构视图的分层产物：层名与模块归层是判断题（light 档，可人工改），
  跨层箭头与「边界之外」那一栏是事实题，只由静态 import 与外部包名词典算，模型参与不了一个节点。
*/
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/architecture", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  /**
    读侧 provider 照给（缓存键里有 modelVersion，不给就退成 "none" ⇒ 判好的那份读不回来，画布会静默换成静态三层），
    但 `allowCall: false` 让它没有缓存行时也不发请求。这条路由因此不看预算：预算只管「重新生成分层」那一下。
    */
  const database = repository.handle.pin();
  try {
    const overlays = readOverlays(database, repository.index.repositoryId);
    const plan = await generateArchitectureCached({ ...architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays }), provider: lightLlm(), allowCall: false });
    // 读侧不发请求、没有用量，所以这里不写 token_usage
    return plan;
  } finally {
    repository.handle.unpin();
  }
});

// 显式重问一次分层（花钱，走预算闸门）：语义是「按模型的判断重来」，所以没配模型或达到预算上限就 422，不静默给静态三层。
app.post<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/architecture/regenerate", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  if (budgetDegraded(repository.handle)) return reply.code(422).send({ error: "本月预算已达到预算上限，未调用模型；重新生成分层这条路由不降级。" });
  const lightLlmProvider = lightLlm();
  if (!lightLlmProvider) return reply.code(422).send({ error: "未配置模型：重新生成分层需要模型判层名与归属。" });
  const database = repository.handle.pin();
  try {
    const overlays = readOverlays(database, repository.index.repositoryId);
    const plan = await generateArchitectureCached({ ...architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays }), provider: lightLlmProvider, force: true });
    if (plan.usage) new Journal(repository.path, repository.index.repositoryId).append("token_usage", { input_tokens: plan.usage.inputTokens, output_tokens: plan.usage.outputTokens, cache_hit_tokens: plan.usage.promptCacheHitTokens ?? null, provider: lightLlmProvider.modelVersion, scene: "architecture_map" });
    return plan;
  } finally {
    repository.handle.unpin();
  }
});

// 人工修正通道（覆盖层）：数组整份替换、字典按键合并、`remove` 按 key 显式撤。
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/overlays", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const database = repository.handle.pin();
  try {
    const overlays = readOverlays(database, repository.index.repositoryId);
    return { repositoryId: repository.index.repositoryId, overlays, counts: overlayCounts(overlays) };
  } finally {
    repository.handle.unpin();
  }
});

// 单条修正的落地：GUI 的「模块档位」下拉与 agent 的 `set_architecture` 共用 `applyOverrideIntent`，写同一份覆盖层、同一条审计、同一个通知。
app.post<{ Params: { repositoryId: string }; Body: { intent?: OverrideIntent; via?: OverrideVia } }>("/api/repositories/:repositoryId/overlays/apply", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const intent = request.body?.intent;
  if (!intent || typeof intent !== "object" || !("kind" in intent)) return reply.code(400).send({ error: "intent 缺失：要 move_module / rename_layer / set_tier / reset 之一（形状见 override-writer）" });
  const database = repository.handle.pin();
  try {
    const outcome = applyOverrideIntent(repository, database, intent, request.body?.via === "agent" ? "agent" : "gui");
    // 拒写时把引擎那句原话同时镜像到 `error`：GUI 的 fetch 封装只认非 2xx 的 error 字段
    return reply.code(outcome.ok ? 200 : 422).send(outcome.ok ? outcome : { ...outcome, error: outcome.text });
  } finally {
    repository.handle.unpin();
  }
});

app.post<{ Params: { repositoryId: string }; Body: OverlaysPatch & { remove?: { modules?: { tier?: string[]; renamed?: string[] }; architecture?: { moduleLayer?: string[] } } } }>("/api/repositories/:repositoryId/overlays", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const database = repository.handle.pin();
  try {
    const body = request.body ?? {};
    let overlays = body.remove ? removeOverlayKeys(database, repository.index.repositoryId, body.remove) : readOverlays(database, repository.index.repositoryId);
    if (body.modules || body.architecture) overlays = patchOverlays(database, repository.index.repositoryId, { modules: body.modules, architecture: body.architecture });
    // 回读一次再交出去：调用方要看到落盘之后的覆盖层，而不是自己发出去的那份意图
    const after = readOverlays(database, repository.index.repositoryId);
    return { repositoryId: repository.index.repositoryId, overlays: after ?? overlays, counts: overlayCounts(after ?? overlays) };
  } finally {
    repository.handle.unpin();
  }
});

// 宏观设计「流程视图」：按入口用 LLM 生成执行流程（静态调用链作为证据输入 + 降级视图）。
// 缓存命中零成本；未配置 LLM / 预算已达上限 / 调用失败都返回静态调用链并带 reason，不静默降级。
app.get<{ Params: { repositoryId: string }; Querystring: { entry?: string; readonly?: string } }>("/api/repositories/:repositoryId/flow", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const entries = repository.analysis.graph.entrypoints;
  const wanted = (request.query.entry ?? "").trim();
  // 入口识别是启发式（package.json 清单 + 约定文件名），识别不到或识别错时允许人工指定任意已索引文件作为起点
  const entry = resolveFlowEntry(wanted, entries, repository.index.files, repository.analysis.graph);
  if (!entry) {
    const reason = wanted
      ? "该路径不在仓库索引里，无法作为流程入口。"
      : "该仓库没有识别到执行入口，也未手动指定；请在流程视图里从文件清单中选择一个起点。";
    return reply.code(404).send({ error: reason });
  }
  // 流程生成走主力档：它是「看着整仓证据推断编排」的重任务，轻量档留给 L1 的文件级摘要，两者不共用一档
  const budgetExhausted = budgetDegraded(repository.handle);
  const provider = budgetExhausted ? undefined : teachingLlm();
  if (!provider) return degradedFlow(repository.analysis, entry, budgetExhausted ? "本月预算已达到预算上限，未调用主力档 LLM" : "未配置主力档 LLM");
  const database = repository.handle.pin();
  try {
    const summaries = latestFileSummaries(repository.handle);
    /**
      L1 摘要是「每文件最新一条」的有界读取（上限见 `LATEST_SUMMARY_LIMIT`），大仓上部分路径会静默缺席，
      从未摘要的文件也一样缺席，所以这条缺口要留一个读数。
      它刻意不进 flow 的 digest：进键就等于每改一次读取上限、每多一个文件没摘要，全仓流程缓存一起翻，
      而「证据少了几个文件」并不改变这条流程该说什么。
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
    const flowInput = {
      repositoryPath: repository.path,
      index: repository.index,
      analysis: repository.analysis,
      entry,
      provider,
      summaries,
      repositoryId: repository.index.repositoryId,
      database
    };
    // 只读出口（MCP 的 `repo_flow` 走这条）：命中缓存就交出产物，没缓存给静态调用链并说明原因。
    // 冷缓存的 `generateRepositoryFlowCached` 会发一趟主力档，外部 agent 问一句不该让账单多一笔——与架构那条 `allowCall: false` 同一口径。
    if (request.query.readonly === "1") {
      const peeked = peekCachedFlow(flowInput);
      const readonlyResult = peeked ?? degradedFlow(repository.analysis, entry, "只读请求：这条流程还没有已生成的产物。要拿到环节划分，得在界面里打开流程视图（那一下会发一趟主力档）。");
      return { flow: readonlyResult.flow, source: readonlyResult.source, ...(readonlyResult.reason ? { reason: readonlyResult.reason } : {}) };
    }
    const generated = await generateRepositoryFlowCached(flowInput);
    if (generated.usage) new Journal(repository.path, repository.index.repositoryId).append("token_usage", {
      input_tokens: generated.usage.inputTokens,
      output_tokens: generated.usage.outputTokens,
      cache_hit_tokens: generated.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "flow_map"
    });
    return { flow: generated.flow, source: generated.source, ...(generated.reason ? { reason: generated.reason } : {}) };
  } finally {
    repository.handle.unpin();
  }
});
}
