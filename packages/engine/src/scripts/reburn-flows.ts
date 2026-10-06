/**
  L2 流程重烧（**花钱**，跑之前看这段）。

  与产品路由同口径：主力档 provider、`generateRepositoryFlowCached`、用量照样写 journal 的 `token_usage`，
  所以成本监控页读到的数与真点 GUI 是同一笔账。存在的理由同样是「引擎没有重新分析/重烧这条产品路由」
  （§34.7 记的缺口），改图判据后必须有个通道把新图落到流程产物里。

  用法：
    pnpm flow:reburn [仓库路径] [--limit N] [--entry 关键词] [--repeat N] [--nocache] [--check]
  - `--check`：只算缓存键、报「命中 / 待烧」，一个请求都不发也不写库。
    问「还有哪些产物不是当前判据算出来的」就用它——键的构造与产品共用 `flowCacheKeyOf`，两套判据才是一条心。
  - `--limit`：按入口清单顺序只烧前 N 个入口（默认全部）。
  - `--entry`：只烧路径或标签里含这个子串的入口（多样本量方差就靠它 + `--repeat`）。
  - `--repeat N` / `--nocache`：绕开缓存真发 N 次请求。**同一条流程的两次读数能差 16 个百分点**
    （§34.8），所以判「有没有变好」至少取 3 个样本，单样本不可比。
*/
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceAnchor } from "@codebase-tutor/shared";
import { loadDotEnv } from "../config/dotenv.js";
import { indexRepository } from "../indexer/indexer.js";
import { buildLlmRuntimeProvider, restoreLlmRuntimeSettings } from "../llm/runtime.js";
import { flowCacheKeyOf, generateRepositoryFlow, generateRepositoryFlowCached } from "../flows/flow.js";
import { TutorDatabase } from "../store/database.js";
import { Journal } from "../store/journal.js";

loadDotEnv();
restoreLlmRuntimeSettings();

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((value) => value.startsWith("--")));
const valueOf = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const repositoryPath = (() => {
  const arg = argv.find((value) => !value.startsWith("--") && value.includes("/"));
  if (arg) return resolve(arg);
  const registry = join(homedir(), ".codebase-tutor", "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list.at(-1)!;
})();

const provider = buildLlmRuntimeProvider("teaching");
if (!provider) throw new Error("主力档未配置：这个脚本只烧模型档，不烧静态降级视图");

const index = indexRepository(repositoryPath);
const store = new TutorDatabase(repositoryPath);
const stored = store.getAnalysis(index.repositoryId);
if (!stored) throw new Error(`仓库 ${repositoryPath} 尚无分析记录（先走 GUI 导入）`);
const analysis = stored;
const summaries = new Map(store.getLatestFileSummaries().map((row) => [row.path, row.summary]));

const wanted = (valueOf("entry") ?? "").trim();
const matched = wanted ? analysis.graph.entrypoints.filter((entry) => `${entry.path} ${entry.label}`.includes(wanted)) : analysis.graph.entrypoints;
const limit = Number(valueOf("limit") ?? matched.length);
const entries = matched.slice(0, Number.isFinite(limit) && limit > 0 ? limit : matched.length);
const repeat = Math.max(1, Number(valueOf("repeat") ?? 1));
const nocache = flags.has("--nocache") || repeat > 1;
if (!entries.length) throw new Error(wanted ? `没有入口匹配「${wanted}」` : "该仓库没有入口清单");

const check = flags.has("--check");
if (check) {
  console.log("只算键、不发请求：命中=这行产物就是当前判据算出来的；待烧=下次打开会重烧（或现在批量烧掉）");
  let stale = 0;
  for (const entry of entries) {
    const cacheKey = flowCacheKeyOf({ repositoryPath, index, analysis, entry, provider, summaries, repositoryId: index.repositoryId });
    if (!cacheKey) { console.log(`  算不出键 ${entry.path.split("/").pop()}（入口不在证据里，产品侧本来就走直降路径）`); continue; }
    const hit = store.getLayerCache<unknown>(cacheKey.key);
    if (!hit) stale += 1;
    console.log(`  ${hit ? "命中" : "待烧"} ${entry.path.split("/").pop()}｜键 ${cacheKey.key.slice(-12)}｜${hit ? `${Math.round((Date.now() - hit.at) / 3_600_000)} 小时前生成` : "没有对应缓存行"}`);
  }
  console.log(`\n合计：${entries.length} 个入口里 ${stale} 个待烧（按实测 ≈¥0.17/条 ⇒ ≈¥${(stale * 0.17).toFixed(2)} 峰时口径）`);
  store.close();
  process.exit(0);
}

const journal = new Journal(repositoryPath, index.repositoryId);
console.log(`仓库 ${repositoryPath}｜入口 ${entries.length} 个（全仓 ${analysis.graph.entrypoints.length}）｜摘要 ${summaries.size} 条｜${nocache ? `绕缓存，每入口 ${repeat} 次` : "走缓存（命中即零成本）"}`);

/** grounding：能被静态图或正文证实的边占比。只降不升的校验在 flow.ts 里做，这里只读结论。 */
const groundingOf = (edges: { origin?: string }[]): { static: number; inferred: number; code: number } => ({
  static: edges.filter((edge) => edge.origin === "static").length,
  inferred: edges.filter((edge) => edge.origin === "inferred").length,
  code: edges.filter((edge) => edge.origin === "code").length
});

let burned = 0;
let reused = 0;
for (const entry of entries) {
  for (let attempt = 1; attempt <= (nocache ? repeat : 1); attempt += 1) {
    const input = { repositoryPath, index, analysis, entry, provider, summaries };
    // 绕缓存那一趟只调模型、不落库：方差样本不该污染产品缓存
    const generated = nocache
      ? await generateRepositoryFlow(input)
      : await generateRepositoryFlowCached({ ...input, repositoryId: index.repositoryId, database: store });
    if (generated.usage) journal.append("token_usage", {
      input_tokens: generated.usage.inputTokens,
      output_tokens: generated.usage.outputTokens,
      cache_hit_tokens: generated.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "flow_map"
    });
    const composition = groundingOf(generated.flow.edges);
    const total = generated.flow.edges.length || 1;
    const grounded = composition.static + composition.code;
    burned += generated.usage ? 1 : 0;
    reused += generated.usage ? 0 : 1;
    console.log(`${generated.usage ? "重烧" : "命中"} ${entry.path.split("/").pop()}${repeat > 1 ? ` #${attempt}` : ""}｜环节 ${generated.flow.stages.length}｜边 ${generated.flow.edges.length} ` +
      `{static:${composition.static}, inferred:${composition.inferred}, code:${composition.code}}｜grounding ${(grounded / total * 100).toFixed(0)}%｜` +
      `in ${generated.usage?.inputTokens ?? 0}(cache ${generated.usage?.promptCacheHitTokens ?? 0}) out ${generated.usage?.outputTokens ?? 0}｜来源 ${generated.source}`);
  }
}
console.log(`\n合计：真发请求 ${burned} 条、缓存命中 ${reused} 条。金额按 llm.log/journal 的 token 与官方价核算。`);
store.close();
