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
  按 `SUMMARY_BATCH_SIZE` 批量调用，缺项逐条回落确定性档。
*/

/** 覆盖率检查的切片条目数：只查最靠前的这几条。 */
const COVERAGE_CHECKED = 3;

/** 结构词：出现它们不代表摘要认出了这个文件。 */
const STRUCTURAL_WORDS = new Set(["test", "tests", "impl", "service", "controller", "utils", "util", "get", "set", "main"]);

/** 特征词锚定的最短词长。 */
const MIN_ANCHOR_WORD = 4;

export interface SummaryCoverage {
  /** 参与检查的符号条目数 */
  checked: number;
  /** 锚定到摘要文本里的个数。 */
  mentioned: number;
  /** 查了条目但一个都没锚上。 */
  low: boolean;
  /** 判据版本；旧存量行没这个字段。 */
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

/** 落库形态：不含 `cached`（本次运行的事实不进缓存）。 */
type StoredSummary = Omit<FileSummary, "cached">;

/** 缓存键：口径版本 + 模型版本 + 切片本身；口径版本取自 `SUMMARY_STEP` / `SUMMARY_COMMENTS_STEP`。 */
function cacheKeyOf(slice: FileSlice, modelVersion: string, withHeaderComments: boolean): string {
  const contractVersion = (withHeaderComments ? SUMMARY_COMMENTS_STEP : SUMMARY_STEP).contractVersion;
  return hash(`${contractVersion}:${modelVersion}:${JSON.stringify(slice)}`);
}

/** 导出给测试写入旧判据的存量行。 */
export const summaryCacheKey = cacheKeyOf;

/** 发出去前的隐去只作用于副本：切片原样保留，缓存键不动。 */
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
  /** L1 摘要的存取口：按键取一份、写一份。 */
  store: SummaryStore;
  /** 这批切片所属仓的路径。 */
  repositoryPath: string;
  provider: SummaryProvider;
  /** 「摘要参考注释」开关（每仓设置，默认关）：开时切片附 headerComment。 */
  withHeaderComments?: boolean;
  /** 每一批发给模型的用量回调。 */
  onUsage?: (usage: LlmUsage | undefined) => void;
  /** 每批落库后回报「已完成 / 总数」，缓存命中算已完成。 */
  onProgress?: (done: number, total: number) => void;
}): Promise<{ summaries: FileSummary[]; estimate: ImportEstimate }> {
  const { structure, store, repositoryPath, provider } = input;
  const withHeaderComments = input.withHeaderComments ?? false;
  const roles = classifyFileRoles(structure);
  const slices = buildFileSlices(structure, roles);
  if (withHeaderComments) {
    // 本模块唯一的读盘点；读不到就跳过该文件。
    for (const slice of slices.values()) {
      try {
        const text = readFileSync(join(repositoryPath, slice.path), "utf8");
        const headerComment = extractHeaderComment(slice.path, text);
        if (headerComment) slice.headerComment = headerComment;
      } catch {
        /* 文件不可读时该切片与关着时相同 */
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

  // 只对缓存缺失的付费：命中的不进批次。
  const pending: FileSlice[] = [];
  for (const slice of ordered) {
    const key = cacheKeyOf(slice, provider.modelVersion, withHeaderComments);
    const cached = store.get<StoredSummary>(key);
    if (cached) {
      cachedFiles += 1;
      // 判据换了就就地重算：覆盖率是纯字符串比对，不触发重生成。
      const coverage = coverageOf(slice, cached.summary);
      const migrated: StoredSummary = JSON.stringify(coverage) === JSON.stringify(cached.coverage) ? cached : { ...cached, coverage };
      // 命中也回写以刷新 created_at：下游语料取每路径最新一行。
      store.put(key, migrated);
      byPath.set(cached.path, { ...migrated, cached: true });
      continue;
    }
    pending.push(slice);
  }
  // 缓存扫描本身就耗时，扫完先给一次读数。
  input.onProgress?.(cachedFiles, ordered.length);

  for (let offset = 0; offset < pending.length; offset += SUMMARY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + SUMMARY_BATCH_SIZE);
    let results: (SummaryResult | undefined)[];

    const sending = batch.map((slice) => maskSliceForSend(slice));
    // 出网清单按批登记实际发出去的那份；确定性档不发送，因此不记。
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
      // 整批抛错不等于导入失败：本批按「没拿到结果」逐条走确定性补齐。
      console.warn(`[summarizer] 第 ${Math.floor(offset / SUMMARY_BATCH_SIZE) + 1} 批调用失败，本批 ${batch.length} 条走确定性档：${error instanceof Error ? error.message : String(error)}`);
      results = [];
    }
    for (let index = 0; index < batch.length; index += 1) {
      const slice = batch[index];
      // 没拿到结果的条目用确定性档补齐。
      const fromModel = results[index];
      const result: SummaryResult = fromModel ?? (await local.summarizeMany([slice]))[0];
      if (!fromModel) fallbackFiles += 1;
      const stored: StoredSummary = {
        path: slice.path,
        // 回存也筛一遍：模型可能把字面量抄进摘要。
        summary: maskSecrets(result.summary).text,
        role: result.role ?? slice.role,
        roleSource: result.role ? "provider" : "structure",
        coverage: coverageOf(slice, result.summary)
      };
      // 确定性档文本只写确定性档的键：写进模型档会让下次同输入永久命中。
      store.put(cacheKeyOf(slice, fromModel ? provider.modelVersion : local.modelVersion, withHeaderComments), stored);
      summarizedFiles += 1;
      // 估算按实际发出去的那份算。
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
      // 估算口径 = 切片字符数 / 4，只是量级参考。
      estimatedInputTokens: Math.ceil(inputCharacters / 4),
      estimatedCostUsd: 0,
      provider: provider.name,
      modelVersion: provider.modelVersion
    }
  };
}

/** 摘要是否锚定到切片里最该提到的符号名；导出给判据重放脚本用同一份实现。 */
export function coverageOf(slice: { path: string; entries: { name: string }[] }, summary: string): SummaryCoverage {
  const checked = slice.entries.slice(0, COVERAGE_CHECKED);
  // 比对前去掉文件路径：路径里常含符号名。
  const text = summary.toLowerCase().split(slice.path.toLowerCase()).join(" ");
  const mentioned = checked.filter((entry) => anchored(entry.name, text)).length;
  return { checked: checked.length, mentioned, low: checked.length > 0 && mentioned === 0, rule: "anchor-v2" };
}

function anchored(name: string, text: string): boolean {
  if (name && text.includes(name.toLowerCase())) return true;
  // 分词必须吃原始大小写：camelCase 边界是拆词依据。
  return wordsOf(name).some((word) => word.length >= MIN_ANCHOR_WORD && !STRUCTURAL_WORDS.has(word) && tokenHits(word, text));
}
