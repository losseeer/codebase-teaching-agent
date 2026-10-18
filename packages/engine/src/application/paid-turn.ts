import { budgetExceeded, defaultMonthlyBudgetUsd } from "../cost/cost.js";
import { formatSeamReport, seamReportFor } from "../depgraph/seams.js";
import { Journal } from "../store/journal.js";
import { LATEST_SUMMARY_LIMIT } from "../store/database.js";
import type { RepositoryHandle } from "../store/repository-handle.js";
import { buildSearchCorpus, type SearchCorpus } from "../source/search-code.js";
import type { CrossRepoContext } from "../source/tool-loop.js";
import type { ImportedRepository } from "../importer/importer.js";
import { importer } from "../services.js";

/**
  一次付费回合的「开火条件」与「喂什么」：每仓设置、预算闸、检索语料、跨仓上下文。
  这四件事以前全写在 `server.ts` 的模块作用域里，于是任何一个想复用它的模块（画布工具、讲评、
  重烧脚本、未来的批处理）都必须把 HTTP 层一起拖进来。它们其实与 HTTP 无关：只认挂载项与句柄。
  */

/** 每仓可持久化的设置形态（settings_json 里的一个子集；refinement 标记等内部键不在此列、读写都须保留）。 */
export interface RepositorySettingsPayload {
  monthlyBudgetUsd: number;
  summaryHeaderComments: boolean;
}

export function readRepositorySettings(handle: RepositoryHandle): RepositorySettingsPayload {
  // 借用挂载句柄而不是再开一份：这条 helper 挂在每一个付费分支上（预算闸），
  // 以前每次判预算都 `new TutorDatabase` 一次，连 migrate 都要重跑一遍。
  // pin/unpin 可重入（按计数），所以嵌套在已经 pin 的请求里也安全。
  const database = handle.pin();
  try {
    const settings = database.getSettings<{ monthlyBudgetUsd?: number; summaryHeaderComments?: boolean }>(handle.repositoryId);
    return {
      monthlyBudgetUsd: typeof settings?.monthlyBudgetUsd === "number" && settings.monthlyBudgetUsd >= 0 ? settings.monthlyBudgetUsd : defaultMonthlyBudgetUsd,
      summaryHeaderComments: settings?.summaryHeaderComments === true
    };
  } finally {
    handle.unpin();
  }
}

/**
  付费分支的统一闸门口径：`mode === "degraded"` 就传 `undefined` provider（八处消费方同一判据，别各写一遍）。
  单价没配时这里恒为 false——那是闸门失效，不是「还剩很多额度」，读数见 `budgetGateNotice` 与启动那条 degrade。
  `monthlyBudgetUsd` 一起交出去：教学回合收尾还要按**同一份**预算算本会话成本，再读一次设置就是第二份口径。
  */
export function budgetGate(handle: RepositoryHandle): { monthlyBudgetUsd: number; degraded: boolean } {
  const monthlyBudgetUsd = readRepositorySettings(handle).monthlyBudgetUsd;
  return { monthlyBudgetUsd, degraded: budgetExceeded(handle.repositoryPath, monthlyBudgetUsd) };
}

/** 只取「是否降级」那一格的路由用的（预算数字用不上就别接住它，省得两处各算一遍）。 */
export function budgetDegraded(handle: RepositoryHandle): boolean {
  return budgetGate(handle).degraded;
}

/**
  L1 摘要表 → `path → 一句话职责`（流程证据、search 语料、推荐入口共用）。
  借用挂载句柄：这张表每回合都要读几次，再各开一份连接就是上一段预算闸同样的毛病。
  */
export function latestFileSummaries(handle: RepositoryHandle): Map<string, string> {
  const database = handle.pin();
  try {
    // 达到读取上限不是静默少文件：缺口要在日志里点名（上限本身只有一份定义，在 store/database.ts）
    const rows = database.getLatestFileSummaries(LATEST_SUMMARY_LIMIT);
    if (rows.length >= LATEST_SUMMARY_LIMIT) console.warn(`[engine] ${handle.repositoryPath} 的摘要行数达到读取上限 ${LATEST_SUMMARY_LIMIT}，超出的旧路径本次没有摘要可用（流程证据与检索语料会缺这些文件）`);
    return new Map(rows.map((row) => [row.path, row.summary]));
  } finally {
    handle.unpin();
  }
}

/** search_code 语料：已分析路径 + 图符号表 + L1 一句话职责。
    coverageLow 不再扣用（09-22 拍板）：anchor-v2 判低的残余只是「纯中文行为描述、没复述符号名」，
    扣掉等于把职责线索也丢出语料；判据保留为 metrics 读数。
    每次请求现建：纯 CPU 毫秒级、且永远跟随最新一次导入的产物，不值得也没有失效语义可缓存。 */
export function searchCorpusFor(repository: ImportedRepository): SearchCorpus {
  return buildSearchCorpus(repository.index, repository.analysis, latestFileSummaries(repository.handle));
}

/**
  跨仓访问上下文——**界面上没有「跨仓」这个入口了**（原来那条接缝面板删了），跨仓只经由 agent 的
  `read_file(repo=)` / `search_code(repo=)` / `cross_repo_link` 三个工具发生：用户问「点了这个按钮之后代码在哪」，
  由模型自己去对端拿证据。三条口径：
  - **只有地址簿里真有第二个仓时才回东西**。没有对端时工具清单逐字不变（多一个 schema 字段就是每轮白付 token，
    还会诱使模型去猜不存在的对端）。
  - **对端按需挂载**：`corpusOf` / `links` 里才 `ensureMounted`，模型不开口就不读第二个仓的产物。
    挂载会占 LRU 名额（可能把当前仓挤出去），但当前这一回合握的是内存引用，不受影响。
  - **守卫不另起一套，边界只有一层就是仓内边界**：跨仓读走的是同一个 `executeReadFile(根, …)`，所以仓内边界、
    拒读名单、软链接复核在对端仓上一样成立——这是这套能力唯一的安全边界。地址簿里有的仓就对模型全部可见
    （认证闸撤了之后没有「名单外」这一档，§64）。
  */
export function crossRepoFor(repository: ImportedRepository, handedOut: Map<string, number>): CrossRepoContext | undefined {
  const targets = new Map<string, { id: string; path: string }>();
  for (const entry of importer.catalog()) {
    if (entry.repositoryId === repository.index.repositoryId || !entry.exists) continue;
    // 两个仓可能同名（都叫 backend）：撞名就给 id 前缀，否则模型报了名字我们不知道选哪个
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
      // 递给模型的每一行落点都登记下来：回合收尾的复检要认它，否则「引擎自己给的对端行号」会被判成编造
      for (const link of report.outbound.links) register(other, link.provider.path);
      for (const link of report.inbound.links) register(other, link.consumer.path);
      // 这是一次读了两个仓源码的动作：配上几条、跟谁配的必须可查（面板时代靠这条路由留痕，现在由工具留）
      new Journal(repository.path, repository.index.repositoryId).append("repository_paired", { other_repository_id: other.index.repositoryId, outbound: report.outbound.matched, inbound: report.inbound.matched, via: "tool" });
      return formatSeamReport(name, report, filter);
    },
    maxCrossReads: 2,
    onHandedOut: (name, path) => { const other = mount(name); if (other) register(other, path); }
  };
}
