import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveLearnerProfile } from "../../learner/model.js";
import { isWithin } from "../../source/files.js";
import { exercises, REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../services.js";
import { MAX_FILE_BYTES, pathReadBlock } from "../../source/read-file.js";
import { readJournal } from "../../store/journal.js";
import type { FastifyInstance } from "fastify";

/**
  仓库的只读产物路由：索引、练习摘要、学习者画像、导入报告、源码。
  这一组一条纪律：一行模型请求都不发、一分钱都不花（对照 `read-routes-never-bill`）。
  付费的几组各自在 exercises / chat / teaching 里。
*/
export function registerRepositoryReadRoutes(app: FastifyInstance): void {
app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/index", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository?.index ?? reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/practice", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository ? exercises.getSummary(repository) : reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/learner", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  return repository
    ? deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path))
    : reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
});

app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/report", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  return { index: repository.index, estimate: repository.estimate };
});

/**
  源码查看（GUI 的源码面板与练习锚点用）。

  只放已索引的文件，不是「仓库里的任何文件」：`.env`、私钥这类密钥载体本来就不在索引扩展名白名单里，
  所以按索引集合放行等于借用同一份边界；裸 `readFileSync` 会绕过名单，让不带 Origin 的本机调用方
  （curl、别的本机进程）读出被学习仓库里的密钥——这一道没有认证闸，是已接受的代价。
  浏览器里的跨源请求受来源闸约束：非可信 Origin 当场 403，handler 一行都不跑（判据见 `security/origins.ts`）。
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
  try {
    const size = statSync(absolute).size;
    // 与模型侧 `read_file` 同一把尺：收录没有体积上限，超了就把数字说明白，不让「打开一个文件」把引擎拖死
    if (size > MAX_FILE_BYTES) return reply.code(413).send({ error: `文件 ${String(size)} 字节，超过 ${String(MAX_FILE_BYTES)} 字节上限，没有加载` });
    return { path: requestedPath, line: Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1, content: readFileSync(absolute, "utf8") };
  }
  catch { return reply.code(404).send({ error: "无法读取该源码文件" }); }
});
}
