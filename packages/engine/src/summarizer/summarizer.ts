import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileRole, ImportEstimate } from "@codebase-tutor/domain";

import { hash } from "@codebase-tutor/platform";
import type { LlmUsage } from "../application/port/llm-provider.js";
import { maskSecrets, secretMasker } from "@codebase-tutor/domain";
import { wordsOf, tokenHits } from "@codebase-tutor/platform";
import type { SummaryStore } from "../application/port/summary-store.js";
import { classifyFileRoles, type FileStructure } from "@codebase-tutor/analysis";
import { buildFileSlices, extractHeaderComment, type FileSlice } from "@codebase-tutor/analysis";
import { recordEgress } from "../adapter/outbound/security/egress-log.js";
import { LocalSummaryProvider, SUMMARY_BATCH_SIZE, SUMMARY_COMMENTS_STEP, SUMMARY_STEP, type SummaryProvider, type SummaryResult } from "./summary-provider.js";

/**
  文件级摘要表（L1）：每文件一行职责摘要 + 架构角色 + 覆盖率标记。
  输入是结构切片，缓存键 = hash(切片 + 口径版本 + 模型版本)。
  按 `SUMMARY_BATCH_SIZE` 批量调用，缺项逐条用本地摘要补齐。
*/

/** 覆盖率检查的最靠前条目数。 */
const COVERAGE_CHECKED = 3;

/** 结构词：出现在摘要里不代表认出了文件。 */
const STRUCTURAL_WORDS = new Set(["test", "tests", "impl", "service", "controller", "utils", "util", "get", "set", "main"]);

/** 特征词锚定的最短词长。 */
const MIN_ANCHOR_WORD = 4;

export interface SummaryCoverage {
  /** 参与检查的符号条目数。 */
  checked: number;
  /** 锚定到摘要文本里的个数。 */
  mentioned: number;
  /** 查了条目但一个都没锚上。 */
  low: boolean;
  /** 判定规则版本。 */
  rule?: "anchor-v2";
}

export interface FileSummary {
  path: string;
  summary: string;
  role: FileRole;
  /** 角色来自结构规则还是模型覆盖。 */
  roleSource: "structure" | "provider";
  coverage: SummaryCoverage;
  cached: boolean;
}

/** 落库形态，不含 cached。 */
type StoredSummary = Omit<FileSummary, "cached">;

/** 缓存键 = 口径版本 + 模型版本 + 切片。 */
function cacheKeyOf(slice: FileSlice, modelVersion: string, withHeaderComments: boolean): string {
  const contractVersion = (withHeaderComments ? SUMMARY_COMMENTS_STEP : SUMMARY_STEP).contractVersion;
  return hash(`${contractVersion}:${modelVersion}:${JSON.stringify(slice)}`);
}

/** 缓存键函数的对外导出。 */
export const summaryCacheKey = cacheKeyOf;

