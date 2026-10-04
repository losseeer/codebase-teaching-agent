import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { RepositoryAnalysis, RepositoryFlow } from "@codebase-tutor/shared";
import { loadDotEnv } from "../config/dotenv.js";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, serializeGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";
import { buildSearchCorpus, executeSearchCode } from "../source/search-code.js";
import { segmentForLookup } from "../text/lexical.js";
import { createEmbeddingProvider, resolveEmbeddingConfig } from "../llm/embeddings.js";
import { cosineTop, cosineTopByFile, fileUnits, pendingUnits, reciprocalRankFusion, type StoredVector } from "../search/embed-index.js";
import { decodeVectorBlob } from "../store/database.js";
import { readJournal } from "../store/journal.js";
import { scoreFlowArtifacts, scoreSearchArm, scoreTeachInvariants, type SearchCase, type TeachTurn } from "../eval/scorers.js";

/**
  B 档评测 runner（第 1 刀：零 token 确定性判分，设计方案 §10 第 2 档的机器检查部分）。
  默认全程只读、零 token：产物取自 <repo>/.tutor/tutor.db，索引/依赖图在本地重算，不碰引擎、不写任何文件。
  LLM 真跑与表达质量裁判不在这一刀里（回合落盘是其前置）。

  唯一例外是 dense/hybrid 两臂（检索第四臂）：它们要对查询发 embedding 请求，所以**必须显式加 --dense** 才会打网络；
  不加就照常出三臂读数，第四臂那一格写明「未跑」和怎么跑。向量表本身是只读进来的（`search_vector`）。

  用法：pnpm phaseB:eval [仓库路径]（缺省取 repositories.json 里最近使用的那条）
        pnpm phaseB:eval -- --dense   # 出四臂对比（发 N 条查询的 embedding 请求）
*/

loadDotEnv();
const wantDense = process.argv.includes("--dense");

