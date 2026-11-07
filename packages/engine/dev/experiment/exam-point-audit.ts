/**
  离线抽检：给一个仓路径，按技能考点表跑 probe，产出待人工标注的样本清单。
  不花 token、不启动服务、不写产品数据。

  用法：pnpm --filter @codebase-tutor/engine exec tsx dev/experiment/exam-point-audit.ts <repoPath> [outDir]
  输出：<outDir>/<repoName>.audit-samples.json
  人工给每条样本标 canExam=true/false 后，用 decideTier(aRate,bRate) 算档位，
  再用 tiersOfDecisions() 汇总成 PointTiers 交给 judgeThemeLandings。
*/
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import { buildPointIndex, matchPoint, type BodyOf, type LandingContext } from "../../src/exercises/exam-points.js";
import { buildAuditSamples, decideTier, tiersOfDecisions, type TierDecision } from "../../src/exercises/exam-point-audit.js";
import type { SearchCorpus } from "../../src/source/search-code.js";

const SKILL_ROOT = join(import.meta.dirname ?? "", "../../skills", "exercise-code-concepts");
const CODE_EXT = new Set([".java", ".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".kt", ".rs"]);
const MAX_FILES = 4000;

const bodyOf: BodyOf = (_name, file = "SKILL.md") => {
  try { return readFileSync(join(SKILL_ROOT, file), "utf8"); } catch { return undefined; }
};

function collect(root: string, dir = "", out: string[] = []): string[] {
  if (out.length >= MAX_FILES) return out;
  let entries: string[];
  try { entries = readdirSync(join(root, dir)); } catch { return out; }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "target" || entry === "dist") continue;
    const path = join(dir, entry);
    const full = join(root, path);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) collect(root, path, out);
    else if (CODE_EXT.has(extname(entry)) && out.length < MAX_FILES) out.push(path);
  }
  return out;
}

function corpusOf(root: string, paths: string[]): { corpus: SearchCorpus; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const entries = paths.map((path) => {
    let text = "";
    try { text = readFileSync(join(root, path), "utf8"); } catch { /* 读不到就只留路径 */ }
    texts.set(path, text);
    const units = [...text.matchAll(/\b(?:class|interface|struct|func|function|def|method)\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => ({ name: match[1]!, line: text.slice(0, match.index).split("\n").length }));
    const names = [...new Set(units.map((unit) => unit.name))];
    return {
      path, pathWords: path.toLowerCase(), lines: text ? text.split("\n").length : undefined,
      symbols: names, symbolText: names.join(" ").toLowerCase(), units, summary: ""
    };
  });
  return { corpus: { entries }, texts };
}

/** 第二模式：把人工标好 canExam 的样本汇总成档位文件，回灌给 judgeThemeLandings。 */
if (process.argv[2] === "--tiers") {
  const samplesFile = process.argv[3];
  const outFile = process.argv[4] ?? join(SKILL_ROOT, "point-tiers.json");
  if (!samplesFile) {
    console.error("用法: tsx dev/experiment/exam-point-audit.ts --tiers <audit-samples.json> [point-tiers.json]");
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(samplesFile, "utf8")) as {
    audits: { pointId: string; decision?: string; samples: { group: "A" | "B"; canExam: boolean | null }[] }[];
  };
  // 观察轮数按条目累计：连续落在 25–50% 观察区 3 轮才降灰区（v8 第 6 章）。
  let previous: { observeRounds?: Record<string, number> } = {};
  try { previous = JSON.parse(readFileSync(outFile, "utf8")) as typeof previous; } catch { /* 首轮 */ }
  const rounds = { ...(previous.observeRounds ?? {}) };
  const decisions: Record<string, TierDecision> = {};
  for (const audit of report.audits) {
    if (audit.decision === "insufficient") { decisions[audit.pointId] = "insufficient"; rounds[audit.pointId] = 0; continue; }
    const marked = audit.samples.filter((sample) => typeof sample.canExam === "boolean");
    const inGroup = (group: "A" | "B") => marked.filter((sample) => sample.group === group);
    // 标注不足或 B 组没有样本（命中 10–19 条）时不定档，保持观察。
    if (marked.length < 5 || !inGroup("B").length) { decisions[audit.pointId] = "observe"; continue; }
    const rate = (group: "A" | "B"): number => {
      const rows = inGroup(group);
      return rows.filter((sample) => sample.canExam === true).length / rows.length;
    };
    const aRate = rate("A");
    const decision = decideTier(aRate, rate("B"), rounds[audit.pointId] ?? 0);
    rounds[audit.pointId] = aRate >= 0.25 && aRate < 0.5 ? (rounds[audit.pointId] ?? 0) + 1 : 0;
    decisions[audit.pointId] = decision;
  }
  const tiers = tiersOfDecisions(decisions);
  writeFileSync(outFile, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), observeRounds: rounds, ...tiers }, null, 2)}\n`, "utf8");
  const tally = Object.values(decisions).reduce<Record<string, number>>((acc, decision) => ({ ...acc, [decision]: (acc[decision] ?? 0) + 1 }), {});
  console.log("档位汇总:", tally, "->", outFile);
  process.exit(0);
}

const repoPath = process.argv[2];
if (!repoPath) {
  console.error("用法: tsx dev/experiment/exam-point-audit.ts <repoPath> [outDir] | --tiers <samples.json> [out.json]");
  process.exit(1);
}
const outDir = process.argv[3] ?? join(process.cwd(), "experiments", "exam-point-audit");
const index = buildPointIndex(bodyOf);
const { corpus, texts } = corpusOf(repoPath, collect(repoPath));
const ctx: LandingContext = { corpus, readText: (path) => texts.get(path), maxFiles: MAX_FILES };
const audits = index.points.map((point) => buildAuditSamples(point.id, matchPoint(point, ctx)));
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${basename(repoPath)}.audit-samples.json`);
writeFileSync(file, `${JSON.stringify({
  repoPath, generatedAt: new Date().toISOString(), files: corpus.entries.length, points: index.points.length,
  insufficient: audits.filter((audit) => "decision" in audit).length,
  audits: audits.map((audit) => ({ ...audit, samples: audit.samples.map((sample) => ({ ...sample, canExam: null })) }))
}, null, 2)}\n`, "utf8");
console.log(`仓: ${relative(process.cwd(), repoPath)}  文件 ${corpus.entries.length}  考点 ${index.points.length}  样本不足 ${audits.filter((audit) => "decision" in audit).length}`);
console.log(`样本清单: ${file}`);
