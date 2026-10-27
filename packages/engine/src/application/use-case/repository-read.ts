import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveLearnerProfile } from "../../learner/model.js";
import { isWithin } from "@codebase-tutor/platform";
import { exercises, repositoryOr404 } from "../../infrastructure/composition-root.js";
import { practiceView, withExercisePorts } from "../../infrastructure/exercise-ports.js";
import { MAX_FILE_BYTES, pathReadBlock } from "../../source/read-file.js";

/**
  仓库只读产物的用例：索引、练习摘要、学习者画像、导入报告、源码。
  一组一条纪律：一行模型请求都不发、一分钱都不花（对照 `read-routes-never-bill`）。付费的几组各自在 exercises / chat / teaching 里。

  源码查看的放行顺序不能换：先判边界（请求本身不合法）、再判名单与软链接、再判是否收录、最后才看体积。
  只放已索引的文件，不是「仓库里的任何文件」：`.env`、私钥这类载体本来就不在索引扩展名白名单里，
  按索引集合放行等于借用同一份边界；裸 `readFileSync` 会绕过名单，让不带 Origin 的本机调用方
  读出被学习仓库里的密钥——这一道没有认证闸，是已接受的代价。
  浏览器里的跨源请求受来源闸约束：非可信 Origin 当场 403，用例一行都不跑（判据见 `security/origins.ts`）。
  */
export type ReadFailure =
  | { kind: "repository-missing" }
  | { kind: "source-not-found" }
  | { kind: "source-out-of-bounds" }
  | { kind: "source-blocked"; reason: string }
  | { kind: "source-not-indexed" }
  | { kind: "source-too-big"; size: number }
  | { kind: "source-unreadable" };

export type ReadResult<T> = { ok: true; value: T } | { ok: false; failure: ReadFailure };

const repositoryMissing: ReadResult<never> = { ok: false, failure: { kind: "repository-missing" } };

/** 索引：文件树、符号、热点那一份，界面左栏与「本仓有什么」都读它。 */
export function readIndexUseCase(repositoryId: string): ReadResult<NonNullable<ReturnType<typeof repositoryOr404>>["index"]> {
  const repository = repositoryOr404(repositoryId);
  return repository ? { ok: true, value: repository.index } : repositoryMissing;
}

/** 练习摘要：进度、到期复习与可用题型。库在这一层开合，所以读侧也是异步的（路由本来就是 async handler）。 */
export async function readPracticeSummaryUseCase(repositoryId: string): Promise<ReadResult<ReturnType<typeof exercises.getSummary>>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return repositoryMissing;
  return { ok: true, value: await withExercisePorts(repository.handle, (ports) => exercises.getSummary(practiceView(repository, ports))) };
}

/** 学习者画像：从 journal 事件回放出的掌握度、支架退场状态与推荐设置。 */
export function readLearnerProfileUseCase(repositoryId: string): ReadResult<ReturnType<typeof deriveLearnerProfile>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return repositoryMissing;
  return { ok: true, value: deriveLearnerProfile(repository.index.repositoryId, repository.audit.read()) };
}

/** 导入报告：索引结果加上当初那份导入预估。 */
export function readImportReportUseCase(repositoryId: string): ReadResult<{ index: NonNullable<ReturnType<typeof repositoryOr404>>["index"]; estimate: NonNullable<ReturnType<typeof repositoryOr404>>["estimate"] }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return repositoryMissing;
  return { ok: true, value: { index: repository.index, estimate: repository.estimate } };
}

export interface SourceFile {
  path: string;
  /** 给界面定位的行号：非数字 / 负数按 1（NaN 序列化进 JSON 会变成 null） */
  line: number;
  content: string;
}

export function readSourceFileUseCase(repositoryId: string, requestedPath: string | undefined, requestedLine: string | number | undefined): ReadResult<SourceFile> {
  const repository = repositoryOr404(repositoryId);
  const relative = requestedPath?.replaceAll("\\", "/");
  if (!repository || !relative) return { ok: false, failure: { kind: "source-not-found" } };
  const absolute = join(repository.path, relative);
  if (!isWithin(repository.path, absolute)) return { ok: false, failure: { kind: "source-out-of-bounds" } };
  // 名单 + 软链接那一关与模型侧 `read_file` 共用一份判据：字面路径过了闸不代表链接目标过了闸
  const blocked = pathReadBlock(repository.path, relative);
  if (blocked) return { ok: false, failure: { kind: "source-blocked", reason: blocked } };
  if (!repository.index.files.some((file) => file.path === relative)) return { ok: false, failure: { kind: "source-not-indexed" } };
  const line = Number(requestedLine ?? 1);
  try {
    const size = statSync(absolute).size;
    // 与模型侧 `read_file` 同一把尺：收录没有体积上限，超了就把数字说明白，不让「打开一个文件」把引擎拖死
    if (size > MAX_FILE_BYTES) return { ok: false, failure: { kind: "source-too-big", size } };
    return { ok: true, value: { path: relative, line: Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1, content: readFileSync(absolute, "utf8") } };
  } catch {
    return { ok: false, failure: { kind: "source-unreadable" } };
  }
}
