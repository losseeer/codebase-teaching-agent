/**
  「P1 加外部包名」的红线探针（**零 token、只读、不写库**）。

  存在的理由：外部包名要进 `DependencyGraph`，而流程视图的缓存键直接哈希它读到的那份证据
  （`flowCacheKeyOf` 的 payload 就是 `buildFlowDigest` 的产物）。externals 一旦被顺手塞进 digest
  或混进 `imports`，全部已缓存流程翻键 = 每个入口重烧一发 ≈¥0.17 的付费调用。
  「改完键没翻」不能靠读代码保证：先存基线，改完再对着基线逐条比。

  用法：
    pnpm arch:keyprobe --save /tmp/arch-keys.json        算快照并落盘
    pnpm arch:keyprobe --compare /tmp/arch-keys.json     与基线逐条比，有任何差异就 exit 1
  键的构造与产品**共用同一个函数**（`flowCacheKeyOf` → `layerCacheKey`），两套判据才是一条心
  （同 `pnpm flow:reburn --check` 的立场）。provider 用钉死的假 modelVersion：
  这里比的是「同一份输入在改动前后算出的键」，不是「能不能命中线上那一行」。
*/
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { loadDotEnv } from "../config/dotenv.js";
import { hash } from "../lib.js";
import { indexRepository } from "../indexer/indexer.js";
import { flowCacheKeyOf } from "../flows/flow.js";
import { TutorDatabase } from "../store/database.js";

loadDotEnv();

const argv = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const saveTo = valueOf("save");
const compareTo = valueOf("compare");

/** 钉死的档：`modelVersion` 进键，两侧必须同一个字符串。探针不发任何请求。 */
const probeProvider: LlmProvider = {
  name: "arch-key-probe",
  modelVersion: "probe:fixed-model-version",
  async complete(_input: LlmCompletionInput): Promise<LlmCompletion> {
    throw new Error("探针不该发请求：complete() 被调到说明有路径绕开了「只算键」这条路");
  }
};

interface RepoSnapshot {
  repositoryPath: string;
  repositoryId: string;
  hasArtifacts: boolean;
  /** 红线本身：有任何一个仓的这一格是 true，就说明 externals 漏进了流程证据——不用比键也已经踩线。 */
  digestMentionsExternals: boolean;
  /** 每个入口一条：键 + digest 体积（体积变了就是漏进证据里了） */
  flowKeys: { entryPath: string; key: string; digestSize: number }[];
}

function registry(): string[] {
  const file = process.env.TUTOR_REGISTRY_FILE ?? join(homedir(), ".codebase-tutor", "repositories.json");
  if (!existsSync(file)) throw new Error(`地址簿不存在：${file}`);
  return ((JSON.parse(readFileSync(file, "utf8")).repositories ?? []) as string[]).map((path) => resolve(path));
}

const snapshots: RepoSnapshot[] = [];
for (const repositoryPath of registry()) {
  const store = new TutorDatabase(repositoryPath);
  try {
    const index = indexRepository(repositoryPath);
    const analysis = store.getAnalysis(index.repositoryId);
    if (!analysis) {
      snapshots.push({ repositoryPath, repositoryId: index.repositoryId, hasArtifacts: false, digestMentionsExternals: false, flowKeys: [] });
      continue;
    }
    const summaries = new Map(store.getLatestFileSummaries().map((row) => [row.path, row.summary]));
    let digestMentionsExternals = false;
    const flowKeys = [...new Set(analysis.graph.entrypoints.map((entry) => entry.path))]
      .map((entryPath) => {
        const entry = analysis.graph.entrypoints.find((item) => item.path === entryPath)!;
        const built = flowCacheKeyOf({ repositoryPath, index, analysis, entry, provider: probeProvider, summaries, repositoryId: index.repositoryId });
        if (built && JSON.stringify(built.digest).includes("externals")) digestMentionsExternals = true;
        // 算不出键是产品既有行为（入口不在证据里走直降视图），如实记空键，不编一个
        return { entryPath, key: built?.key ?? "<无键>", digestSize: built ? JSON.stringify(built.digest).length : 0 };
      })
      .sort((left, right) => left.entryPath.localeCompare(right.entryPath));
    snapshots.push({ repositoryPath, repositoryId: index.repositoryId, hasArtifacts: true, digestMentionsExternals, flowKeys });
  } finally {
    store.close();
  }
}