const here = dirname(fileURLToPath(import.meta.url));
const tutorHome = join(homedir(), ".codebase-tutor");
const repositoryPath = (() => {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (arg) return resolve(arg);
  const registry = join(tutorHome, "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list.at(-1)!;  // 地址簿顺序 = 最近使用在后；取最后一条才是「你现在在弄的那个仓」
})();

function pct(numerator: number, denominator: number): string {
  return denominator ? `${((numerator / denominator) * 100).toFixed(1)}%（${numerator}/${denominator}）` : "未执行";
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const out: string[] = [];
const emit = (line = ""): void => { out.push(line); };

const index = indexRepository(repositoryPath);
const files = new Map(index.files.map((file) => [file.path, file.lines]));
const databaseFile = join(repositoryPath, ".tutor", "tutor.db");
if (!existsSync(databaseFile)) {
  console.log(`# B 档评测报告\n\n- 仓库 \`${repositoryPath}\`：**未执行**（tutor.db 缺失，flow 产物与 L1 摘要都没有数据源）`);
  process.exit(0);
}
const database = new DatabaseSync(databaseFile, { readOnly: true });

const flows: RepositoryFlow[] = [];
for (const row of database.prepare("SELECT payload FROM layer_cache WHERE cache_key LIKE 'flow:%'").all() as { payload: string }[]) {
  try {
    const parsed = JSON.parse(row.payload) as { flow?: RepositoryFlow };
    if (parsed.flow) flows.push(parsed.flow);
  } catch { /* 脏行跳过：评测脚本不修数据 */ }
}

// L1 摘要按「同文件最新一行」取（与 metrics 同口径），作为检索语料的「摘要在上」臂
const summaries = new Map<string, string>();
for (const row of database.prepare("SELECT summary FROM summaries ORDER BY created_at DESC").all() as { summary: string }[]) {
  try {
    const parsed = JSON.parse(row.summary) as { path?: string; summary?: string };
    if (typeof parsed.path === "string" && typeof parsed.summary === "string" && !summaries.has(parsed.path)) summaries.set(parsed.path, parsed.summary);
  } catch { /* 旧纯文本行：键口径变更前产物，跳过 */ }
}
// 第四臂的原料（还在只读句柄里）：某仓 + 某坐标系下的向量行与文本哈希。
// 坐标系 = 模型 + 粒度（`模型名` 是文件级，`模型名#symbol` 是函数级）。换任何一个都是换坐标，
// 拿旧模型或旧粒度的向量跟新查询算余弦，会得到「看起来像读数」的噪声。
const embedConfig = resolveEmbeddingConfig();
const denseModelLabel = embedConfig?.model ?? "未配置";
const symbolCoordinate = embedConfig ? `${embedConfig.model}#symbol` : "";
const storedHashes = new Map<string, string>();
const allVectors: StoredVector[] = [];
const symbolVectors: StoredVector[] = [];
// 只读句柄不能建表，而 v8 之前落盘的库根本没有 search_vector：先探一下，缺表就等于「还没嵌过」
const hasVectorTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_vector'").get() !== undefined;
if (embedConfig && hasVectorTable) {
  const readVectors = (coordinate: string, sink: StoredVector[]): number => {
    for (const row of database.prepare("SELECT path, content_hash FROM search_vector WHERE repository_id = ? AND model = ?").all(index.repositoryId, coordinate) as { path: string; content_hash: string }[]) {
      if (sink === allVectors) storedHashes.set(row.path, row.content_hash);
    }
    const rows = database.prepare("SELECT path, dim, vec FROM search_vector WHERE repository_id = ? AND model = ? ORDER BY path").all(index.repositoryId, coordinate) as { path: string; dim: number; vec: Uint8Array }[];
    for (const row of rows) sink.push(decodeVectorBlob(row.path, row.dim, row.vec));
    return rows.length;
  };
  readVectors(embedConfig.model, allVectors);
  readVectors(symbolCoordinate, symbolVectors);
}
database.close();

const caseDirectory = join(here, "..", "eval", "cases");
const caseFiles = readdirSync(caseDirectory).filter((name) => name.endsWith(".json"));

// 摘要含标识符率：slice-v2 口径（「至少点出一个真实英文标识符」）的直接读数；
// 连续 ≥5 位字母数字串才算，泛化短词（get、api）不计——与判分器同为零 token。
const withIdentifier = [...summaries.values()].filter((text) => /[A-Za-z][A-Za-z0-9]{4,}/.test(text)).length;

emit(`# B 档评测报告（${wantDense ? "确定性判分 + 查询嵌入实发" : "零 token 确定性判分"}）`);
emit(`生成时间：${new Date().toISOString()}｜仓库：\`${repositoryPath}\`（索引 ${index.files.length} 文件）`);
emit(`数据源：layer_cache flow ${flows.length} 条；L1 摘要 ${summaries.size} 个文件（含英文标识符 ${pct(withIdentifier, summaries.size)}）；用例文件 ${caseFiles.length} 份；检索向量 ${hasVectorTable ? `文件级 ${allVectors.length} 条 + 函数级 ${symbolVectors.length} 条（模型 ${denseModelLabel}）` : "表不存在"}`);
emit();

// ---------- 1/2. 存量 flow 产物：引用落地 + 边证据可核对 ----------
emit("## 1. 产物引用落地（模型写的文本里，每个 文件:行号 都要真实存在）");
emit("## 2. 边证据可核对（code 边须引到本边端点文件；static 边须至少引到一个存在文件）");
if (!flows.length) {
  emit("- **未执行**：layer_cache 无 flow 行。");
} else {
  const score = scoreFlowArtifacts(flows, files);
  emit(`- 引用落地：${pct(score.refs.ok, score.refs.total)}；问题引用 ${score.refs.problems.length} 条`);
  for (const problem of score.refs.problems.slice(0, 10)) emit(`  - \`${problem.raw}\` —— ${problem.why}`);
  if (score.refs.problems.length > 10) emit(`  - …另有 ${score.refs.problems.length - 10} 条`);
  emit(`- code 边证据核对：${pct(score.code.ok, score.code.total)}`);
  for (const bad of score.code.bad.slice(0, 10)) emit(`  - ${bad.key}：\`${bad.evidence}\``);
  if (score.code.bad.length > 10) emit(`  - …另有 ${score.code.bad.length - 10} 条`);
  emit(`- static 边证据核对：${pct(score.static.ok, score.static.total)}`);
  for (const bad of score.static.bad.slice(0, 10)) emit(`  - ${bad.key}：\`${bad.evidence}\``);
  if (score.static.bad.length > 10) emit(`  - …另有 ${score.static.bad.length - 10} 条`);
}
emit();

// ---------- 3. 检索 gold 命中（离线重放：词法三臂恒跑，dense/hybrid 两臂要 --dense） ----------
emit("## 3. 检索 gold 命中（hit@5 / recall@5，词法三臂 + dense/hybrid 的文件级与函数级四臂）");
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);
const analysis: RepositoryAnalysis = {
  repositoryId: index.repositoryId,
  generatedAt: new Date().toISOString(),
  graph: serializeGraph(graph),
  implementations: [],
  quality: { generatedAt: new Date().toISOString(), micro: [], macro: [] },
  versionStamp: "eval"
};
const corpusWith = buildSearchCorpus(index, analysis, summaries);
const corpusWithout = buildSearchCorpus(index, analysis, new Map());
let anyCaseRan = false;
// 用例集按「仓库路径包含 repository 名」匹配，但包含关系会串仓（dianping ⊂ dianping-agent2）：
// 只有被**更具体**（字符串更长且包含本条）的用例集盖住时才让位，同名的兄弟集（dianping 的关键词集与
// 整句中文集）都要跑——早先的「取最长者」写法会让第二个同名集被静默跳过，新加用例集等于没加。
const caseDocs = caseFiles.map((name) => ({ name, doc: JSON.parse(readFileSync(join(caseDirectory, name), "utf8")) as { repository: string; cases: SearchCase[] } }));
const matched = caseDocs.filter((entry) => repositoryPath.toLowerCase().includes(entry.doc.repository.toLowerCase()));
const takenOver = (entry: { name: string; doc: { repository: string } }): string | undefined => {
  const owner = matched.find((other) => other.name !== entry.name
    && other.doc.repository.length > entry.doc.repository.length
    && other.doc.repository.toLowerCase().includes(entry.doc.repository.toLowerCase()));
  return owner?.name;
};

// ---------- dense / hybrid 两臂的准备（唯一可能打网络的一步） ----------
const topOf = (corpus: typeof corpusWith, segment = false) => (query: string) => executeSearchCode(corpus, JSON.stringify({ query: segment ? segmentForLookup(query) : query, limit: 5 })).audit.topPaths;
const productTop = topOf(corpusWith);          // hybrid 融的正是这一路（产品现状，含兜底臂与两道闸）
const corpusPaths = new Set(corpusWith.entries.map((entry) => entry.path));
const liveVectors = allVectors.filter((vector) => corpusPaths.has(vector.path));
// 函数级向量按 `路径#符号#行` 存，池化前先用「文件部分在不在语料里」过滤
const liveSymbolVectors = symbolVectors.filter((vector) => corpusPaths.has(vector.path.split("#")[0]!));
// 语料文本哈希对不上 = 摘要重烧过或索引口径变了，向量还是旧文本嵌的：能跑，但读数偏旧，必须明说
const driftedText = embedConfig ? pendingUnits(fileUnits(corpusWith.entries), storedHashes).length : 0;
const distinctQueries = [...new Set(matched.flatMap((entry) => entry.doc.cases.map((item) => item.query)))];
const queryVectors = new Map<string, Float32Array>();
let denseSkipped = "";
if (wantDense) {
  if (!embedConfig) denseSkipped = "embedding 未配置（TUTOR_EMBED_BASE_URL / TUTOR_EMBED_MODEL / TUTOR_EMBED_API_KEY）";
  else if (!hasVectorTable) denseSkipped = "本库还没有 search_vector 表（早于 schema v8），先跑 pnpm search:embed -- --yes";
  else if (!liveVectors.length) denseSkipped = `search_vector 里没有本仓模型 ${denseModelLabel} 的可用向量（共 ${allVectors.length} 条，${allVectors.length - liveVectors.length} 条指向已不在索引里的路径）——先跑 pnpm search:embed -- --yes`;
  else {
    try {
      // 去重后一次嵌完（客户端内部按 ≤10 条分批）：同一句在「整集」与「调优/留出」两次计分里只嵌一次。
      // 查询向量**不落盘**（台架保持只读），所以每次 --dense 都会重发这几十条——量小、可接受，别误以为有缓存。
      const embedded = await createEmbeddingProvider(embedConfig).embed(distinctQueries);
      distinctQueries.forEach((query, position) => queryVectors.set(query, embedded[position]!));
    } catch (error) {
      denseSkipped = `查询嵌入失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
const denseOn = queryVectors.size > 0;
const symbolOn = liveSymbolVectors.length > 0;
const denseTop = (query: string): string[] => {
  const vector = queryVectors.get(query);
  return vector ? cosineTop(vector, liveVectors, 5).map((item) => item.path) : [];
};
// 查询原样送去编码，不切词：dense 臂的前提就是「整句能直接算相似」，再切一遍等于把它的功劳记到切词头上
const hybridTop = (query: string): string[] => reciprocalRankFusion([productTop(query), denseTop(query)]).slice(0, 5);
// 函数级：同一批查询向量（一次编码两用），只是文档侧换成函数单元、按文件取最高分池化回来
const denseSymbolTop = (query: string): string[] => {
  const vector = queryVectors.get(query);
  return vector ? cosineTopByFile(vector, liveSymbolVectors, 5).map((item) => item.path) : [];
};
const hybridSymbolTop = (query: string): string[] => reciprocalRankFusion([productTop(query), denseSymbolTop(query)]).slice(0, 5);

emit();
if (denseOn) {
  emit(`- dense/hybrid **已跑**：文件级向量 ${liveVectors.length} 条参与打分（另 ${allVectors.length - liveVectors.length} 条已不在索引里），函数级向量 ${symbolOn ? `${liveSymbolVectors.length} 单元 / ${new Set(liveSymbolVectors.map((vector) => vector.path.split("#")[0])).size} 文件` : "未建（跑 pnpm search:embed -- --level=symbol -- --yes 才出那两臂）"}，查询 ${queryVectors.size} 条已嵌入（记账见 llm.log 的 scene=embed）`);
  if (driftedText) emit(`- ⚠️ ${driftedText} 个单元的语料文本与向量哈希不一致（摘要重烧或索引变了）——dense 臂用的还是旧向量，要准数就重跑 pnpm search:embed -- --yes`);
} else {
  emit(`- dense/hybrid **未跑**：${wantDense ? denseSkipped : `加 --dense 会先对本集 ${distinctQueries.length} 条查询发 embedding 请求（这是整个脚本唯一花钱的一步；向量表 ${allVectors.length} 条 / 模型 ${denseModelLabel}）`}`);
}

// 臂的统一装配：加臂只在这张表里多一行，表格与分组读数自动跟着长
const armSet = (cases: SearchCase[]) => [
  { label: "产品现状（含兜底臂+两道闸）", short: "产品现状", arm: scoreSearchArm(cases, productTop) },
  { label: "无摘要", short: "无摘要", arm: scoreSearchArm(cases, topOf(corpusWithout)) },
  { label: "裸切词（无闸，对照上限）", short: "裸切词", arm: scoreSearchArm(cases, topOf(corpusWith, true)) },
  ...(denseOn ? [
    { label: `dense（文件级 ${denseModelLabel}）`, short: "dense-文件", arm: scoreSearchArm(cases, denseTop) },
    { label: "hybrid（文件级 RRF k=60）", short: "hybrid-文件", arm: scoreSearchArm(cases, hybridTop) },
    ...(symbolOn ? [
      { label: "dense（函数级池化）", short: "dense-函数", arm: scoreSearchArm(cases, denseSymbolTop) },
      { label: "hybrid（函数级 RRF k=60）", short: "hybrid-函数", arm: scoreSearchArm(cases, hybridSymbolTop) }
    ] : [])
  ] : [])
];
type ScoredArm = ReturnType<typeof scoreSearchArm>;

for (const { name, doc } of caseDocs) {
  if (!repositoryPath.toLowerCase().includes(doc.repository.toLowerCase())) {
    emit(`- \`${name}\`（repository=${doc.repository}）：与当前仓库不匹配，未执行`);
    continue;
  }
  const owner = takenOver({ name, doc });
  if (owner) {
    emit(`- \`${name}\`（repository=${doc.repository}）：被更具体的用例集 \`${owner}\` 接管，未执行`);
    continue;
  }
  anyCaseRan = true;
  const holdoutIds = new Set(doc.cases.filter((item) => item.holdout).map((item) => item.id));
  // 词法三臂对照：摘要在上（产品现状）/ 无摘要（摘要口径消融的对照）/ 摘要在上 + 中文整句切词
  // 第三臂只在**查询侧**动手（`segmentForLookup`），语料与打分一字不变——它量的是「词法臂输掉的那部分里，
  // 有多少只是没切词」。dense/hybrid 两臂才是「换了打分器」的那一格。
  const arms = armSet(doc.cases);
  emit();
  emit(`### ${name}`);
  emit();
  emit(`| 用例 | ${arms.map((entry) => entry.label).join(" | ")} |`);
  emit(`|---|${arms.map(() => "---|").join("")}`);
  const show = (result: ScoredArm["perCase"][number]) => `${result.hit ? "✅" : "❌"} ${(result.recall * 100).toFixed(0)}%｜${result.top[0]?.split("/").pop() ?? "（零命中）"}`;
  for (let i = 0; i < arms[0].arm.perCase.length; i += 1) {
    const cells = arms.map((entry) => entry.arm.perCase[i] ? show(entry.arm.perCase[i]!) : "—");
    emit(`| ${holdoutIds.has(arms[0].arm.perCase[i]!.id) ? `${arms[0].arm.perCase[i]!.id}（留）` : arms[0].arm.perCase[i]!.id} | ${cells.join(" | ")} |`);
  }
  emit();
  // 调优例与留出例分列报数：只有调优例涨 = 「对着考纲出题」的证据；两边同涨才是口径真的变好
  const cohorts = [
    { label: "调优", cases: doc.cases.filter((item) => !item.holdout) },
    { label: "留出", cases: doc.cases.filter((item) => item.holdout) }
  ].filter((cohort) => cohort.cases.length);
  for (const cohort of cohorts) {
    const cohortArms = armSet(cohort.cases);
    const rate = (arm: ScoredArm) => `hit@5 ${pct(arm.hitRate.numerator, arm.hitRate.denominator)}，平均 recall ${((arm.meanRecall || 0) * 100).toFixed(1)}%`;
    for (const entry of cohortArms) emit(`- 「${cohort.label}」${entry.label}：${rate(entry.arm)}`);
    // 负例分臂报数：合并计数会把「只有某一臂撞开」读成「所有臂都撞开」，那是给兜底臂记了不该记的账。
    // dense 天生返回 top-N 而不是「没有」，所以它的负例格一定是满的——这是它的结构事实，不是 bug。
    if (cohortArms[0].arm.negatives.length) {
      const parts = cohortArms.map((entry) => {
        const wrong = entry.arm.negatives.filter((item) => item.wrongHits.length > 0);
        return `${entry.short} ${wrong.length}/${entry.arm.negatives.length}${wrong.length ? `（${wrong.map((item) => `${item.id}→${item.wrongHits[0]?.split("/").pop()}`).join("、")}）` : ""}`;
      });
      emit(`- 「${cohort.label}」负例误命中：${parts.join("｜")}`);
    }
  }
  // dense 的分数面：想让它回答「仓里没有」，唯一的办法是设余弦下限；
  // n=2 的负例只够提出疑问，扩到每集 10 条之后这条扫描才判得了「下限到底存不存在」。
  // 两个粒度各扫一遍：粒度换了召回，也就换了「这一刀值不值」的答案。
  if (denseOn) {
    const cache = new Map<string, { path: string; score: number }[]>();
    const scoredList = (key: string, query: string, lister: (vector: Float32Array) => { path: string; score: number }[]) => {
      const cacheKey = `${key}|${query}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const vector = queryVectors.get(query);
      // 每条查询在每个坐标系上只算一次 top5（几百单元 × 1024 维的点乘不便宜），下限扫描与分数分布都复用这份结果
      const list = vector ? lister(vector) : [];
      cache.set(cacheKey, list);
      return list;
    };
    const floorSweep = (label: string, key: string, lister: (vector: Float32Array) => { path: string; score: number }[]) => {
      const positives = doc.cases.filter((item) => item.goldPaths.length);
      const negatives = doc.cases.filter((item) => !item.goldPaths.length);
      const atFloor = (floor: number) => {
        let hit = 0;
        for (const item of positives) {
          const gold = new Set(item.goldPaths);
          if (scoredList(key, item.query, lister).some((entry) => entry.score >= floor && gold.has(entry.path))) hit += 1;
        }
        return { hit, wrong: negatives.filter((item) => scoredList(key, item.query, lister).some((entry) => entry.score >= floor)).length };
      };
      const baseline = atFloor(0);
      const distribution = (values: number[]) => values.length ? `中位 ${(median(values) * 100).toFixed(1)}｜区间 ${(Math.min(...values) * 100).toFixed(1)}~${(Math.max(...values) * 100).toFixed(1)}` : "无样本";
      const top1 = (item: SearchCase) => scoredList(key, item.query, lister)[0]?.score ?? 0;
      emit(`- dense ${label} top1 余弦（×100，与命中无关）：正例 ${distribution(positives.map(top1))}｜负例 ${distribution(negatives.map(top1))}`);
      const parts = [`不设 ${pct(baseline.hit, positives.length)}｜负例误命中 ${pct(baseline.wrong, negatives.length)}`];
      for (const floor of [0.50, 0.54, 0.58, 0.62]) parts.push(`≥${(floor * 100).toFixed(0)} ${pct(atFloor(floor).hit, positives.length)}｜${pct(atFloor(floor).wrong, negatives.length)}`);
      emit(`- dense ${label} 余弦下限扫描（同一批向量、零额外请求）：${parts.join(" → ")}`);
      // 结论直接判「有没有那一刀」：负例全拒 且 正例 hit@5 不因 filtering 下降
      const cleanFloor = [0.50, 0.54, 0.58, 0.62, 0.66, 0.70].find((floor) => atFloor(floor).wrong === 0);
      const cleanHit = cleanFloor === undefined ? -1 : atFloor(cleanFloor).hit;
      emit(`  - ${label} 可用下限：${cleanFloor === undefined ? `无（扫到 0.70 仍没能把 ${negatives.length} 条负例全拒）` : cleanHit >= baseline.hit ? `有，≥${(cleanFloor * 100).toFixed(0)} 时负例全拒且正例 hit@5 不降（${pct(cleanHit, positives.length)}）` : `名义上有（≥${(cleanFloor * 100).toFixed(0)} 负例全拒），但正例 hit@5 从 ${pct(baseline.hit, positives.length)} 掉到 ${pct(cleanHit, positives.length)}——下限是拿召回换的，不是免费的`}`);
    };
    floorSweep("文件级", "file", (vector) => cosineTop(vector, liveVectors, 5));
    if (symbolOn) floorSweep("函数级", "symbol", (vector) => cosineTopByFile(vector, liveSymbolVectors, 5));
  }
}
if (!anyCaseRan) emit("- **未执行**：没有匹配当前仓库的用例文件。");
emit();

// ---------- 4. 教学法不变量机检（第 2 刀；数据源 = journal turn_text，零 token 只读） ----------
emit("## 4. 教学法不变量机检（判「设计上写了保证、且文本层可核对」的三条；语义类留第 3 刀裁判）");
const journalEvents = readJournal(repositoryPath);
const teachTurns = assembleTeachTurns(journalEvents);
if (!teachTurns.length) {
  emit("- **未执行**：journal 里没有 teach 回合（`turn_text` 上线后尚未产生真实教学对话，先攒样本）。");
} else {
  const score = scoreTeachInvariants(teachTurns, files);
  emit(`- 数据源：journal ${journalEvents.length} 事件 → ${score.turns} 个 teach 回合（回复截断致引用核对跳过 ${score.skippedTruncated} 条）`);
  for (const check of score.checks) {
    emit(`- ${check.label}：**${pct(check.pass, check.applicable)}**｜适用 ${check.applicable} 回合｜出处：${check.source}`);
    for (const miss of check.misses.slice(0, 8)) emit(`  - ⚠️ ${miss.at} 会话 ${miss.sessionId.slice(0, 8)}：${miss.excerpt}`);
    if (check.misses.length > 8) emit(`  - …另有 ${check.misses.length - 8} 条未过`);
  }
}
emit();
console.log(out.join("\n"));

/** 从 journal 事件流装配 teach 回合的机检视图：stage 取本回合最近的 hint_depth，pedagogy/style 取回合前最后一次 style_shift。 */
function assembleTeachTurns(events: ReturnType<typeof readJournal>): TeachTurn[] {
  const bySession = new Map<string, typeof events>();
  for (const event of events) {
    if (!event.sessionId) continue;
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }
  const turns: TeachTurn[] = [];
  for (const [sessionId, list] of bySession) {
    const chrono = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const hints = chrono.filter((e) => e.type === "hint_depth");
    const shifts = chrono.filter((e) => e.type === "style_shift");
    for (const event of chrono) {
      if (event.type !== "turn_text" || event.payload.scene !== "teach") continue;
      const at = event.at;
      const hint = hints.find((h) => h.at >= at) ?? hints.at(-1);
      const shift = [...shifts].reverse().find((s) => s.at <= at) ?? shifts[0];
      turns.push({
        sessionId,
        at,
        question: String(event.payload.question ?? ""),
        answer: String(event.payload.answer ?? ""),
        stage: typeof hint?.payload.stage === "string" ? hint.payload.stage : "",
        pedagogy: typeof shift?.payload.pedagogy === "string" ? shift.payload.pedagogy : "socratic",
        style: typeof shift?.payload.style === "number" ? shift.payload.style : 50,
        answerTruncated: event.payload.answer_truncated === true
      });
    }
  }
  return turns.sort((a, b) => a.at.localeCompare(b.at));
}
