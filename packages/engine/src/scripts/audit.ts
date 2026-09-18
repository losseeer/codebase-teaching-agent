import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";

const repositoryArgument = process.argv.slice(2).find((argument) => argument !== "--");
const repositoryPath = repositoryArgument ? resolve(repositoryArgument) : undefined;
if (!repositoryPath) throw new Error("Usage: pnpm phase0:audit -- /absolute/path/to/repository");
const index = indexRepository(repositoryPath);
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);
const candidates = [
  ...graph.entrypoints.map((anchor) => ({ item: anchor.path, explanation: `被识别为入口：${anchor.label}。源码锚点 ${anchor.path}:${anchor.line}。`, evidence: "direct" })),
  ...index.hotspots.map((hotspot) => ({ item: hotspot.path, explanation: `Git 历史中出现 ${hotspot.changes} 次文件变更，因此作为高维护关注点。`, evidence: "direct" })),
  ...index.files.slice(0, 20).map((file) => ({ item: file.path, explanation: `该文件位于课程模块地图中，按路径和静态结构归类。`, evidence: "inferred" }))
].slice(0, 20).map((item, index) => ({ sample_id: `A${String(index + 1).padStart(2, "0")}`, ...item, reviewer_verdict: "pending", reviewer_notes: "" }));
const auditDirectory = join(repositoryPath, ".tutor", "audits");
mkdirSync(auditDirectory, { recursive: true });
writeFileSync(join(auditDirectory, "selection-explanations.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), rubric: "逐项核对来源锚点是否支持解释；标记可信、待确认或不可信，并记录原因。", samples: candidates }, null, 2)}\n`);
console.log(join(auditDirectory, "selection-explanations.json"));
