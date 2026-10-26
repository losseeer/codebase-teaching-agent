/**
  零 token、只读：对已导入的仓现场跑一遍函数级分析（控制流图 + 数据流），只打印读数、不写任何东西。
  用法：pnpm facts:report /absolute/path/to/repository
  接进导入流程之前要先数清代价：要给多少个文件出图、一个仓的产物有多大、哪些函数画不出来。
*/
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { languageCapabilitiesOf, type RepositoryIndex, type SymbolInfo } from "@codebase-tutor/domain";

import { extractSymbolsFromAst, loadSymbolParser, parseBackendStatus } from "../../src/depgraph/parser.js";
import { analyzeFile } from "../../src/facts/build.js";
import { graphExtensions } from "../../src/depgraph/graph.js";
import { registryEligible } from "../../src/facts/registration.js";

const repositoryPath = resolve(process.argv[2] ?? "");
if (!repositoryPath) throw new Error("用法：pnpm facts:report /absolute/path/to/repository");

await loadSymbolParser();
const backend = parseBackendStatus();

const databaseFile = join(repositoryPath, ".tutor", "tutor.db");
if (!existsSync(databaseFile)) throw new Error(`打不开 ${databaseFile}：这个路径下没有 .tutor/tutor.db（注意 pnpm --filter 会把工作目录换到 packages/engine，请传绝对路径）`);
const db = new DatabaseSync(databaseFile, { readOnly: true });
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
let variables = 0;
let uses = 0;
let unresolved = 0;
let flowTruncated = 0;
let declaredTypes = 0;
let typeEdges = 0;
let typeResolved = 0;
let typeAmbiguous = 0;
let registryEntries = 0;
const registryKinds = new Map<string, number>();
const skips = new Map<string, number>();
const drift: string[] = [];
const languages = new Map<string, { files: number; ast: number; none: number }>();
const note = (reason: string): void => void skips.set(reason, (skips.get(reason) ?? 0) + 1);
const allSymbols: SymbolInfo[] = [];
const parsed = new Map<string, { content: string; symbols: SymbolInfo[] }>();

// 两趟：先把全仓符号收齐，再逐文件算产物。符号现读现算（`extractSymbolsFromAst`），不取库里的
// `analysis.graph.symbols`：那是上次导入时的行号，比今天的文件会造出一堆假「对不上」。
// 落点反查必须拿整仓符号表，只给当前文件那一份几乎全都查不到声明——与产品同口径，读数才可比。
for (const file of index.files) {
  // 与产品同一道闸门：没有语法的文件（配置、样式、文档）不进产物层，
  // 把它们算进「没规则」那一栏会让两边对不上
  if (!graphExtensions.includes(file.extension.toLowerCase()) && !registryEligible(file.path, false)) continue;
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
  const symbols = extractSymbolsFromAst(file.path, content) ?? [];
  allSymbols.push(...symbols);
  parsed.set(file.path, { content, symbols });
}

