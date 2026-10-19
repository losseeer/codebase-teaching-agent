import { budgetDegraded, latestFileSummaries } from "../../application/paid-turn.js";
import { suggestModuleEntriesCached } from "../../coursetree/entry-suggest.js";
import { lightLlm, repositoryOr404 } from "../../services.js";
import { Journal } from "../../store/journal.js";
import { type OverlaysPatch, overlayCounts, patchOverlays, readOverlays, removeOverlayKeys } from "../../store/overlays.js";
import type { FastifyInstance } from "fastify";

/**
  模块相关路由：推荐入口与人工覆盖层。
  这一组的口径是「缓存里存原判、覆盖层读时叠加、读侧永不发请求」；
  推荐入口是这组里唯一会花钱的路径，未配置模型 / 预算已达上限时返回空列表并说明原因。
*/
export function registerModuleRoutes(app: FastifyInstance): void {
// 教学模块「推荐入口」：LLM 从课程树候选节点中挑选（单轮调用）；未配置 LLM / 预算已达上限时返回空列表，GUI 回落关键词分类
app.get<{ Params: { repositoryId: string }; Querystring: { module?: string; hint?: string } }>("/api/repositories/:repositoryId/module-entries", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const moduleLabel = (request.query.module ?? "").trim();
  if (!moduleLabel) return reply.code(400).send({ error: "请提供模块名称" });
  const budgetExhausted = budgetDegraded(repository.handle);
  const provider = budgetExhausted ? undefined : lightLlm();
  // 「未配置」与「达到预算上限」分开报：处置不同，不让界面猜
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

// 覆盖层读：GUI 的旧值迁移与调试用；读侧不发请求、不花钱。
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

// 覆盖层写：浏览器本地旧值的一次性迁移。Agent 的 `set_module_tier` 走 `applyModuleTierIntent`，
// 不经过 HTTP；两条路径共用 `commitOverride` / `patchOverlays` 的合并口径。
app.post<{ Params: { repositoryId: string }; Body: OverlaysPatch & { remove?: { modules?: { tier?: string[]; renamed?: string[] } } } }>("/api/repositories/:repositoryId/overlays", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  const database = repository.handle.pin();
  try {
    const body = request.body ?? {};
    let overlays = body.remove ? removeOverlayKeys(database, repository.index.repositoryId, body.remove) : readOverlays(database, repository.index.repositoryId);
    if (body.modules) overlays = patchOverlays(database, repository.index.repositoryId, { modules: body.modules });
    // 回读一次再交出去：调用方要看到的是**落盘之后**的覆盖层，而不是自己发出去的那份意图
    const after = readOverlays(database, repository.index.repositoryId);
    return { repositoryId: repository.index.repositoryId, overlays: after ?? overlays, counts: overlayCounts(after ?? overlays) };
  } finally {
    repository.handle.unpin();
  }
});
}