const fingerprint = hash(JSON.stringify(snapshots.map((repo) => [repo.repositoryId, repo.flowKeys.map((row) => [row.entryPath, row.key, row.digestSize])])));
console.log(`零 token 探针｜${snapshots.length} 个仓｜键指纹 ${fingerprint.slice(0, 16)}`);
for (const repo of snapshots) {
  const name = repo.repositoryPath.split("/").pop() ?? repo.repositoryPath;
  if (!repo.hasArtifacts) { console.log(`  ${name}  尚无分析产物，跳过`); continue; }
  const keyless = repo.flowKeys.filter((row) => row.key === "<无键>").length;
  console.log(`  ${name}  入口 ${repo.flowKeys.length} 个（算不出键 ${keyless}）｜digest 合计 ${repo.flowKeys.reduce((sum, row) => sum + row.digestSize, 0)} 字符｜digest 里出现 externals：${repo.digestMentionsExternals ? "**是（已踩红线）**" : "否"}`);
}

if (saveTo) {
  writeFileSync(resolve(saveTo), JSON.stringify({ fingerprint, snapshots }, null, 2), "utf8");
  console.log(`\n快照已落盘：${resolve(saveTo)}`);
}

if (compareTo) {
  const baseline = JSON.parse(readFileSync(resolve(compareTo), "utf8")) as { fingerprint: string; snapshots: RepoSnapshot[] };
  const differences: string[] = [];
  const leaked = snapshots.filter((repo) => repo.digestMentionsExternals);
  if (leaked.length) {
    console.log(`\n**红线直接踩了**：这 ${leaked.length} 个仓的流程 digest 里出现了 externals 字段——不用比键，改证据就是改键：`);
    for (const repo of leaked) console.log(`  - ${repo.repositoryPath}`);
    process.exit(1);
  }
  for (const repo of snapshots) {
    const old = baseline.snapshots.find((item) => item.repositoryPath === repo.repositoryPath);
    if (!old) { differences.push(`基线里没有这个仓：${repo.repositoryPath}`); continue; }
    for (const row of repo.flowKeys) {
      const oldRow = old.flowKeys.find((item) => item.entryPath === row.entryPath);
      if (!oldRow) { differences.push(`${repo.repositoryId} 基线里没有这个入口的键：${row.entryPath}`); continue; }
      if (oldRow.key !== row.key) differences.push(`${repo.repositoryId} 流程键翻了：${row.entryPath}\n      前 …${oldRow.key.slice(-16)}\n      后 …${row.key.slice(-16)}`);
      if (oldRow.digestSize !== row.digestSize) differences.push(`${repo.repositoryId} digest 体积变了：${row.entryPath} ${oldRow.digestSize} → ${row.digestSize}（这一条本身不定成因：源码改过也会变，是不是漏进 externals 看上面那行「digest 里出现 externals」）`);
    }
    for (const oldRow of old.flowKeys) if (!repo.flowKeys.some((row) => row.entryPath === oldRow.entryPath)) differences.push(`${repo.repositoryId} 当前快照丢了入口：${oldRow.entryPath}`);
  }
  if (differences.length) {
    console.log(`\n**差异 ${differences.length} 处**。先分清两种成因再看要不要停手：`);
    console.log("  ① 这个仓的源码被改过（digest 吃每个文件的行数/符号清单）⇒ 键必然翻，属于正常失效；");
    console.log("  ② externals 漏进证据 ⇒ 全线翻键、真烧钱。判据看上面那行「digest 里出现 externals」，是「否」就排除②；");
    console.log("  本次差异落在哪些仓：" + [...new Set(differences.map((line) => line.split(" ")[0]))].join("、"));
    for (const line of differences.slice(0, 40)) console.log(`  - ${line}`);
    process.exit(1);
  }
  console.log(`\n键一条没翻：${snapshots.reduce((sum, repo) => sum + repo.flowKeys.length, 0)} 个流程键与基线逐条相等（键指纹同为 ${fingerprint.slice(0, 16)}${baseline.fingerprint === fingerprint ? "" : "，但基线指纹不同：说明只比了逐条键、入口集合有增删，见上面差异"}）。`);
} else if (saveTo) {
  console.log("下一步：改完代码跑 `pnpm arch:keyprobe --compare <这份快照>`。");
}
