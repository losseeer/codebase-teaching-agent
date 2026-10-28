import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveLearnerProfile } from "../../learner/model.js";
import { isWithin } from "@codebase-tutor/platform";
import { exercises, repositoryOr404 } from "../../infrastructure/composition-root.js";
import { practiceView, withExercisePorts } from "../../infrastructure/exercise-ports.js";
import { MAX_FILE_BYTES, pathReadBlock } from "../../source/read-file.js";

/**
  仓库只读产物的用例：索引、练习摘要、学习者画像、导入报告、源码；不发模型请求。
  源码查看的顺序固定：边界 → 名单与软链接 → 是否收录 → 体积；只放已索引的文件。
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

/** 索引：文件树、符号、热点。 */
export function readIndexUseCase(repositoryId: string): ReadResult<NonNullable<ReturnType<typeof repositoryOr404>>["index"]> {
  const repository = repositoryOr404(repositoryId);
  return repository ? { ok: true, value: repository.index } : repositoryMissing;
}

/** 练习摘要：进度、到期复习与可用题型；库在这一层开合。 */
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

/** 导入报告：索引结果加导入预估。 */
export function readImportReportUseCase(repositoryId: string): ReadResult<{ index: NonNullable<ReturnType<typeof repositoryOr404>>["index"]; estimate: NonNullable<ReturnType<typeof repositoryOr404>>["estimate"] }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return repositoryMissing;
  return { ok: true, value: { index: repository.index, estimate: repository.estimate } };
}

export interface SourceFile {
  path: string;
  /** 定位用的行号：非数字或负数按 1。 */
  line: number;
  content: string;
}

export function readSourceFileUseCase(repositoryId: string, requestedPath: string | undefined, requestedLine: string | number | undefined): ReadResult<SourceFile> {
  const repository = repositoryOr404(repositoryId);
  const relative = requestedPath?.replaceAll("\\", "/");
  if (!repository || !relative) return { ok: false, failure: { kind: "source-not-found" } };
  const absolute = join(repository.path, relative);
  if (!isWithin(repository.path, absolute)) return { ok: false, failure: { kind: "source-out-of-bounds" } };
  // 名单与软链接这一关与模型侧 `read_file` 共用一份判据。
  const blocked = pathReadBlock(repository.path, relative);
  if (blocked) return { ok: false, failure: { kind: "source-blocked", reason: blocked } };
  if (!repository.index.files.some((file) => file.path === relative)) return { ok: false, failure: { kind: "source-not-indexed" } };
  const line = Number(requestedLine ?? 1);
  try {
    const size = statSync(absolute).size;
    // 体积上限与模型侧 `read_file` 共用 `MAX_FILE_BYTES`。
    if (size > MAX_FILE_BYTES) return { ok: false, failure: { kind: "source-too-big", size } };
    return { ok: true, value: { path: relative, line: Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1, content: readFileSync(absolute, "utf8") } };
  } catch {
    return { ok: false, failure: { kind: "source-unreadable" } };
  }
}
