import { importer } from "../../services.js";

/**
  仓库生命周期与导入任务的用例：地址簿清单、显式挂载、移出、编辑期免打扰开关、提交与查询导入任务。

  免打扰三条口径（原样搬，别在传输层另写一份）：
  - 挂起不丢东西：产物与内存照用，只是磁盘改动不再自动重分析；恢复时重算一次新鲜度，
    脏了由界面横幅如实说，要不要重跑仍由人点（引擎不自动重分析）。
  - 挂起活过驱逐与重新挂载：登记在 `ImportService` 里，LRU 把仓挤出去再点回来时开关仍然有效。
  - 到点自动恢复（默认 30 分钟，限死在 1 分钟~6 小时）。
  */
export type RepositoryFailure =
  | { kind: "not-mounted"; message: string; reason: unknown }
  | { kind: "import-rejected"; message: string }
  | { kind: "job-missing" };

export type RepositoryResult<T> = { ok: true; value: T } | { ok: false; failure: RepositoryFailure };

/** 地址簿清单（不读产物）：界面仓库切换器的数据源。 */
export function listCatalogUseCase() {
  return { repositories: importer.catalog() };
}

/** 显式挂载一个仓库并回报新鲜度：界面切换仓库时调它，好把「这份分析有多旧」说在打开之前。 */
export function mountRepositoryUseCase(repositoryId: string): RepositoryResult<{ repositoryId: string; repositoryPath: string; freshness: unknown }> {
  const result = importer.ensureMounted(repositoryId);
  if (!result.ok) return { ok: false, failure: { kind: "not-mounted", message: result.message, reason: result.reason } };
  return { ok: true, value: { repositoryId: result.repository.index.repositoryId, repositoryPath: result.repository.path, freshness: result.repository.freshness } };
}

/** 把某仓移出地址簿（并就地卸载）。默认只动引擎的注册表；`withArtifacts` 才连该仓 `.tutor/` 里的分析产物、对话记录与运行日志一起删。 */
export function forgetRepositoryUseCase(repositoryId: string, withArtifacts: boolean) {
  return { repositories: importer.catalog(), ...importer.forget(repositoryId, withArtifacts) };
}

/** 挂起或恢复某仓的 fs 增量监听。`paused` 缺省即挂起——调用这条接口就是来关监听的，不是来问状态的。 */
export function setWatchingUseCase(repositoryId: string, paused: boolean, ttlMs?: number) {
  if (!paused) return { repositoryId, paused: false, woken: importer.resumeWatching(repositoryId).woken, watching: importer.getRepository(repositoryId)?.watch ?? null };
  const result = importer.pauseWatching(repositoryId, ttlMs);
  return { repositoryId, paused: true, until: new Date(result.until).toISOString(), watching: false };
}

/** 提交一次导入任务（异步：202 收单，进度靠 `getImportJobUseCase` 轮询）。 */
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
