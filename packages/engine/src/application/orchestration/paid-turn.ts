import { budgetExceeded, defaultMonthlyBudgetUsd } from "../../cost/cost.js";
import { LATEST_SUMMARY_LIMIT } from "../../adapter/outbound/persistence/summary-repository.js";
import type { RepositoryHandle } from "../../adapter/outbound/persistence/repository-handle.js";
import { buildSearchCorpus, type SearchCorpus } from "../../source/search-code.js";
import type { ImportedRepository } from "../../importer/importer.js";

/** 一次付费回合的发起条件与输入：每仓设置、预算闸、检索语料；与 HTTP 无关。 */

/** 每仓可持久化的设置形态（settings_json 的子集）；内部键读写都须保留。 */
export interface RepositorySettingsPayload {
  monthlyBudgetUsd: number;
}

export function readRepositorySettings(handle: RepositoryHandle): RepositorySettingsPayload {
  // 复用挂载句柄，不新开连接。
  const database = handle.pin();
  try {
    const settings = database.state.settings<{ monthlyBudgetUsd?: number }>(handle.repositoryId);
    return {
      monthlyBudgetUsd: typeof settings?.monthlyBudgetUsd === "number" && settings.monthlyBudgetUsd >= 0 ? settings.monthlyBudgetUsd : defaultMonthlyBudgetUsd
    };
  } finally {
    handle.unpin();
  }
}

/** 付费闸门：给出额度与 `degraded`；`degraded` 时调用方用 `undefined` provider。 */
export function budgetGate(handle: RepositoryHandle): { monthlyBudgetUsd: number; degraded: boolean } {
  const monthlyBudgetUsd = readRepositorySettings(handle).monthlyBudgetUsd;
  return { monthlyBudgetUsd, degraded: budgetExceeded(handle.repositoryPath, monthlyBudgetUsd) };
}

export function budgetDegraded(handle: RepositoryHandle): boolean {
  return budgetGate(handle).degraded;
}

/** 回合内的预算复查：每个工具轮一次，到线返回给模型看的停轮说明。 */
export function turnBudgetGuard(handle: RepositoryHandle): () => string | undefined {
  const { monthlyBudgetUsd } = readRepositorySettings(handle);
  return () => (budgetExceeded(handle.repositoryPath, monthlyBudgetUsd) ? `本仓库本月预算（${monthlyBudgetUsd}）已经用完，这是本次对话的最后一趟调用。` : undefined);
}

/** L1 摘要表 → `path → 一句摘要`；复用挂载句柄。 */
export function latestFileSummaries(handle: RepositoryHandle): Map<string, string> {
  const database = handle.pin();
  try {
    const rows = database.summaries.latest(LATEST_SUMMARY_LIMIT);
    if (rows.length >= LATEST_SUMMARY_LIMIT) console.warn(`[engine] ${handle.repositoryPath} 的摘要行数达到读取上限 ${LATEST_SUMMARY_LIMIT}，超出的旧路径本次没有摘要可用（流程证据与检索语料会缺这些文件）`);
    return new Map(rows.map((row) => [row.path, row.summary]));
  } finally {
    handle.unpin();
  }
}

/** search_code 语料：已分析路径 + 图符号表 + L1 摘要；每次请求现建。 */
export function searchCorpusFor(repository: ImportedRepository): SearchCorpus {
  return buildSearchCorpus(repository.index, repository.analysis, latestFileSummaries(repository.handle));
}
