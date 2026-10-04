import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDotEnv } from "../config/dotenv.js";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, serializeGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";
import { createEmbeddingProvider, resolveEmbeddingConfig } from "../llm/embeddings.js";
import { buildSearchCorpus } from "../source/search-code.js";
import { embedUnits, fileUnits, pendingUnits, symbolUnits, type EmbedUnit } from "../search/embed-index.js";
import { TutorDatabase } from "../store/database.js";
import type { RepositoryAnalysis } from "@codebase-tutor/shared";

/**
  把仓库的检索语料嵌成向量，落到该仓 `.tutor/tutor.db` 的 `search_vector` 表。
  这是**花钱的动作**（外部 embedding API），所以默认只报计划，要 `--yes` 才真发请求。
  增量按「单元文本哈希」走：源码没改、摘要没重烧 ⇒ 不重嵌；改了哪个单元就只重嵌那一个。

  粒度：`--level=file`（缺省，产品口径）| `--level=symbol`（函数级，第四臂的粒度对照用）。
  两级各占一套坐标系（库里 model 列分别是 `模型名` 与 `模型名#symbol`），互不覆盖、可共存。

  用法：
    pnpm search:embed [仓库路径]                        # 只看计划（要嵌几条、多少字符），不发请求
    pnpm search:embed [仓库路径] -- --yes               # 真跑（文件级）
    pnpm search:embed [仓库路径] -- --level=symbol --yes # 真跑（函数级）
  配好 `TUTOR_EMBED_BASE_URL` / `TUTOR_EMBED_MODEL` / `TUTOR_EMBED_API_KEY`（可选 `TUTOR_EMBED_DIMENSIONS`，默认 1024）。
*/

loadDotEnv();  // TUTOR_EMBED_* 通常写在 .env 里，脚本不加载就永远报「未配置」

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const level = (args.find((value) => value.startsWith("--level="))?.slice("--level=".length) ?? "file") as "file" | "symbol";
if (level !== "file" && level !== "symbol") {
  console.log(`--level 只认 file / symbol，收到的是 "${level}"。`);
  process.exit(1);
}
const repositoryPath = (() => {
  const arg = args.find((value) => !value.startsWith("--"));
  if (arg) return resolve(arg);
  const registry = join(process.env.HOME ?? "", ".codebase-tutor", "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list.at(-1)!;
})();

const config = resolveEmbeddingConfig();
if (!config) {
  console.log("未配置 embedding：需要 TUTOR_EMBED_BASE_URL / TUTOR_EMBED_MODEL / TUTOR_EMBED_API_KEY 三项齐备（可选 TUTOR_EMBED_DIMENSIONS，默认 1024）。");
  console.log("评测台架在没有向量时会跳过 dense/hybrid 两臂，其余读数不受影响。");
  process.exit(0);
}

// 粒度进坐标系：文件级沿用裸模型名（已存的 142 条不动），函数级加 `#symbol` 后缀
const coordinate = level === "file" ? config.model : `${config.model}#${level}`;
const provider = { ...createEmbeddingProvider(config), model: coordinate };

await loadSymbolParser();
const index = indexRepository(repositoryPath);
const graph = buildDependencyGraph(repositoryPath, index.files);
const analysis = { repositoryId: index.repositoryId, generatedAt: new Date().toISOString(), graph: serializeGraph(graph), implementations: [], quality: { generatedAt: new Date().toISOString(), micro: [], macro: [] }, versionStamp: "embed" } as unknown as RepositoryAnalysis;
const database = new TutorDatabase(repositoryPath);
const summaries = new Map(database.getLatestFileSummaries().map((row) => [row.path, row.summary]));
const corpus = buildSearchCorpus(index, analysis, summaries);
const units: EmbedUnit[] = level === "file" ? fileUnits(corpus.entries) : symbolUnits(corpus.entries, analysis.graph.symbols);
const stored = database.getVectorHashes(index.repositoryId, provider.model);
const pending = pendingUnits(units, stored);
const chars = pending.reduce((sum, item) => sum + item.text.length, 0);

console.log(`仓库 ${repositoryPath}`);
console.log(`坐标系 ${provider.model} · ${provider.dimensions} 维 · 粒度 ${level} · 语料 ${corpus.entries.length} 文件 → ${units.length} 个嵌入单元`);
console.log(`已存 ${stored.size} 条；本次需嵌 ${pending.length} 条（约 ${chars.toLocaleString()} 字符，按 ≤10 条/请求分 ${Math.ceil(pending.length / 10) || 0} 批）`);

if (!pending.length) {
  console.log("没有增量，向量已是最新。");
  database.close();
  process.exit(0);
}

if (!confirmed) {
  console.log("未执行：这是外部付费调用。加 --yes 才会真发请求（例：pnpm search:embed -- --yes）。");
  database.close();
  process.exit(0);
}

const startedAt = Date.now();
const result = await embedUnits(database, provider, index.repositoryId, units);
database.close();
console.log(`嵌入完成：新嵌 ${result.embedded} 条、跳过 ${result.skipped} 条、清理已消失单元 ${result.pruned} 条，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s。`);
console.log("调用记账见 llm.log 的 scene=embed 行（输入 token 由端点返回；向量输出不计 token）。");