for (const [path, entry] of [...parsed.entries()].sort()) {
  const { content, symbols } = entry;
  const language = languageCapabilitiesOf(path).language;
  const facts = analyzeFile(path, content, symbols, language, allSymbols);
  const cfg = facts.cfg;
  if (!graphExtensions.includes(path.slice(path.lastIndexOf(".")).toLowerCase())) {
    // 清单与 SPI：没有语法树，只有注册索引这一类产物
    registryEntries += facts.registry.entries.length;
    bytes += JSON.stringify(facts.registry).length;
    for (const entry of facts.registry.entries) registryKinds.set(entry.kind, (registryKinds.get(entry.kind) ?? 0) + 1);
    continue;
  }
  const row = languages.get(language) ?? { files: 0, ast: 0, none: 0 };
  languages.set(language, row);
  if (cfg.backend === "none") {
    row.none += 1;
    for (const skip of cfg.skipped ?? []) note(skip.reason.replace(/\d+/g, "N"));
    continue;
  }
  row.files += 1;
  row.ast += 1;
  files += 1;
  drawn += cfg.functions.length;
  bytes += JSON.stringify(cfg).length + JSON.stringify(facts.dataflow).length;
  for (const functionGraph of cfg.functions) {
    blocks += functionGraph.blocks.length;
    edges += functionGraph.edges.length;
    maxComplexity = Math.max(maxComplexity, functionGraph.complexity);
    if (functionGraph.truncated) truncated += 1;
  }
  for (const flow of facts.dataflow.functions) {
    variables += flow.variables.length;
    uses += flow.variables.reduce((sum, item) => sum + item.uses.length, 0);
    unresolved += flow.unresolved?.length ?? 0;
    if (flow.truncated) flowTruncated += 1;
  }
  declaredTypes += facts.types.types.length;
  for (const row of facts.types.types) for (const edge of row.relations) {
    typeEdges += 1;
    if (edge.toFile) typeResolved += 1;
    if (edge.ambiguous?.length) typeAmbiguous += 1;
  }
  bytes += JSON.stringify(facts.types).length + JSON.stringify(facts.registry).length;
  registryEntries += facts.registry.entries.length;
  for (const entry of facts.registry.entries) registryKinds.set(entry.kind, (registryKinds.get(entry.kind) ?? 0) + 1);
  for (const skip of cfg.skipped ?? []) {
    const reason = skip.reason.replace(/\d+/g, "N");
    note(reason);
    if (reason.includes("判据漂了") && drift.length < 5) drift.push(`${path} ${skip.name}`);
  }
  if (!sample && cfg.functions.some((item) => item.complexity >= 4)) {
    const graph = cfg.functions.find((item) => item.complexity >= 4)!;
    const flow = facts.dataflow.functions.find((item) => item.symbolId === graph.symbolId);
    sample = [
      `${path} :: ${graph.name}() 复杂度 ${graph.complexity}`,
      ...graph.blocks.map((block) => `  块 ${block.id} ${block.kind} [${block.startLine}-${block.endLine}] ${block.statements.join(",")}`),
      ...graph.edges.map((edge) => `  边 ${edge.from} → ${edge.to} (${edge.kind})`),
      ...(flow?.variables ?? []).slice(0, 4).map((item) => `  变量 ${item.name}：定义 ${item.defs.map((def) => `${def.line}(${def.role})`).join(" ")}｜${item.uses.map((use) => `${use.line}←[${use.reaches.join(",")}]`).join(" ")}`),
      ...(flow?.unresolved?.length ? [`  到不了定义的读：${flow.unresolved.slice(0, 4).map((item) => `${item.name}@${item.line}`).join(" ")}`] : [])
    ].join("\n");
  }
}

const emit = (line: string): void => void process.stdout.write(`${line}\n`);
emit(`仓库：${repositoryPath}`);
emit(`语法解析：${backend.backend}${backend.reason ? `（${backend.reason}）` : ""}`);
emit(`索引内文件 ${index.files.length} 个${gone ? `，其中 ${gone} 个已不在盘上（索引比代码旧）` : ""}`);
emit(`出了图：${drawn} 个函数（${files} 个文件），块 ${blocks} 个、边 ${edges} 条，平均 ${drawn ? (blocks / drawn).toFixed(1) : 0} 块/函数`);
emit(`产物体积：约 ${(bytes / 1024).toFixed(0)} KB（整仓一次性，含控制流图 + 数据流 + 类型关系），最大圈复杂度 ${maxComplexity}，打满块数上限的 ${truncated} 个`);
emit(`数据流：${variables} 个变量、${uses} 次使用，其中 ${unresolved} 次读不到任何可达定义（外层变量与导入名都算在这里），打满上限的 ${flowTruncated} 个函数`);
emit(`类型关系：${declaredTypes} 个声明类型、${typeEdges} 条边，其中 ${typeResolved} 条反查到了仓内文件、${typeAmbiguous} 条同名多解（只列候选，不挑一个）`);
emit(`注册与配置索引：${registryEntries} 条 —— ${[...registryKinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`).join("、") || "一条都没有"}`);
emit(`按语言（文件数 / 出了图 / 没规则）：${[...languages.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 10).map(([language, row]) => `${language} ${row.files}/${row.ast}/${row.none}`).join("、") || "一个都没有"}`);
emit(`没出图的函数体按原因：${skips.size ? [...skips.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${count} × ${reason}`).join("；") : "一条都没有"}`);
if (drift.length) emit(`符号表与语法树对不上的（要逐个看，前 5 条）：\n  ${drift.join("\n  ")}`);
if (sample) emit(`\n一个样例：\n${sample}`);