/** 隐去只作用于副本，切片原样保留。 */
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
  /** 摘要的存取口。 */
  store: SummaryStore;
  /** 这批切片所属仓的路径。 */
  repositoryPath: string;
  provider: SummaryProvider;
  /** 开启时切片附 headerComment。 */
  withHeaderComments?: boolean;
  /** 每一批发给模型的用量回调。 */
  onUsage?: (usage: LlmUsage | undefined) => void;
  /** 每批落库后回报已完成数与总数，缓存命中算已完成。 */
  onProgress?: (done: number, total: number) => void;
}): Promise<{ summaries: FileSummary[]; estimate: ImportEstimate }> {
  const { structure, store, repositoryPath, provider } = input;
  const withHeaderComments = input.withHeaderComments ?? false;
  const roles = classifyFileRoles(structure);
  const slices = buildFileSlices(structure, roles);
  if (withHeaderComments) {
    for (const slice of slices.values()) {
      try {
        const text = readFileSync(join(repositoryPath, slice.path), "utf8");
        const headerComment = extractHeaderComment(slice.path, text);
        if (headerComment) slice.headerComment = headerComment;
      } catch {
        // 文件不可读时跳过该文件
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

  // 命中的不进批次
  const pending: FileSlice[] = [];
  for (const slice of ordered) {
    const key = cacheKeyOf(slice, provider.modelVersion, withHeaderComments);
    const cached = store.get<StoredSummary>(key);
    if (cached) {
      cachedFiles += 1;
      // 规则变化时就地重算覆盖率，不触发重新生成
      const coverage = coverageOf(slice, cached.summary);
      const migrated: StoredSummary = JSON.stringify(coverage) === JSON.stringify(cached.coverage) ? cached : { ...cached, coverage };
      // 命中也回写，刷新 created_at
      store.put(key, migrated);
      byPath.set(cached.path, { ...migrated, cached: true });
      continue;
    }
    pending.push(slice);
  }
  // 缓存扫描完成后先回报一次进度
  input.onProgress?.(cachedFiles, ordered.length);

  for (let offset = 0; offset < pending.length; offset += SUMMARY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + SUMMARY_BATCH_SIZE);
    let results: (SummaryResult | undefined)[];

    const sending = batch.map((slice) => maskSliceForSend(slice));
    // 出网清单按批登记实际发出的那份
    if (provider.sendsCodeToEndpoint) recordEgress({
      repositoryPath,
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
      input.onUsage?.(provider.lastUsage);
    } catch (error) {
      // 整批失败时本批逐条用本地摘要补齐
      console.warn(`[summarizer] 第 ${Math.floor(offset / SUMMARY_BATCH_SIZE) + 1} 批调用失败，本批 ${batch.length} 条走确定性档：${error instanceof Error ? error.message : String(error)}`);
      results = [];
    }
    for (let index = 0; index < batch.length; index += 1) {
      const slice = batch[index];
      const fromModel = results[index];
      const result: SummaryResult = fromModel ?? (await local.summarizeMany([slice]))[0];
      if (!fromModel) fallbackFiles += 1;
      const stored: StoredSummary = {
        path: slice.path,
        // 回存前也做密钥隐去
        summary: maskSecrets(result.summary).text,
        role: result.role ?? slice.role,
        roleSource: result.role ? "provider" : "structure",
        coverage: coverageOf(slice, result.summary)
      };
      // 本地摘要的结果只写本地档的缓存键
      store.put(cacheKeyOf(slice, fromModel ? provider.modelVersion : local.modelVersion, withHeaderComments), stored);
      summarizedFiles += 1;
      // 估算按实际发出的那份统计
      inputCharacters += JSON.stringify(sending[index].copy).length;
      byPath.set(slice.path, { ...stored, cached: false });
    }
    input.onProgress?.(cachedFiles + offset + batch.length, ordered.length);
  }

  return {

    summaries: ordered.map((slice) => byPath.get(slice.path)!),
    estimate: {
      cachedFiles,
      summarizedFiles,
      fallbackFiles,
      // 估算口径 = 切片字符数 / 4
      estimatedInputTokens: Math.ceil(inputCharacters / 4),
      estimatedCostUsd: 0,
      provider: provider.name,
      modelVersion: provider.modelVersion
    }
  };
}

/** 摘要是否锚定到切片里最靠前的符号名。 */
export function coverageOf(slice: { path: string; entries: { name: string }[] }, summary: string): SummaryCoverage {
  const checked = slice.entries.slice(0, COVERAGE_CHECKED);
  // 比对前先把文件路径从摘要文本里去掉
  const text = summary.toLowerCase().split(slice.path.toLowerCase()).join(" ");
  const mentioned = checked.filter((entry) => anchored(entry.name, text)).length;
  return { checked: checked.length, mentioned, low: checked.length > 0 && mentioned === 0, rule: "anchor-v2" };
}

function anchored(name: string, text: string): boolean {
  if (name && text.includes(name.toLowerCase())) return true;
  // 分词必须用原始大小写
  return wordsOf(name).some((word) => word.length >= MIN_ANCHOR_WORD && !STRUCTURAL_WORDS.has(word) && tokenHits(word, text));
}
