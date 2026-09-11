import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FileEntry, ImportEstimate } from "@codebase-tutor/shared";
import { hash } from "../lib.js";
import { TutorDatabase } from "../store/database.js";
import type { SummaryProvider } from "./provider.js";

export interface FileSummary {
  path: string;
  summary: string;
  cached: boolean;
}

export async function summarizeFiles(
  repositoryPath: string,
  files: FileEntry[],
  database: TutorDatabase,
  provider: SummaryProvider
): Promise<{ summaries: FileSummary[]; estimate: ImportEstimate }> {
  let cachedFiles = 0;
  let summarizedFiles = 0;
  let inputCharacters = 0;
  const summaries: FileSummary[] = [];
  for (const file of files) {
    const content = readFileSync(join(repositoryPath, file.path), "utf8");
    const cacheKey = hash(`${hash(content)}:${provider.modelVersion}`);
    const cached = database.getSummary(cacheKey);
    if (cached) {
      cachedFiles += 1;
      summaries.push({ path: file.path, summary: cached, cached: true });
      continue;
    }
    const summary = await provider.summarize({ path: file.path, content });
    database.putSummary(cacheKey, summary);
    summarizedFiles += 1;
    inputCharacters += content.length;
    summaries.push({ path: file.path, summary, cached: false });
  }
  return {
    summaries,
    estimate: {
      cachedFiles,
      summarizedFiles,
      estimatedInputTokens: Math.ceil(inputCharacters / 4),
      estimatedCostUsd: 0,
      provider: provider.name,
      modelVersion: provider.modelVersion
    }
  };
}

export function moduleSummaries(summaries: FileSummary[]): Map<string, string> {
  const modules = new Map<string, FileSummary[]>();
  for (const summary of summaries) {
    const directory = dirname(summary.path) === "." ? "root" : dirname(summary.path);
    modules.set(directory, [...(modules.get(directory) ?? []), summary]);
  }
  return new Map([...modules.entries()].map(([directory, values]) => [
    directory,
    `${directory} 模块包含 ${values.length} 个文件：${values.slice(0, 3).map((value) => value.path).join("、")}。`
  ]));
}
