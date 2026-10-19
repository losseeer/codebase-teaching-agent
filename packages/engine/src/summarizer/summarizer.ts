import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileRole, ImportEstimate } from "@codebase-tutor/shared";
import { hash } from "../identity.js";
import { maskSecrets, secretMasker } from "../security/secrets.js";
import { wordsOf, tokenHits } from "../text/lexical.js";
import { TutorDatabase } from "../store/database.js";
import { classifyFileRoles, type FileStructure } from "../depgraph/roles.js";
import { buildFileSlices, extractHeaderComment, type FileSlice } from "./slice.js";
import { recordEgress } from "../security/dataflow.js";
import { LocalSummaryProvider, SUMMARY_BATCH_SIZE, SUMMARY_COMMENTS_STEP, SUMMARY_STEP, type SummaryProvider, type SummaryResult } from "./summary-provider.js";

/**
  文件级摘要表（L1）：每文件一行「职责摘要 + 架构角色 + 覆盖率标记」，落 SQLite。
  - 输入是结构切片（`slice.ts`），不是整份正文；「文件内容变了没」由切片内容间接反映。
    唯一的读盘例外是「摘要参考注释」开关打开时取 headerComment（见 summarizeFiles）。
  - 角色由结构规则给出，模型可以覆盖并标注来源。
  - 缓存键 = hash(切片 + 输入口径版本 + 模型版本)：切片变了缓存即失效。
  - 摘要档按 `SUMMARY_BATCH_SIZE` 批量调用，一条没结果就那一条回落确定性档。
*/

/**
  覆盖率只查切片里最靠前的这几条——它们是最该被摘要提及的。
  anchor-v2 判据：允许特征词锚定（RedisTemplate → "redis"），前 3 条任一锚上（any-of）就不算低。
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
  L1 的键形状与 `layerCacheKey` 同构（口径版本 + 模型版本 + 本层实际输入），但不改用它的构造：
  这张表按仓库分库（`TutorDatabase(repositoryPath)`），键里再放 repositoryId 是纯冗余；
  换构造会让存量行整体失配、等于全量付费重生成，收益为零。
  版本号仍登记成分析步骤（`SUMMARY_STEP` / `SUMMARY_COMMENTS_STEP`，见 `summary-provider.ts`）：
  键的形状可以特例，提示词文案的指纹守卫不能有特例（见 `analysis-step.ts`）。
 */
function cacheKeyOf(slice: FileSlice, modelVersion: string, withHeaderComments: boolean): string {
  const contractVersion = (withHeaderComments ? SUMMARY_COMMENTS_STEP : SUMMARY_STEP).contractVersion;
  return hash(`${contractVersion}:${modelVersion}:${JSON.stringify(slice)}`);
}

/** 导出仅为测试可写入「旧判据时代的存量行」，验证缓存命中路径的就地重算。 */
export const summaryCacheKey = cacheKeyOf;

/**
  出门前的隐去只作用于发给模型的那份副本：切片原样保留、缓存键不动
  （键是 `hash(切片本身)`，让隐去参与键计算会让全仓摘要键整体翻掉）。
  筛的是「发出去的内容」与「存回来的摘要」两处，代价是缓存里的切片仍含原文（只在本机磁盘，不出门）。
  整份递归走字符串而不是逐字段列举，防 `FileSlice` 长新字段时漏掉。
 */
