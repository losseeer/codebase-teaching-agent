import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleCourseOf } from "../../coursetree/architecture.js";
import { courseChildren, courseOverview, findCourseNode, flattenCourseTree } from "../../coursetree/projection.js";
import { graphFromData, impactRadius } from "../../depgraph/graph.js";
import { languageProfileOf } from "../../depgraph/language-profile.js";
import { deriveLearnerProfile } from "../../learner/model.js";
import { isWithin } from "../../source/files.js";
import { exercises, repositoryOr404 } from "../../services.js";
import { pathReadBlock } from "../../source/read-file.js";
import { readJournal } from "../../store/journal.js";
import { readOverlays } from "../../store/overlays.js";
import type { FastifyInstance } from "fastify";

/**
  仓库的只读产物路由：索引、课程树投影、分析读数、影响面、练习摘要、学习者画像、报告、源码。
  这一组一条纪律：一行模型请求都不发、一分钱都不花（对照 `read-routes-never-bill`）。
  付费的那几组各自在 architecture / exercises / chat / teaching 里。
 */
export function registerRepositoryReadRoutes(app: FastifyInstance): void {
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/index", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository?.index ?? reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/course", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  // 模块分级实时计算（主链路/基础设施/外围）：角色是结构规则的纯函数，已导入的仓库不用重跑分析就能看到分级
  const courseDatabase = repository.handle.pin();
  try {
    return moduleCourseOf(repository.course, repository.analysis, repository.index, readOverlays(courseDatabase, repository.index.repositoryId));
  } finally {
    repository.handle.unpin();
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

  挂在这条已有的只读路由上而不是新开一条：「这条边有多硬」必须和边本身同时到达，
  另开一条就会有两份时序与两处加载态。
  它是读侧实时计算的元数据：不进 `repository.analysis`（那是落库产物，也是 `backendStamp` 等缓存键的输入），
  只在响应里浅拷贝一次；输入是内存里的 `index.files`，不读磁盘、不调模型。

  引擎没有「重新分析」这条路由：挂载只读落库产物并报告新鲜度，所以结构规则改了之后，
  已导入的仓库仍用旧图回答。生效方式只有两条——重新导入，或等文件变动触发 watcher 重分析。
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

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/report", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库不在当前引擎会话中；请重新导入以恢复它。" });
  return {
    index: repository.index,
    estimate: repository.estimate,
    entrypoints: flattenCourseTree(repository.course.root).filter((node) => node.kind === "workflow").map((node) => ({ title: node.title, anchors: node.anchors })),
    analysis: { implementations: repository.analysis.implementations.length, semanticBackend: repository.analysis.graph.semanticBackend, lspStatus: repository.analysis.graph.lspStatus }
  };
});

/**
  源码查看（GUI 的源码面板与练习锚点用）。

  只放已索引的文件，不是「仓库里的任何文件」：`.env`、私钥这类密钥载体本来就不在索引扩展名白名单里，
  所以按索引集合放行等于借用同一份边界；裸 `readFileSync` 会绕过名单，
  让本机任意进程乃至任意打开的网页（CORS 全放开）读出被学习仓库里的密钥。
  GUI 的取参来源全是锚点 / 文件树，都在索引里，收紧不改变正常动线。
  */
app.get<{ Params: { repositoryId: string }; Querystring: { path?: string; line?: string } }>("/api/repositories/:repositoryId/source", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const requestedPath = request.query.path?.replaceAll("\\", "/");
  if (!repository || !requestedPath) return reply.code(404).send({ error: "未找到源码" });
  // 先判边界、再判收录：越界是「请求本身不合法」(400)，未收录是「这个文件不给」(404)，两种失败界面要能分开
  const absolute = join(repository.path, requestedPath);
  if (!isWithin(repository.path, absolute)) return reply.code(400).send({ error: "源码路径越出仓库边界" });
  // 名单 + 软链接那一关与 `read_file` 共用一份判据（`pathReadBlock`）：字面路径过了闸不代表链接目标过了闸
  const blocked = pathReadBlock(repository.path, requestedPath);
  if (blocked) return reply.code(404).send({ error: `该文件不开放读取：${blocked}` });
  if (!repository.index.files.some((file) => file.path === requestedPath)) return reply.code(404).send({ error: "该文件不在本仓索引里（未收录的类型与密钥/凭据文件不提供源码）" });
  // line 是给界面定位用的：非数字 / 负数按 1，NaN 序列化进 JSON 会变成 null
  const line = Number(request.query.line ?? 1);
  try { return { path: requestedPath, line: Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1, content: readFileSync(absolute, "utf8") }; }
  catch { return reply.code(404).send({ error: "无法读取该源码文件" }); }
});
}
