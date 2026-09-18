import type { FileRole, ImportEstimate } from "@codebase-tutor/shared";
import { hash } from "../lib.js";
import { TutorDatabase } from "../store/database.js";
import { classifyFileRoles, type FileStructure } from "../depgraph/roles.js";
import { buildFileSlices, type FileSlice } from "./slice.js";
import { LocalSummaryProvider, SUMMARY_BATCH_SIZE, type SummaryProvider, type SummaryResult } from "./provider.js";

/**
  文件级摘要表（L1）：每文件一行「职责摘要 + 架构角色 + 覆盖率标记」，落 SQLite。

  与旧版的差别：
  - 输入不再是整份正文，而是**结构切片**（`slice.ts`）——因此本模块**不再读磁盘**，
    它只消费依赖图；「文件内容变了没」由切片内容（含符号与依赖）间接反映。
  - 输出多了角色与覆盖率。角色由结构规则给出，模型可以覆盖并标注来源。
  - 缓存键从「正文哈希 + 模型版本」变成「**切片 + 输入口径版本 + 模型版本**」的哈希：
    切片变了（文件改了、符号抽取规则改了、依赖变了）缓存即失效，不必再单独追踪文件内容。
  - 摘要档改成**批量**调用：先算缓存缺失的，再按 `SUMMARY_BATCH_SIZE` 分批，一条没结果就那一条回落。
*/

/** 缓存键里带上输入口径版本：切片或角色规则的语义变了，旧缓存必须失效。 */
const SUMMARY_INPUT_VERSION = "slice-v1";

/**
  覆盖率只查切片里最靠前的这几条——它们是最该被摘要提及的。
  取 3 而不是切片上限 8：确定性档就只点前 3 个名字，用同一口径才能让「兜底档满分、含糊摘要掉分」
  这个对比成立；查得越宽，越容易把「摘要短」误判成「摘要差」。
*/
const COVERAGE_CHECKED = 3;

export interface SummaryCoverage {
  /** 参与检查的符号条目数 */
  checked: number;
  /** 其中名字确实出现在摘要文本里的个数 */
  mentioned: number;
  /** 覆盖不足：检查了条目，但提到的不到一半 */
  low: boolean;
}

export interface FileSummary {
  path: string;
  summary: string;
  role: FileRole;
  /** 角色来自结构规则还是模型覆盖——两者含义不同，必须能分辨。 */
  roleSource: "structure" | "provider";
  coverage: SummaryCoverage;
  cached: boolean;
}

/** 落库形态：与 `FileSummary` 差一个 `cached`（那是本次运行的事实，不该进缓存）。 */
type StoredSummary = Omit<FileSummary, "cached">;

function cacheKeyOf(slice: FileSlice, modelVersion: string): string {
  return hash(`${SUMMARY_INPUT_VERSION}:${modelVersion}:${JSON.stringify(slice)}`);
}

export async function summarizeFiles(input: {
  structure: FileStructure;
  database: TutorDatabase;
  provider: SummaryProvider;
}): Promise<{ summaries: FileSummary[]; estimate: ImportEstimate }> {
  const { structure, database, provider } = input;
  const roles = classifyFileRoles(structure);
  const slices = buildFileSlices(structure, roles);
  const ordered = [...slices.values()].sort((left, right) => left.path.localeCompare(right.path));

  const local = new LocalSummaryProvider();
  const byPath = new Map<string, FileSummary>();
  let cachedFiles = 0;
  let summarizedFiles = 0;
  let fallbackFiles = 0;
  let inputCharacters = 0;

  // 先挑出缓存缺失的：批量调用的价值在于「只对需要重算的付费」，已经命中的不该再进批次
  const pending: FileSlice[] = [];
  for (const slice of ordered) {
    const cached = database.getFileSummary<StoredSummary>(cacheKeyOf(slice, provider.modelVersion));
    if (cached) {
      cachedFiles += 1;
      byPath.set(cached.path, { ...cached, cached: true });
      continue;
    }
    pending.push(slice);
  }

  for (let offset = 0; offset < pending.length; offset += SUMMARY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + SUMMARY_BATCH_SIZE);
    const results = await provider.summarizeMany(batch);
    for (let index = 0; index < batch.length; index += 1) {
      const slice = batch[index];
      // 这一条没拿到结果（整批失败、回复漏项、或本来就没配模型）→ 用确定性档补齐，不留空行
      const fromModel = results[index];
      const result: SummaryResult = fromModel ?? (await local.summarizeMany([slice]))[0];
      if (!fromModel) fallbackFiles += 1;
      const stored: StoredSummary = {
        path: slice.path,
        summary: result.summary,
        role: result.role ?? slice.role,
        roleSource: result.role ? "provider" : "structure",
        coverage: coverageOf(slice, result.summary)
      };
      database.putFileSummary(cacheKeyOf(slice, provider.modelVersion), stored);
      summarizedFiles += 1;
      inputCharacters += JSON.stringify(slice).length;
      byPath.set(slice.path, { ...stored, cached: false });
    }
  }

  return {
    // 每个切片要么命中缓存、要么上面算过，因此这里必定都有值
    summaries: ordered.map((slice) => byPath.get(slice.path)!),
    estimate: {
      cachedFiles,
      summarizedFiles,
      fallbackFiles,
      // 估算口径 = 切片字符数 / 4（旧版是整份正文；估算本就是量级参考，实测单价见 REFERENCE.md）
      estimatedInputTokens: Math.ceil(inputCharacters / 4),
      estimatedCostUsd: 0,
      provider: provider.name,
      modelVersion: provider.modelVersion
    }
  };
}

/**
  摘要是否覆盖了切片里最该提到的那些符号名（纯字符串比对，零成本）。

  ⚠️ 比对前必须**把文件路径从摘要文本里去掉**：摘要几乎总以路径开头，而路径里常含有符号名
  （`main.py` 里有 `main`、`config.py` 里有 `config`），不去掉的话「一个字没提符号」的含糊摘要
  会因为这层巧合被判成高覆盖——这个洞是写测试时才暴露出来的。
*/
function coverageOf(slice: { path: string; entries: { name: string }[] }, summary: string): SummaryCoverage {
  const names = slice.entries.slice(0, COVERAGE_CHECKED).map((entry) => entry.name.toLowerCase());
  const text = summary.toLowerCase().split(slice.path.toLowerCase()).join(" ");
  const mentioned = names.filter((name) => text.includes(name)).length;
  return { checked: names.length, mentioned, low: names.length > 0 && mentioned * 2 < names.length };
}

export function moduleSummaries(summaries: FileSummary[]): Map<string, string> {
  const modules = new Map<string, FileSummary[]>();
  for (const summary of summaries) {
    const directory = summary.path.includes("/") ? summary.path.slice(0, summary.path.lastIndexOf("/")) : "root";
    modules.set(directory, [...(modules.get(directory) ?? []), summary]);
  }
  return new Map([...modules.entries()].map(([directory, values]) => [
    directory,
    `${directory} 模块包含 ${values.length} 个文件：${values.slice(0, 3).map((value) => value.path).join("、")}。`
  ]));
}