function maskSliceForSend(slice: FileSlice): { copy: FileSlice; masked: number } {
  const masker = secretMasker();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return masker.take(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  return { copy: walk(slice) as FileSlice, masked: masker.masked };
}

export async function summarizeFiles(input: {
  structure: FileStructure;
  database: TutorDatabase;
  provider: SummaryProvider;
  /** 「摘要参考注释」开关（每仓设置，默认关）。开=切片附 headerComment，键前缀走 slice-v2c。 */
  withHeaderComments?: boolean;
}): Promise<{ summaries: FileSummary[]; estimate: ImportEstimate }> {
  const { structure, database, provider } = input;
  const withHeaderComments = input.withHeaderComments ?? false;
  const roles = classifyFileRoles(structure);
  const slices = buildFileSlices(structure, roles);
  if (withHeaderComments) {
    // 开关注册在磁盘上的注释——这是本模块唯一的读盘点：切片其余部分仍是纯结构产物。
    // 读不到（文件刚被删/权限）就静默跳过该文件：缺一段注释不值得让整次导入失败。
    for (const slice of slices.values()) {
      try {
        const text = readFileSync(join(database.repositoryPath, slice.path), "utf8");
        const headerComment = extractHeaderComment(slice.path, text);
        if (headerComment) slice.headerComment = headerComment;
      } catch {
        /* 文件不可读 ⇒ 该切片与关着时逐字节相同 */
      }
    }
  }
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
    const key = cacheKeyOf(slice, provider.modelVersion, withHeaderComments);
    const cached = database.getFileSummary<StoredSummary>(key);
    if (cached) {
      cachedFiles += 1;
      // 判据换了就对存量行就地重算：覆盖率是「切片 + 摘要文本」的纯字符串比对、零模型消耗，
      // 不属于 LLM 输入口径——不需要翻口径版本触发全仓付费重生成。
      const coverage = coverageOf(slice, cached.summary);
      const migrated: StoredSummary = JSON.stringify(coverage) === JSON.stringify(cached.coverage) ? cached : { ...cached, coverage };
      // 命中也回写（刷新 created_at）：下游语料取「每路径最新一行」，双档键各写一行——
      // 不刷新则从注释档切回关档时，旧行会一直伪装成现行摘要。回写是纯本地写，零成本。
      database.putFileSummary(key, migrated);
      byPath.set(cached.path, { ...migrated, cached: true });
      continue;
    }
    pending.push(slice);
  }

  for (let offset = 0; offset < pending.length; offset += SUMMARY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + SUMMARY_BATCH_SIZE);
    let results: (SummaryResult | undefined)[];
    // 声明在 try 之外：下面的落库循环要用它算「实际发出去的字符数」
    const sending = batch.map((slice) => maskSliceForSend(slice));
    // 出网清单：这一批每个文件一条，记实际发出去的那份（隐去密钥之后的切片）。
    // 放在 try 之前：端点失败也是真发出去了，`llm.log` 里那行 `ok=false` 会说明有没有拿到结果。
    // 确定性档不记：它一个字都不发出去（口径见 SummaryProvider.sendsCodeToEndpoint）。
    if (provider.sendsCodeToEndpoint) recordEgress({
      repositoryPath: database.repositoryPath,
      scene: "map.summary",
      sources: sending.map((item, index) => ({
        kind: "l1-slice" as const,
        path: batch[index].path,
        from: 1,
        to: batch[index].lines,
        text: JSON.stringify(item.copy),
        masked: item.masked
      }))
    });
    try {
      const sendMasked = sending.reduce((total, item) => total + item.masked, 0);
      if (sendMasked) console.warn(`[summarizer] 本批有 ${sendMasked} 处疑似密钥在发给 ${provider.name} 之前被隐去（切片与缓存键未改动）`);
      results = await provider.summarizeMany(sending.map((item) => item.copy));
    } catch (error) {
      // 整批抛错（网络、429、端点抖动）不等于导入失败：本批全按「没拿到结果」处理，
      // 与缺项合流成同一条路径——逐条走确定性补齐（按条回落是 SummaryProvider 的调用方契约）。
      console.warn(`[summarizer] 第 ${Math.floor(offset / SUMMARY_BATCH_SIZE) + 1} 批调用失败，本批 ${batch.length} 条走确定性档：${error instanceof Error ? error.message : String(error)}`);
      results = [];
    }
    for (let index = 0; index < batch.length; index += 1) {
      const slice = batch[index];
      // 这一条没拿到结果（整批失败、回复漏项、或本来就没配模型）→ 用确定性档补齐，不留空行
      const fromModel = results[index];
      const result: SummaryResult = fromModel ?? (await local.summarizeMany([slice]))[0];
      if (!fromModel) fallbackFiles += 1;
      const stored: StoredSummary = {
        path: slice.path,
        // 回存也筛一遍：模型可能把看到过的字面量原样抄进摘要，那行之后会被当上下文反复重放
        summary: maskSecrets(result.summary).text,
        role: result.role ?? slice.role,
        roleSource: result.role ? "provider" : "structure",
        coverage: coverageOf(slice, result.summary)
      };
      // 兜底文本只写确定性档的键、不写模型档的键：写了的话下次同输入即永久命中，
      // 结构文本会伪装成模型产物、`fallbackFiles` 读数归零。落确定性档键则下次同输入仍会重试模型。
      database.putFileSummary(cacheKeyOf(slice, fromModel ? provider.modelVersion : local.modelVersion, withHeaderComments), stored);
      summarizedFiles += 1;
      // 估算口径按实际发出去的那份算，隐去过就该比切片原文短
      inputCharacters += JSON.stringify(sending[index].copy).length;
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
      // 估算口径 = 切片字符数 / 4，只是量级参考（单价读数见 REFERENCE.md）
      estimatedInputTokens: Math.ceil(inputCharacters / 4),
      estimatedCostUsd: 0,
      provider: provider.name,
      modelVersion: provider.modelVersion
    }
  };
}

/**
  摘要是否锚定到了切片里最该提到的那些符号名（纯字符串比对，零成本）。
  ⚠️ 比对前必须把文件路径从摘要文本里去掉：摘要几乎总以路径开头，而路径里常含符号名
  （`main.py` 里有 `main`、`config.py` 里有 `config`），不去掉会让一个字没提的含糊摘要被判成高覆盖。
  锚定 = 整名子串出现，或任一特征词整词出现（`user-service-impl` 归一后 "user" 命中 `UserService`）。
  结构词（service/test/main…）与短词不算特征词——它们谁都带，锚上不带来信息。
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
  // ⚠️ 分词必须吃原始大小写：camelCase 边界是 `wordsOf` 拆词的依据，先转小写会把
  // `RedisTemplate` 拆成整块 "redistemplate"，特征词锚定随之失效。
  return wordsOf(name).some((word) => word.length >= MIN_ANCHOR_WORD && !STRUCTURAL_WORDS.has(word) && tokenHits(word, text));
}
