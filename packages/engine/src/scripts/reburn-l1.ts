import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadDotEnv } from "../config/dotenv.js";
import { indexRepository } from "../indexer/indexer.js";
import { graphFromData } from "../depgraph/graph.js";
import { fileStructureOf } from "../depgraph/roles.js";
import { buildLlmRuntimeProvider } from "../llm/runtime.js";
import { createSummaryProvider, LocalSummaryProvider } from "../summarizer/provider.js";
import { summarizeFiles } from "../summarizer/summarizer.js";
import { TutorDatabase } from "../store/database.js";

/**
  L1 摘要全仓重烧（有意的产品写入——它正是「口径 bump 后让全仓摘要换新」的正规通道）。

  与 phase0:prepare-study 的差别：那个脚本走确定性档且会改写课程树、往仓库里写调研材料；
  本脚本只重烧摘要，烧前先断言 provider 是模型档（确定性档重烧毫无意义，且会把 LLM 摘要整表覆盖）。

  用法：pnpm l1:reburn [仓库路径]（缺省取 repositories.json 唯一/首个仓库）
*/

loadDotEnv();

const repositoryPath = (() => {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (arg) return resolve(arg);
  const registry = join(homedir(), ".codebase-tutor", "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list[0];
})();

const index = indexRepository(repositoryPath);
const database = new TutorDatabase(repositoryPath);
const analysis = database.getAnalysis(index.repositoryId);
if (!analysis) throw new Error(`仓库 ${repositoryPath} 尚无分析记录（先走 GUI 导入）`);

// 「摘要参考注释」是每仓设置（默认关）：重烧沿用当前开关状态，与导入路径同口径
const withHeaderComments = database.getSettings<{ summaryHeaderComments?: boolean }>(index.repositoryId)?.summaryHeaderComments === true;
const light = buildLlmRuntimeProvider("light");
const provider = createSummaryProvider({ llm: light, withHeaderComments });
if (provider instanceof LocalSummaryProvider) {
  throw new Error(`摘要档解析为确定性档（light 未配置或 TUTOR_SUMMARY_PROVIDER=off）——重烧会整表覆盖成兜底摘要，中止`);
}

const started = Date.now();
const { summaries, estimate } = await summarizeFiles({
  structure: fileStructureOf(index.files, graphFromData(analysis.graph)),
  database,
  provider,
  withHeaderComments
});
database.close();

const low = summaries.filter((summary) => summary.coverage.low).length;
console.log(`仓库：${repositoryPath}（${index.files.length} 文件）`);
console.log(`摘要参考注释：${withHeaderComments ? "开（slice-v2c）" : "关（slice-v2）"}`);
console.log(`provider：${estimate.provider}｜modelVersion：${estimate.modelVersion}`);
console.log(`重烧 ${estimate.summarizedFiles} 条（缓存命中 ${estimate.cachedFiles}，单条回落 ${estimate.fallbackFiles}）｜耗时 ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`coverageLow：${low}/${summaries.length}`);
