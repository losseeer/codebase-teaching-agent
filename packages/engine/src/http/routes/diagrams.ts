import type { FastifyInstance, FastifyReply } from "fastify";
import { broadcast } from "../../events.js";
import { diagramFilesByNode, diagramWarnings } from "../../diagram/set-diagram.js";
import { diagramWriteContextFor } from "../../application/canvas-tools.js";
import { createBlankDiagram, deleteDiagram, listDiagrams, normalizeDiagramName, readDiagram, renameDiagram, restoreVersion, saveGeometry } from "../../store/diagrams.js";
import { Journal } from "../../store/journal.js";
import { REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../services.js";

/**
  画布那组路由：图库、单张图、改名、删、恢复、几何。注册在根实例上，所以懒挂载钩子与来源闸照常生效。
  */
export function registerDiagramRoutes(app: FastifyInstance): void {
/**
  图是产物实体，不是某一页的渲染结果：一个仓可以有很多张，住在 `diagram` 表里。
  这一组路由的权限划分分得很开：

  - 几何（`PUT .../geometry`）：位置不承载对错，所以不存版本、不写审计、不广播——
    拖动频次高，进任何一条记录线都会淹掉真信号，广播那一帧还会抢鼠标；
  - 结构（加删节点、连线、分组）：界面对结构只能读，写只能经 agent 的 `set_diagram` 一个入口
    （`diagram/set-diagram.ts`），避免两条写路径各写一套校验与记账。

  建、改名、删、恢复动的是这张图这个实体而不是它的结构，所以由界面直发，各自记一行审计、广播一帧。
  读侧全是纯读：没有任何一步会发模型请求（`diagramWarnings` / `diagramFilesByNode` 只比对索引与依赖图）。
*/

/** 图不存在：`reason` 是机器码，供日志与排障对账；界面目前只展示那句中文，没按它分岔。 */
function diagramNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "这张图已经不在了。", reason: "diagram_not_found" });
}

/** 图库列表：只回摘要，不拖整张图的结构进左栏。 */
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/diagrams", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const database = repository.handle.pin();
  try {
    return { diagrams: listDiagrams(database, repository.index.repositoryId) };
  } finally {
    repository.handle.unpin();
  }
});

/** 新建一张空白图：名字撞了由 `uniqueDiagramName` 加序号——图库与 agent 都靠名字认图，不允许两张同名。 */
app.post<{ Params: { repositoryId: string }; Body: { name?: unknown } }>("/api/repositories/:repositoryId/diagrams", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const database = repository.handle.pin();
  try {
    const diagram = createBlankDiagram(database, repository.index.repositoryId, typeof request.body?.name === "string" ? request.body.name : undefined);
    new Journal(repository.path, repository.index.repositoryId).append("diagram_created", {
      diagram: diagram.id, name: diagram.name, source: diagram.source, nodes: diagram.body.nodes.length, edges: diagram.body.edges.length, downgraded: 0, via: "user"
    });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: diagram.id, action: "created" } });
    return { diagram };
  } finally {
    repository.handle.unpin();
  }
});

/** 单张图 + 读侧的引用复检：图上的模块节点还指得着现在的索引吗（图是历史产物，文件会改名、目录会删）。 */
app.get<{ Params: { repositoryId: string; diagramId: string } }>("/api/repositories/:repositoryId/diagrams/:diagramId", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const database = repository.handle.pin();
  try {
    const diagram = readDiagram(database, repository.index.repositoryId, request.params.diagramId);
    if (!diagram) return diagramNotFound(reply);
    const context = diagramWriteContextFor(repository, database);
    return { diagram, warnings: diagramWarnings(context, diagram), filesByNode: diagramFilesByNode(context, diagram) };
  } finally {
    repository.handle.unpin();
  }
});

