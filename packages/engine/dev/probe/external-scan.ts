/**
  外部包名的词典覆盖率读数（零 token、只读、不发请求）。
  用法：`pnpm arch:externals [仓库路径] [--unmatched]`
*/
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadDotEnv } from "../../src/boot.js";
import { indexRepository } from "../../src/indexer/indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { EXTERNAL_CATEGORY_LABEL, groupExternals } from "@codebase-tutor/analysis";
import type { ExternalCategory } from "@codebase-tutor/domain";

loadDotEnv();

const argv = process.argv.slice(2);
const onlyUnmatched = argv.includes("--unmatched");
const given = argv.find((value) => !value.startsWith("--") && value.includes("/"));
const registryFile = process.env.TUTOR_REGISTRY_FILE ?? join(homedir(), ".codebase-tutor", "repositories.json");
const repositories = given
  ? [resolve(given)]
  : existsSync(registryFile)
    ? (((JSON.parse(readFileSync(registryFile, "utf8")).repositories ?? []) as string[]).map((path) => resolve(path)))
    : [];
if (!repositories.length) throw new Error("没给仓库路径，地址簿也是空的");

const grand = new Map<ExternalCategory, number>();
for (const repositoryPath of repositories) {
  const index = indexRepository(repositoryPath);
  const graph = buildDependencyGraph(repositoryPath, index.files);
  // 聚合口径与产品侧共用 groupExternals。
  const groups = groupExternals(Object.fromEntries(graph.externals));
  const identities = [...new Set(groups.flatMap((group) => group.identities))].length;
  const known = groups.filter((group) => group.category !== "other").length;
  const unrecognized = groups.filter((group) => group.category === "other");
  for (const group of groups) grand.set(group.category, (grand.get(group.category) ?? 0) + 1);
  console.log(`\n=== ${repositoryPath}`);
  console.log(`行 ${groups.length}（认出 ${known}｜未识别 ${unrecognized.length}）｜包名身份 ${identities} 个｜有外部名的文件 ${graph.externals.size}/${index.files.length}`);
  if (!onlyUnmatched) {
    for (const category of Object.keys(EXTERNAL_CATEGORY_LABEL) as ExternalCategory[]) {
      const list = groups.filter((group) => group.category === category);
      if (!list.length) continue;
      console.log(`  ${EXTERNAL_CATEGORY_LABEL[category]}：${list.slice(0, 8).map((group) => `${group.display}×${group.files.length}`).join("、")}${list.length > 8 ? ` …另 ${list.length - 8} 行` : ""}`);
    }
  }
  if (onlyUnmatched || unrecognized.length) {
    const shown = unrecognized.slice(0, onlyUnmatched ? 40 : 12);
    console.log(`  未识别（${EXTERNAL_CATEGORY_LABEL.other}）：${shown.map((group) => `${group.display}×${group.files.length}`).join("、")}${unrecognized.length > shown.length ? ` …另 ${unrecognized.length - shown.length} 行` : ""}`);
  }
}

console.log(`\n合计各类身份数：${Object.keys(EXTERNAL_CATEGORY_LABEL).map((category) => `${EXTERNAL_CATEGORY_LABEL[category as ExternalCategory]}=${grand.get(category as ExternalCategory) ?? 0}`).join(" ")}`);
