import { importer } from "../../infrastructure/composition-root.js";

/**
  仓库生命周期与导入任务的用例：地址簿清单、挂载、移出、增量监听开关、提交与查询导入任务。
  挂起期间产物与内存照用，磁盘改动不再自动重分析；恢复时重算新鲜度，是否重跑由人点。
  挂起登记在 `importer/importer.ts`，活过 LRU 驱逐与重新挂载；到点自动恢复（默认 30 分钟，上限 6 小时）。
*/
export type RepositoryFailure =
  | { kind: "not-mounted"; message: string; reason: unknown }
  | { kind: "import-rejected"; message: string }
  | { kind: "job-missing" };

export type RepositoryResult<T> = { ok: true; value: T } | { ok: false; failure: RepositoryFailure };

/** 地址簿清单（不读产物）。 */
export function listCatalogUseCase() {
  return { repositories: importer.catalog() };
}

/** 显式挂载一个仓库，返回新鲜度读数。 */
export function mountRepositoryUseCase(repositoryId: string): RepositoryResult<{ repositoryId: string; repositoryPath: string; freshness: unknown }> {
  const result = importer.ensureMounted(repositoryId);
  if (!result.ok) return { ok: false, failure: { kind: "not-mounted", message: result.message, reason: result.reason } };
  return { ok: true, value: { repositoryId: result.repository.index.repositoryId, repositoryPath: result.repository.path, freshness: result.repository.freshness } };
}

/** 把某仓移出地址簿并就地卸载；`withArtifacts` 才连 `.tutor/` 里的产物一起删。 */
export function forgetRepositoryUseCase(repositoryId: string, withArtifacts: boolean) {
  return { repositories: importer.catalog(), ...importer.forget(repositoryId, withArtifacts) };
}

/** 挂起或恢复某仓的增量监听；`paused` 为假即恢复。 */
export function setWatchingUseCase(repositoryId: string, paused: boolean, ttlMs?: number) {
  if (!paused) return { repositoryId, paused: false, woken: importer.resumeWatching(repositoryId).woken, watching: importer.getRepository(repositoryId)?.watch ?? null };
  const result = importer.pauseWatching(repositoryId, ttlMs);
  return { repositoryId, paused: true, until: new Date(result.until).toISOString(), watching: false };
}

/** 提交一次导入任务（异步）；进度用 `getImportJobUseCase` 查。 */
export function submitImportUseCase(path: string, summaryHeaderComments?: boolean): RepositoryResult<ReturnType<typeof importer.submit>> {
  try {
    return { ok: true, value: importer.submit(path, typeof summaryHeaderComments === "boolean" ? summaryHeaderComments : undefined) };
  } catch (error) {
    return { ok: false, failure: { kind: "import-rejected", message: error instanceof Error ? error.message : "无法提交导入任务" } };
  }
}

export function getImportJobUseCase(jobId: string): RepositoryResult<NonNullable<ReturnType<typeof importer.getJob>>> {
  const job = importer.getJob(jobId);
  return job ? { ok: true, value: job } : { ok: false, failure: { kind: "job-missing" } };
}
