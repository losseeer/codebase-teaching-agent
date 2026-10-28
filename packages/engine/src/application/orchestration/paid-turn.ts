import { budgetExceeded, defaultMonthlyBudgetUsd } from "../../cost/cost.js";
import { formatSeamReport, seamReportFor } from "../../seams/seams.js";
import { LATEST_SUMMARY_LIMIT } from "../../adapter/outbound/persistence/summary-repository.js";
import type { RepositoryHandle } from "../../adapter/outbound/persistence/repository-handle.js";
import { buildSearchCorpus, type SearchCorpus } from "../../source/search-code.js";
import type { CrossRepoContext } from "../../source/tool-loop.js";
import type { ImportedRepository } from "../../importer/importer.js";
import { importer } from "../../infrastructure/composition-root.js";

/** 一次付费回合的发起条件与输入：每仓设置、预算闸、检索语料、跨仓上下文；与 HTTP 无关。 */

/** 每仓可持久化的设置形态（settings_json 的子集）；内部键读写都须保留。 */
export interface RepositorySettingsPayload {
  monthlyBudgetUsd: number;
}

export function readRepositorySettings(handle: RepositoryHandle): RepositorySettingsPayload {
  // 借用挂载句柄而不是再开一份：新开连接会重跑 migrate。
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

/** 付费分支的统一闸门：`degraded` 时传 `undefined` provider；`monthlyBudgetUsd` 一起交出，消费方不再读设置。 */
export function budgetGate(handle: RepositoryHandle): { monthlyBudgetUsd: number; degraded: boolean } {
  const monthlyBudgetUsd = readRepositorySettings(handle).monthlyBudgetUsd;
  return { monthlyBudgetUsd, degraded: budgetExceeded(handle.repositoryPath, monthlyBudgetUsd) };
}

/** 只需要降级标志时用这一格。 */
export function budgetDegraded(handle: RepositoryHandle): boolean {
  return budgetGate(handle).degraded;
}

/** 回合中间的预算复查：一次工具轮 = 一次新调用，到线不再加轮。返回句直接给模型看。币种只看配置，不看键名。 */
export function turnBudgetGuard(handle: RepositoryHandle): () => string | undefined {
  const { monthlyBudgetUsd } = readRepositorySettings(handle);
  return () => (budgetExceeded(handle.repositoryPath, monthlyBudgetUsd) ? `本仓本月预算（${monthlyBudgetUsd}）已经用完，这是本次对话的最后一趟调用。` : undefined);
}

/** L1 摘要表 → `path → 一句话职责`；借用挂载句柄，不再开连接。 */
export function latestFileSummaries(handle: RepositoryHandle): Map<string, string> {
  const database = handle.pin();
  try {
    // 达到读取上限时要在日志里点名。
    const rows = database.summaries.latest(LATEST_SUMMARY_LIMIT);
    if (rows.length >= LATEST_SUMMARY_LIMIT) console.warn(`[engine] ${handle.repositoryPath} 的摘要行数达到读取上限 ${LATEST_SUMMARY_LIMIT}，超出的旧路径本次没有摘要可用（流程证据与检索语料会缺这些文件）`);
    return new Map(rows.map((row) => [row.path, row.summary]));
  } finally {
    handle.unpin();
  }
}

/** search_code 语料：已分析路径 + 图符号表 + L1 职责；每次请求现建。coverageLow 不扣用职责线索。 */
export function searchCorpusFor(repository: ImportedRepository): SearchCorpus {
  return buildSearchCorpus(repository.index, repository.analysis, latestFileSummaries(repository.handle));
}

/** 跨仓上下文：只经由三个带 repo 参数的工具发生；没有第二个仓时回 `undefined`，对端按需挂载。 */
export function crossRepoFor(repository: ImportedRepository, handedOut: Map<string, number>): CrossRepoContext | undefined {
  const targets = new Map<string, { id: string; path: string }>();
  for (const entry of importer.catalog()) {
    if (entry.repositoryId === repository.index.repositoryId || !entry.exists) continue;
    // 两个仓可能同名：撞名时加 id 前缀。
    const name = targets.has(entry.name) ? `${entry.name}#${entry.repositoryId.slice(0, 6)}` : entry.name;
    targets.set(name, { id: entry.repositoryId, path: entry.repositoryPath });
  }
  if (!targets.size) return undefined;
  const mount = (name: string) => {
    const target = targets.get(name);
    if (!target) return undefined;
    const mounted = importer.ensureMounted(target.id);
    return mounted.ok ? mounted.repository : undefined;
  };
  const view = (item: ImportedRepository) => ({ repositoryId: item.index.repositoryId, path: item.path, files: item.index.files, versionStamp: item.analysis.versionStamp });
  const register = (item: ImportedRepository, path: string) => { handedOut.set(path, item.index.files.find((file) => file.path === path)?.lines ?? 1); };
  return {
    roots: Object.fromEntries([...targets].map(([name, target]) => [name, target.path])),
    corpusOf: (name) => { const other = mount(name); return other ? searchCorpusFor(other) : undefined; },
    links: (name, filter) => {
      const other = mount(name);
      if (!other) return targets.has(name) ? `仓「${name}」挂不起来（目录被挪走或 .tutor 产物不全），这次给不出跨仓落点。` : `未知仓库「${name}」；可配对的其他仓：${[...targets.keys()].join(" / ")}。`;
      const report = seamReportFor(view(repository), view(other));
      // 递给模型的每一行落点都要登记：回合收尾的复检据此区分引擎给的对端行号与编造
      for (const link of report.outbound.links) register(other, link.provider.path);
      for (const link of report.inbound.links) register(other, link.consumer.path);
      // 这是一次读了两个仓源码的动作：配上几条、跟谁配的必须由工具留痕
      repository.audit.append("repository_paired", { other_repository_id: other.index.repositoryId, outbound: report.outbound.matched, inbound: report.inbound.matched, via: "tool" });
      return formatSeamReport(name, report, filter);
    },
    maxCrossReads: 2,
    onHandedOut: (name, path) => { const other = mount(name); if (other) register(other, path); }
  };
}
