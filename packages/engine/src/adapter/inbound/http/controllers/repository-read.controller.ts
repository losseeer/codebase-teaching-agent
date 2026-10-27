import { REPOSITORY_NOT_MOUNTED } from "../../../../infrastructure/composition-root.js";
import { MAX_FILE_BYTES } from "../../../../source/read-file.js";
import { readIndexUseCase, readImportReportUseCase, readLearnerProfileUseCase, readPracticeSummaryUseCase, readSourceFileUseCase, type ReadFailure } from "../../../../application/use-case/repository-read.js";
import type { FastifyReply } from "fastify";
import type { FastifyInstance } from "fastify";

/**
  仓库只读产物的入站翻译：索引、练习摘要、学习者画像、导入报告、源码。
  放行顺序、名单判据、体积上限这些都在 `application/use-case/repository-read.ts`；
  这里只把失败种类翻成状态码——越界是 400（请求本身不合法），不给读与读不到是 404，超体积是 413。
  */
const rejected = (reply: FastifyReply, failure: ReadFailure): FastifyReply => {
  switch (failure.kind) {
    case "repository-missing": return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
    case "source-not-found": return reply.code(404).send({ error: "未找到源码" });
    case "source-out-of-bounds": return reply.code(400).send({ error: "源码路径越出仓库边界" });
    case "source-blocked": return reply.code(404).send({ error: `该文件不开放读取：${failure.reason}` });
    case "source-not-indexed": return reply.code(404).send({ error: "该文件不在本仓索引里（未收录的类型与密钥/凭据文件不提供源码）" });
    case "source-too-big": return reply.code(413).send({ error: `文件 ${String(failure.size)} 字节，超过 ${String(MAX_FILE_BYTES)} 字节上限，没有加载` });
    case "source-unreadable": return reply.code(404).send({ error: "无法读取该源码文件" });
  }
};

export function registerRepositoryReadRoutes(app: FastifyInstance): void {
  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/index", async (request, reply) => {
    const result = readIndexUseCase(request.params.repositoryId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/practice", async (request, reply) => {
    const result = await readPracticeSummaryUseCase(request.params.repositoryId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/learner", async (request, reply) => {
    const result = readLearnerProfileUseCase(request.params.repositoryId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/report", async (request, reply) => {
    const result = readImportReportUseCase(request.params.repositoryId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.get<{ Params: { repositoryId: string }; Querystring: { path?: string; line?: string } }>("/api/repositories/:repositoryId/source", async (request, reply) => {
    const result = readSourceFileUseCase(request.params.repositoryId, request.query.path, request.query.line);
    return result.ok ? result.value : rejected(reply, result.failure);
  });
}
