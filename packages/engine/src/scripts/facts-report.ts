/**
  零 token、只读：对一个**已导入**的仓现场跑一遍控制流分析，只打印读数、不写任何东西。

  用法：pnpm facts:report /absolute/path/to/repository

  为什么值得单独有一个脚本：这类分析的代价必须先数清楚再决定接不接进导入流程——
  它要给多少个文件出图、一个仓的产物有多大、哪些函数画不出来。

  ⚠️ 符号**现读现算**（`extractSymbolsFromAst`），不取库里的 `analysis.graph.symbols`：
  本仓这类天天在改的仓，库里的符号表是上一次导入时的行号，拿它比今天的文件会造出一堆
  「对不上」的假事故（第一版就这么误判过一次）。生产路径在同一次导入里建符号表再建图，
  两边天然同 vintage；这里照同一口径来，读数才可比。
*/
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { languageCapabilitiesOf, type RepositoryIndex, type SymbolInfo } from "@codebase-tutor/shared";
import { extractSymbolsFromAst, loadSymbolParser, parseBackendStatus } from "../depgraph/parser.js";
import { buildFileCfg } from "../facts/cfg.js";

const repositoryPath = resolve(process.argv[2] ?? "");
if (!repositoryPath) throw new Error("用法：pnpm facts:report /absolute/path/to/repository");

await loadSymbolParser();
const backend = parseBackendStatus();

const db = new DatabaseSync(join(repositoryPath, ".tutor", "tutor.db"), { readOnly: true });
const state = db.prepare("SELECT index_json FROM repository_state WHERE index_json IS NOT NULL LIMIT 1").get() as { index_json: string } | undefined;
db.close();
if (!state) throw new Error("这个仓还没有索引产物（.tutor/tutor.db 里没有 index_json）：先导入。");

const index = JSON.parse(state.index_json) as RepositoryIndex;

let files = 0;
let drawn = 0;
let truncated = 0;
let blocks = 0;
let edges = 0;
let bytes = 0;
let maxComplexity = 0;
let gone = 0;
let sample = "";
const skips = new Map<string, number>();
const drift: string[] = [];
const languages = new Map<string, { files: number; ast: number; none: number }>();
const note = (reason: string): void => void skips.set(reason, (skips.get(reason) ?? 0) + 1);

for (const file of index.files) {
  const absolute = join(repositoryPath, file.path);
  if (!existsSync(absolute)) {
    gone += 1;
    continue;
  }
  let content: string;
  try {
    content = readFileSync(absolute, "utf8");
  } catch (error) {
    note(`读不出来：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    continue;
  }
  const symbols: SymbolInfo[] = extractSymbolsFromAst(file.path, content) ?? [];
  if (!symbols.some((symbol) => symbol.kind === "function" || symbol.kind === "method")) continue;
  const language = languageCapabilitiesOf(file.path).language;
  const fact = buildFileCfg(file.path, content, symbols, language);
  const row = languages.get(language) ?? { files: 0, ast: 0, none: 0 };
  languages.set(language, row);
  row.files += 1;
  if (fact.backend === "ast") row.ast += 1;
  else row.none += 1;
  files += 1;
  drawn += fact.functions.length;
  bytes += JSON.stringify(fact).length;
  for (const functionGraph of fact.functions) {
    blocks += functionGraph.blocks.length;
    edges += functionGraph.edges.length;
    maxComplexity = Math.max(maxComplexity, functionGraph.complexity);
    if (functionGraph.truncated) truncated += 1;
  }
  for (const skip of fact.skipped ?? []) {
    const reason = skip.reason.replace(/\d+/g, "N");
    note(reason);
    if (reason.includes("判据漂了") && drift.length < 5) drift.push(`${file.path} ${skip.name}`);
  }
  if (!sample && fact.functions.some((item) => item.complexity >= 4)) {
    const graph = fact.functions.find((item) => item.complexity >= 4)!;
    sample = [`${file.path} :: ${graph.name}() 复杂度 ${graph.complexity}`, ...graph.blocks.map((block) => `  块 ${block.id} ${block.kind} [${block.startLine}-${block.endLine}] ${block.statements.join(",")}`), ...graph.edges.map((edge) => `  边 ${edge.from} → ${edge.to} (${edge.kind})`)].join("\n");
  }
}

const emit = (line: string): void => void process.stdout.write(`${line}\n`);
emit(`仓库：${repositoryPath}`);
emit(`语法解析：${backend.backend}${backend.reason ? `（${backend.reason}）` : ""}`);
emit(`索引内文件 ${index.files.length} 个${gone ? `，其中 ${gone} 个已不在盘上（索引比代码旧）` : ""}`);
emit(`出了图：${drawn} 个函数（${files} 个文件），块 ${blocks} 个、边 ${edges} 条，平均 ${drawn ? (blocks / drawn).toFixed(1) : 0} 块/函数`);
emit(`产物体积：约 ${(bytes / 1024).toFixed(0)} KB（整仓一次性），最大圈复杂度 ${maxComplexity}，打满块数上限的 ${truncated} 个`);
emit(`按语言（文件数 / 出了图 / 没规则）：${[...languages.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 10).map(([language, row]) => `${language} ${row.files}/${row.ast}/${row.none}`).join("、") || "一个都没有"}`);
emit(`没出图的函数体按原因：${skips.size ? [...skips.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${count} × ${reason}`).join("；") : "一条都没有"}`);
if (drift.length) emit(`符号表与语法树对不上的（要逐个看，前 5 条）：\n  ${drift.join("\n  ")}`);
if (sample) emit(`\n一个样例：\n${sample}`);
