import type { FastifyInstance, FastifyReply } from "fastify";
import { REPOSITORY_NOT_MOUNTED } from "../../../../services.js";
import { createDiagramUseCase, deleteDiagramUseCase, listDiagramsUseCase, readDiagramUseCase, renameDiagramUseCase, restoreDiagramUseCase, saveGeometryUseCase, type DiagramFailure } from "../../../../application/use-case/diagrams.js";

/**
  画布这组路由的入站翻译：注册在根实例上，所以懒挂载钩子与来源闸照常生效。
  这里只做两件事——把请求体收成用例要的形状（`positions` 的逐项取形、`index` 是不是整数），
  再把用例报回来的失败种类一对一翻成状态码与文案。谁该拒、拒几次、记不记审计，全在 `application/use-case/diagrams.ts`。
  */
const rejected = (reply: FastifyReply, failure: DiagramFailure): FastifyReply => {
  switch (failure.kind) {
    case "repository-missing": return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
    case "diagram-missing": return reply.code(404).send({ error: "这张图已经不在了。", reason: "diagram_not_found" });
    case "name-taken": return reply.code(400).send({ error: `图库里已经有「${failure.name}」这张图：两张同名会让「改那张」这句话没有答案，先换一个名字`, reason: "name_taken" });
    case "name-unchanged": return reply.code(400).send({ error: `这张图已经叫「${failure.name}」了：收完空白一个字都没变，所以这一笔不写`, reason: "name_unchanged" });
    case "name-empty": return reply.code(400).send({ error: "图名收完空白就没了：至少留一个字（图库与 agent 都靠名字认图）", reason: "name_empty" });
    case "version-missing": return reply.code(400).send({ error: `这张图没有第 ${failure.index} 版：现在一共 ${failure.total} 版（下标 0 起）`, reason: "version_missing" });
  }
};

export function registerDiagramRoutes(app: FastifyInstance): void {
  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/diagrams", async (request, reply) => {
    const result = listDiagramsUseCase(request.params.repositoryId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.post<{ Params: { repositoryId: string }; Body: { name?: unknown } }>("/api/repositories/:repositoryId/diagrams", async (request, reply) => {
    const result = createDiagramUseCase(request.params.repositoryId, typeof request.body?.name === "string" ? request.body.name : undefined);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.get<{ Params: { repositoryId: string; diagramId: string } }>("/api/repositories/:repositoryId/diagrams/:diagramId", async (request, reply) => {
    const result = readDiagramUseCase(request.params.repositoryId, request.params.diagramId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.patch<{ Params: { repositoryId: string; diagramId: string }; Body: { name?: unknown } }>("/api/repositories/:repositoryId/diagrams/:diagramId", async (request, reply) => {
    const result = renameDiagramUseCase(request.params.repositoryId, request.params.diagramId, typeof request.body?.name === "string" ? request.body.name : "");
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.delete<{ Params: { repositoryId: string; diagramId: string } }>("/api/repositories/:repositoryId/diagrams/:diagramId", async (request, reply) => {
    const result = deleteDiagramUseCase(request.params.repositoryId, request.params.diagramId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.put<{ Params: { repositoryId: string; diagramId: string }; Body: { positions?: unknown } }>("/api/repositories/:repositoryId/diagrams/:diagramId/geometry", async (request, reply) => {
    const raw = request.body?.positions;
    if (!Array.isArray(raw)) return reply.code(400).send({ error: "positions 要是一个数组：[{ id, x, y }]，只给节点 id 与它的新位置" });
    const positions = raw.flatMap((item): { id: string; x: number; y: number }[] => {
      const entry = item as { id?: unknown; x?: unknown; y?: unknown };
      return typeof entry?.id === "string" && typeof entry.x === "number" && typeof entry.y === "number" ? [{ id: entry.id, x: entry.x, y: entry.y }] : [];
    });
    const result = saveGeometryUseCase(request.params.repositoryId, request.params.diagramId, positions);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.post<{ Params: { repositoryId: string; diagramId: string }; Body: { index?: unknown } }>("/api/repositories/:repositoryId/diagrams/:diagramId/restore", async (request, reply) => {
    const index = request.body?.index;
    if (typeof index !== "number" || !Number.isInteger(index)) return reply.code(400).send({ error: "index 要是一个整数（版本清单的下标，0 起）" });
    const result = restoreDiagramUseCase(request.params.repositoryId, request.params.diagramId, index);
    return result.ok ? result.value : rejected(reply, result.failure);
  });
}