/**
  改名：不存版本（它不动结构）。两条 400 分开给——「一个字都没改」与「图库里已经有这个名字」处置不同。
*/
app.patch<{ Params: { repositoryId: string; diagramId: string }; Body: { name?: unknown } }>("/api/repositories/:repositoryId/diagrams/:diagramId", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const raw = typeof request.body?.name === "string" ? request.body.name : "";
  const database = repository.handle.pin();
  try {
    const diagram = readDiagram(database, repository.index.repositoryId, request.params.diagramId);
    if (!diagram) return diagramNotFound(reply);
    const wanted = normalizeDiagramName(raw);
    if (wanted && listDiagrams(database, repository.index.repositoryId).some((item) => item.id !== diagram.id && item.name === wanted)) {
      return reply.code(400).send({ error: `图库里已经有「${wanted}」这张图：两张同名会让「改那张」这句话没有答案，先换一个名字`, reason: "name_taken" });
    }
    const renamed = renameDiagram(database, diagram, raw);
    if (!renamed) {
      return reply.code(400).send({
        error: wanted ? `这张图已经叫「${diagram.name}」了：收完空白一个字都没变，所以这一笔不写` : "图名收完空白就没了：至少留一个字（图库与 agent 都靠名字认图）",
        reason: wanted ? "name_unchanged" : "name_empty"
      });
    }
    new Journal(repository.path, repository.index.repositoryId).append("diagram_renamed", { diagram: renamed.id, from: diagram.name, to: renamed.name });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: renamed.id, action: "renamed" } });
    return { diagram: renamed };
  } finally {
    repository.handle.unpin();
  }
});

/** 删掉一张图：版本历史一起没，所以这一行审计要留得住名字与版数。 */
app.delete<{ Params: { repositoryId: string; diagramId: string } }>("/api/repositories/:repositoryId/diagrams/:diagramId", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const database = repository.handle.pin();
  try {
    const diagram = readDiagram(database, repository.index.repositoryId, request.params.diagramId);
    if (!diagram) return diagramNotFound(reply);
    deleteDiagram(database, diagram);
    new Journal(repository.path, repository.index.repositoryId).append("diagram_deleted", { diagram: diagram.id, name: diagram.name, versions: diagram.versions.length });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: diagram.id, action: "deleted" } });
    return { deleted: true, diagramId: diagram.id };
  } finally {
    repository.handle.unpin();
  }
});

/**
  几何落盘：认不出来的节点 id 由 `saveGeometry` 一个个跳过（图上没有的东西不该因为一次陈旧拖拽被造出来），
  所以这里不为「有几个 id 没落上」而拒。
*/
app.put<{ Params: { repositoryId: string; diagramId: string }; Body: { positions?: unknown } }>("/api/repositories/:repositoryId/diagrams/:diagramId/geometry", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const raw = request.body?.positions;
  if (!Array.isArray(raw)) return reply.code(400).send({ error: "positions 要是一个数组：[{ id, x, y }]，只给节点 id 与它的新位置" });
  const positions = raw.flatMap((item): { id: string; x: number; y: number }[] => {
    const entry = item as { id?: unknown; x?: unknown; y?: unknown };
    return typeof entry?.id === "string" && typeof entry.x === "number" && typeof entry.y === "number" ? [{ id: entry.id, x: entry.x, y: entry.y }] : [];
  });
  const database = repository.handle.pin();
  try {
    const diagram = readDiagram(database, repository.index.repositoryId, request.params.diagramId);
    if (!diagram) return diagramNotFound(reply);
    return { diagram: saveGeometry(database, diagram, positions) };
  } finally {
    repository.handle.unpin();
  }
});

/** 恢复某一版：恢复动作本身也存一版（为什么不能截断历史见 `store/diagrams.ts` 的 `restoreVersion`）。 */
app.post<{ Params: { repositoryId: string; diagramId: string }; Body: { index?: unknown } }>("/api/repositories/:repositoryId/diagrams/:diagramId/restore", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const index = request.body?.index;
  if (typeof index !== "number" || !Number.isInteger(index)) return reply.code(400).send({ error: "index 要是一个整数（版本清单的下标，0 起）" });
  const database = repository.handle.pin();
  try {
    const diagram = readDiagram(database, repository.index.repositoryId, request.params.diagramId);
    if (!diagram) return diagramNotFound(reply);
    const restored = restoreVersion(database, diagram, index);
    if (!restored) return reply.code(400).send({ error: `这张图没有第 ${index} 版：现在一共 ${diagram.versions.length} 版（下标 0 起）`, reason: "version_missing" });
    new Journal(repository.path, repository.index.repositoryId).append("diagram_restored", { diagram: restored.id, to: index, note: restored.versions[restored.versions.length - 1]?.note ?? "" });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: restored.id, action: "restored" } });
    return { diagram: restored };
  } finally {
    repository.handle.unpin();
  }
});
}
