import type { FileRole, ImportEstimate } from "@codebase-tutor/shared";
import { hash } from "../lib.js";
import { wordsOf, tokenHits } from "../text/lexical.js";
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
  anchor-v2（2026-09-22）：旧判据要求「前 3 个符号名过半被原文默写」，真仓重放显示低覆盖
  行 160/164 是 mentioned=0——模型用中文行为描述（「负责好友申请的校验」）而非英文符号名，
  整名子串永远对不上。新判据允许**特征词锚定**（RedisTemplate → "redis"），只要 top-3 里
  有任何一个锚上就不算低（any-of），因为「提到了一个核心符号」已是有效信号。
  仍只查前 3 条（而非切片上限 8）：确定性档就只点前 3 个名字，同一口径下兜底档必然满分。
*/
const COVERAGE_CHECKED = 3;

/** 结构词：几乎每个类都叫 XxxService/XxxTest，出现它们不说明摘要认识了这个文件。 */
const STRUCTURAL_WORDS = new Set(["test", "tests", "impl", "service", "controller", "utils", "util", "get", "set", "main"]);

/** 特征词锚定的最短词长：3 及以下（"run"、"add"）噪声大于信号。 */
const MIN_ANCHOR_WORD = 4;

export interface SummaryCoverage {
  /** 参与检查的符号条目数 */
  checked: number;
  /** 其中确实锚定到摘要文本里的个数（整名出现或特征词出现） */
  mentioned: number;
  /** 覆盖不足：查了条目，但一个都没锚上 */
  low: boolean;
  /** 判据版本：旧存量行没这个字段，重放与指标脚本靠它分辨新旧口径 */
  rule?: "anchor-v2";
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

/**
  L1 的键形状与 `layerCacheKey` 同构（口径版本 + 模型版本 + 本层实际输入），但**不换成**那个函数：
  一是这张表按仓库分库（`TutorDatabase(repositoryPath)`），键里再放 repositoryId 是纯冗余；
  二是换构造会让存量行整体失配，等于替每个用户重烧一遍全仓摘要——收益为零。
 */
function cacheKeyOf(slice: FileSlice, modelVersion: string): string {
  return hash(`${SUMMARY_INPUT_VERSION}:${modelVersion}:${JSON.stringify(slice)}`);
}

/** 导出仅为测试可写入「旧判据时代的存量行」，验证缓存命中路径的就地重算。 */
export const summaryCacheKey = cacheKeyOf;

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
    const key = cacheKeyOf(slice, provider.modelVersion);
    const cached = database.getFileSummary<StoredSummary>(key);
    if (cached) {
      cachedFiles += 1;
      // 判据换了就对存量行就地重算：覆盖率是「切片 + 摘要文本」的纯字符串比对，零 token，
      // 也不属于 LLM 的输入口径——所以不需要 bump SUMMARY_INPUT_VERSION 让全仓重烧摘要。
      const coverage = coverageOf(slice, cached.summary);
      if (JSON.stringify(coverage) !== JSON.stringify(cached.coverage)) {
        const migrated: StoredSummary = { ...cached, coverage };
        database.putFileSummary(key, migrated);
        byPath.set(cached.path, { ...migrated, cached: true });
      } else {
        byPath.set(cached.path, { ...cached, cached: true });
      }
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
  摘要是否锚定到了切片里最该提到的那些符号名（纯字符串比对，零成本）。

  ⚠️ 比对前必须**把文件路径从摘要文本里去掉**：摘要几乎总以路径开头，而路径里常含有符号名
  （`main.py` 里有 `main`、`config.py` 里有 `config`），不去掉的话「一个字没提符号」的含糊摘要
  会因为这层巧合被判成高覆盖——这个洞是写测试时才暴露出来的。

  锚定 = 整名子串出现，或任一**特征词**整词出现（`user-service-impl` 归一后 "user" 命中
  `UserService`）。结构词（service/test/main…）与短词不算特征词——它们谁都带，锚上不带来信息。
*/
/** 导出是为了判据重放脚本（scripts/replay-coverage）能走与生产完全同一份实现，不复刻规则。 */
export function coverageOf(slice: { path: string; entries: { name: string }[] }, summary: string): SummaryCoverage {
  const checked = slice.entries.slice(0, COVERAGE_CHECKED);
  const text = summary.toLowerCase().split(slice.path.toLowerCase()).join(" ");
  const mentioned = checked.filter((entry) => anchored(entry.name, text)).length;
  return { checked: checked.length, mentioned, low: checked.length > 0 && mentioned === 0, rule: "anchor-v2" };
}

function anchored(name: string, text: string): boolean {
  if (name && text.includes(name.toLowerCase())) return true;
  // ⚠️ 分词必须吃**原始大小写**：camelCase 边界是 `wordsOf` 拆词的依据，先转小写会把
  // `RedisTemplate` 拆成整块 "redistemplate"，特征词锚定随之失效。
  return wordsOf(name).some((word) => word.length >= MIN_ANCHOR_WORD && !STRUCTURAL_WORDS.has(word) && tokenHits(word, text));
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
