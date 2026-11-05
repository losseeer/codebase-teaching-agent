/**
  [DEV ONLY] 一次性迁移：把「节点坐标全是 0」的旧图按分组重排一次。
  用法：pnpm exec tsx dev/mutate/relayout-diagrams.ts <仓库绝对路径> <repositoryId>
  只处理 layoutIfUnplaced 判为未布局的图；每张改动的图都会记一版，可回滚。
*/
import { resolve } from "node:path";

import { TutorDatabase } from "../../src/adapter/outbound/persistence/database.js";
import { applyStructure, diagramStoreFor, listDiagrams, readDiagram } from "../../src/adapter/outbound/persistence/diagrams.js";
import { layoutIfUnplaced } from "../../src/diagram/auto-layout.js";

const repoPath = process.argv[2];
const repositoryId = process.argv[3];
if (!repoPath || !repositoryId) {
  console.error("用法：tsx dev/mutate/relayout-diagrams.ts <仓库绝对路径> <repositoryId>");
  process.exit(2);
}

const database = new TutorDatabase(resolve(repoPath));
const store = diagramStoreFor(database, repositoryId);
let changed = 0;
for (const summary of listDiagrams(database, repositoryId)) {
  const full = readDiagram(database, repositoryId, summary.id);
  if (!full) continue;
  const laid = layoutIfUnplaced(full.body);
  if (!laid.applied) { console.log(`${summary.name}：已布局，跳过`); continue; }
  applyStructure(database, full, laid.body, "自动排版");
  changed += 1;
  console.log(`${summary.name}：已按分组重排（${laid.body.nodes.length} 节点 / ${laid.body.groups.length} 组）`);
}
database.close();
console.log(`完成：重排 ${changed} 张`);
