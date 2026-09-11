import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { indexRepository } from "../indexer/indexer.js";
import { TutorDatabase } from "../store/database.js";
import { LocalSummaryProvider } from "../summarizer/provider.js";
import { summarizeFiles } from "../summarizer/summarizer.js";
import { buildDependencyGraph } from "../depgraph/graph.js";
import { buildCourseTree } from "../coursetree/build.js";

const repositoryArgument = process.argv.slice(2).find((argument) => argument !== "--");
const repositoryPath = repositoryArgument ? resolve(repositoryArgument) : undefined;
if (!repositoryPath) throw new Error("Usage: pnpm phase0:prepare-study -- /absolute/path/to/repository");
const index = indexRepository(repositoryPath);
const database = new TutorDatabase(repositoryPath);
const provider = new LocalSummaryProvider();
const { summaries } = await summarizeFiles(repositoryPath, index.files, database, provider);
const tree = buildCourseTree({ repositoryId: index.repositoryId, modelVersion: provider.modelVersion, files: index.files, summaries, graph: buildDependencyGraph(repositoryPath, index.files) });
const node = tree.root.children[0]?.children[0] ?? tree.root;
const prompts = [35, 50, 65].map((style, index) => ({
  blind_id: `S${String(index + 1).padStart(2, "0")}`,
  source_node: node.id,
  response: style === 35 ? `请基于 ${node.anchors[0]?.path ?? "该节点"} 解释其控制流，并指出失效条件。` : style === 50 ? `请先定位 ${node.anchors[0]?.path ?? "该节点"} 的输入和输出，再说明它为何存在。` : `先看看 ${node.anchors[0]?.path ?? "这段代码"}：它先接到什么，再把结果交给谁？`,
  style_key: style
}));
const studyDirectory = join(repositoryPath, ".tutor", "studies");
mkdirSync(studyDirectory, { recursive: true });
writeFileSync(join(studyDirectory, "style-blind-materials.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), evaluator_instructions: "向评估者隐藏 style_key；要求比较可区分性、清晰度与证据可追溯性。", items: prompts }, null, 2)}\n`);
console.log(join(studyDirectory, "style-blind-materials.json"));
