/**
  一次性判据重放（零 token、只读）：用真仓 tutor.db 里的存量摘要 + 当前结构切片，
  对比「旧判据（整名默写过半）」与「新判据（anchor-v2 特征词锚定 any-of）」的 coverageLow 结论。
  不写任何文件：DB 以 readOnly 打开。
*/
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";
import { classifyFileRoles, fileStructureOf } from "../depgraph/roles.js";
import { buildFileSlices } from "../summarizer/slice.js";
import { coverageOf } from "../summarizer/summarizer.js";

const repositoryPath = resolve(process.argv[2] ?? "");
if (!repositoryPath) throw new Error("Usage: pnpm tsx src/scripts/replay-coverage.ts /absolute/path/to/repository");

// 旧判据的原样复刻（仅此处允许两份实现：它是「被替换前的尺子」，不该进生产代码）
function legacyLow(path: string, names: string[], summary: string): boolean {
  const text = summary.toLowerCase().split(path.toLowerCase()).join(" ");
  const mentioned = names.filter((name) => text.includes(name.toLowerCase())).length;
  return names.length > 0 && mentioned * 2 < names.length;
}

const index = indexRepository(repositoryPath);
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);
const structure = fileStructureOf(index.files, graph);
const slices = buildFileSlices(structure, classifyFileRoles(structure));

const db = new DatabaseSync(join(repositoryPath, ".tutor", "tutor.db"), { readOnly: true });
type StoredRow = { path: string; summary: string; coverage?: { checked?: number; mentioned?: number; low?: boolean; rule?: string } };
const rows = db.prepare("SELECT summary FROM summaries ORDER BY created_at DESC LIMIT 4000").all() as { summary: string }[];
db.close();

const latest = new Map<string, StoredRow>();
for (const row of rows) {
  try {
    const parsed = JSON.parse(row.summary) as StoredRow;
    if (typeof parsed.path === "string" && typeof parsed.summary === "string" && !latest.has(parsed.path)) latest.set(parsed.path, parsed);
  } catch { /* 非 JSON 旧行跳过 */ }
}

let oldLow = 0;
let newLow = 0;
let bothLow = 0;
let rescued = 0;
let vacuous = 0;
const flipExamples: string[] = [];
const stillLowExamples: string[] = [];
for (const [path, row] of latest) {
  const slice = slices.get(path);
  if (!slice) { vacuous += 1; continue; }
  const names = slice.entries.slice(0, 3).map((entry) => entry.name);
  if (!names.length) { vacuous += 1; continue; }
  const was = legacyLow(path, names, row.summary);
  const now = coverageOf({ path, entries: slice.entries }, row.summary).low;
  if (was) oldLow += 1;
  if (now) newLow += 1;
  if (was && now) { bothLow += 1; if (stillLowExamples.length < 5) stillLowExamples.push(`${path} ｜ ${row.summary}`); }
  if (was && !now) { rescued += 1; if (flipExamples.length < 6) flipExamples.push(`${path} ｜ ${row.summary}`); }
}

console.log(`存量摘要行（按文件最新）：${latest.size}；有切片且有 top-3 符号、可判定：${latest.size - vacuous}；无从判定（无行/无符号）：${vacuous}`);
console.log(`coverageLow：旧判据 ${oldLow}（${((oldLow / Math.max(1, latest.size - vacuous)) * 100).toFixed(1)}%）→ 新判据 ${newLow}（${((newLow / Math.max(1, latest.size - vacuous)) * 100).toFixed(1)}%）；救回 ${rescued}、两把尺子都判低 ${bothLow}`);
console.log("\n—— 被新判据救回的样例 ——");
for (const line of flipExamples) console.log(`· ${line}`);
console.log("\n—— 仍然判低的样例（真·没锚上任何符号）——");
for (const line of stillLowExamples) console.log(`· ${line}`);
