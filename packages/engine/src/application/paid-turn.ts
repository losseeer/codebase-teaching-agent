import { budgetExceeded, defaultMonthlyBudgetUsd } from "../cost/cost.js";
import { formatSeamReport, seamReportFor } from "../seams/seams.js";
import { Journal } from "../persistence/journal.js";
import { LATEST_SUMMARY_LIMIT } from "../persistence/summary-repository.js";
import type { RepositoryHandle } from "../persistence/repository-handle.js";
import { buildSearchCorpus, type SearchCorpus } from "../source/search-code.js";
import type { CrossRepoContext } from "../source/tool-loop.js";
import type { ImportedRepository } from "../importer/importer.js";
import { importer } from "../services.js";

/**
  一次付费回合的「开火条件」与「喂什么」：每仓设置、预算闸、检索语料、跨仓上下文。
  这四件事与 HTTP 无关，只认挂载项与句柄，所以放在应用层供画布工具、讲评、脚本复用。
*/

/** 每仓可持久化的设置形态（settings_json 里的一个子集；refinement 标记等内部键不在此列、读写都须保留）。 */
export interface RepositorySettingsPayload {
  monthlyBudgetUsd: number;
}

export function readRepositorySettings(handle: RepositoryHandle): RepositorySettingsPayload {
  // 借用挂载句柄而不是再开一份：这条 helper 挂在每个付费分支（预算闸）上，新开连接会重跑 migrate。
  // pin/unpin 按计数可重入，嵌套在已经 pin 的请求里也安全。
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

/**
  付费分支的统一闸门口径：`mode === "degraded"` 就传 `undefined` provider，消费方共用这一处判据。
  单价没配时这里恒为 false——那是闸门失效，不是「还剩很多额度」，读数见 `budgetGateNotice` 与启动那条 degrade。
  `monthlyBudgetUsd` 一起交出去：教学回合收尾按同一份预算算本会话成本，不再读一次设置。
*/
export function budgetGate(handle: RepositoryHandle): { monthlyBudgetUsd: number; degraded: boolean } {
  const monthlyBudgetUsd = readRepositorySettings(handle).monthlyBudgetUsd;
  return { monthlyBudgetUsd, degraded: budgetExceeded(handle.repositoryPath, monthlyBudgetUsd) };
}

/** 只需要降级标志的路由用它，不必自己再算一遍预算。 */
export function budgetDegraded(handle: RepositoryHandle): boolean {
  return budgetGate(handle).degraded;
}

/**
  回合中间的预算复查（一次工具轮 = 一次新开火，到线就不该再加）。
  回的那句直接给模型看：说清是「预算到线」而不是「读文件上限」，它才不会把这句错话转述给学习者。
  币种只看配置不看键名（`monthlyBudgetUsd` 这个名字是历史遗留）。
*/
export function turnBudgetGuard(handle: RepositoryHandle): () => string | undefined {
  const { monthlyBudgetUsd } = readRepositorySettings(handle);
  return () => (budgetExceeded(handle.repositoryPath, monthlyBudgetUsd) ? `本仓本月预算（${monthlyBudgetUsd}）已经用完，这是本次对话的最后一趟调用。` : undefined);
}

/**
  L1 摘要表 → `path → 一句话职责`（流程证据、search 语料、推荐入口共用）。
  借用挂载句柄：这张表每回合要读几次，别各开一份连接。
*/
export function latestFileSummaries(handle: RepositoryHandle): Map<string, string> {
  const database = handle.pin();
  try {
    // 达到读取上限不是静默少文件：缺口必须在日志里点名（上限只有一份定义，在 persistence/summary-repository.ts）
    const rows = database.summaries.latest(LATEST_SUMMARY_LIMIT);
    if (rows.length >= LATEST_SUMMARY_LIMIT) console.warn(`[engine] ${handle.repositoryPath} 的摘要行数达到读取上限 ${LATEST_SUMMARY_LIMIT}，超出的旧路径本次没有摘要可用（流程证据与检索语料会缺这些文件）`);
    return new Map(rows.map((row) => [row.path, row.summary]));
  } finally {
    handle.unpin();
  }
}

/** search_code 语料：已分析路径 + 图符号表 + L1 一句话职责。
    coverageLow 不扣用职责线索，判据只作为 metrics 读数。
    每次请求现建：纯 CPU 毫秒级，且永远跟随最新一次导入的产物，没有失效语义可缓存。 */
export function searchCorpusFor(repository: ImportedRepository): SearchCorpus {
  return buildSearchCorpus(repository.index, repository.analysis, latestFileSummaries(repository.handle));
}

/**
  跨仓访问上下文：界面上没有「跨仓」入口，跨仓只经由 agent 的 `read_file(repo=)` / `search_code(repo=)` /
  `cross_repo_link` 三个工具发生，由模型自己去对端拿证据。三条口径：
  - 只有地址簿里真有第二个仓时才回东西。没有对端时工具清单逐字不变：多一个 schema 字段就是每轮多付 token，
    还会诱使模型去猜不存在的对端。
  - 对端按需挂载：`corpusOf` / `links` 里才 `ensureMounted`，模型不开口就不读第二个仓的产物。
    挂载占 LRU 名额（可能把当前仓挤出去），当前回合握的是内存引用，不受影响。
  - 守卫不另起一套，边界只有一层，就是仓内边界：跨仓读走同一个 `executeReadFile(根, …)`，
    所以仓内边界、拒读名单、软链接复核在对端仓上一样成立。地址簿里有的仓对模型全部可见。
*/
export function crossRepoFor(repository: ImportedRepository, handedOut: Map<string, number>): CrossRepoContext | undefined {
  const targets = new Map<string, { id: string; path: string }>();
  for (const entry of importer.catalog()) {
    if (entry.repositoryId === repository.index.repositoryId || !entry.exists) continue;
    // 两个仓可能同名（都叫 backend）：撞名时加 id 前缀，保证模型报出的名字能唯一定位
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
      new Journal(repository.path, repository.index.repositoryId).append("repository_paired", { other_repository_id: other.index.repositoryId, outbound: report.outbound.matched, inbound: report.inbound.matched, via: "tool" });
      return formatSeamReport(name, report, filter);
    },
    maxCrossReads: 2,
    onHandedOut: (name, path) => { const other = mount(name); if (other) register(other, path); }
  };
}
