import type { SearchCorpus } from "../source/search-code.js";
import { skillSection } from "./topic-tiers.js";

/**
  考点词表：从出厂技能 `exercise-code-concepts` 的附属文件解析 `id / concepts / probes`，
  再用 `concepts.json` 把中文主题词展开成仓内符号/文本词，交给 probe 匹配器找落点。

  与 `topic-tiers.ts` 的分工：那边只抽「考点原文」拼进 system prompt 给模型填 exam_point；
  这边把同一张表的 id/concepts/probes 读出来给引擎做确定性判定。两边共用同一份表格，不另抄。
*/
export type BodyOf = (name: string, file?: string) => string | undefined;

const TOPIC_SKILL = "exercise-code-concepts";

export interface ExamPointDef {
  id: string;
  concepts: string[];
  /** 原始 probe 串；组合语义见 parseProbes。 */
  probes: string;
  /** 中文可考点原文，模型填 exam_point 用。 */
  point: string;
  /** 附属文件名去 .md。 */
  tier: string;
}

export interface PointIndex {
  points: ExamPointDef[];
  /** 规范概念 -> 同义词组（中英 + 缩写）。 */
  concepts: Record<string, string[]>;
  byConcept: Map<string, ExamPointDef[]>;
}

function markdownRows(text: string): string[][] {
  return text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2 && !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
}

/** 附属文件清单从 SKILL.md 的表格里取，技能加档时这里自动跟随。 */
function attachedFiles(bodyOf: BodyOf): string[] {
  const skill = bodyOf(TOPIC_SKILL) ?? "";
  return [...new Set([...skill.matchAll(/`?([a-z0-9-]+\.md)`?/g)].map((match) => match[1]))]
    .filter((file) => file !== "SKILL.md");
}

/** 解析 6 列表；没有 id 列的旧表整张跳过（不猜列位置）。 */
export function parsePointTable(bodyOf: BodyOf): ExamPointDef[] {
  const out: ExamPointDef[] = [];
  for (const file of attachedFiles(bodyOf)) {
    const body = bodyOf(TOPIC_SKILL, file);
    if (!body) continue;
    const rows = markdownRows(skillSection(body, "能摘出来考的"));
    const header = rows[0] ?? [];
    const columnOf = (name: string): number => header.findIndex((cell) => cell.trim() === name);
    const idColumn = columnOf("id");
    if (idColumn < 0) continue;
    const conceptsColumn = columnOf("concepts");
    const probesColumn = columnOf("probes");
    const pointColumn = columnOf("考点");
    for (const row of rows.slice(1)) {
      const id = (row[idColumn] ?? "").replace(/`/g, "").trim();
      if (!id) continue;
      out.push({
        id,
        concepts: (row[conceptsColumn] ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        probes: (row[probesColumn] ?? "").replace(/`/g, "").trim(),
        point: row[pointColumn] ?? "",
        tier: file.replace(/\.md$/, "")
      });
    }
  }
  return out;
}

/**
  概念词表。两种形状都吃：
  - `{ "concepts": { "并发": [...] } }`（现行格式，带版本与说明）
  - `{ "并发": [...] }`（顶层直接是概念表）
  形状认不出来时返回空表——由调用方显式告警并跳过判定，不在这里静默当成「没有概念」。
*/
export function loadConceptTable(bodyOf: BodyOf): Record<string, string[]> {
  const raw = bodyOf(TOPIC_SKILL, "concepts.json");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const wrapped = parsed.concepts;
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) return wrapped as Record<string, string[]>;
    const values = Object.values(parsed);
    if (values.length && values.every((value) => Array.isArray(value))) return parsed as Record<string, string[]>;
    return {};
  } catch {
    return {};
  }
}

export function buildPointIndex(bodyOf: BodyOf): PointIndex {
  const points = parsePointTable(bodyOf);
  const concepts = loadConceptTable(bodyOf);
  const byConcept = new Map<string, ExamPointDef[]>();
  for (const point of points) {
    for (const concept of point.concepts) {
      const list = byConcept.get(concept) ?? [];
      list.push(point);
      byConcept.set(concept, list);
    }
  }
  if (points.length && !Object.keys(concepts).length) {
    // 有考点没有概念 = 主题判定必然全落空，这里显式喊出来，别让它悄悄退化成「永远拒绝」。
    console.warn("[exam-points] 考点表有 " + points.length + " 条，但 concepts.json 没解析出概念；主题判定会被跳过。检查 concepts.json 的形状（顶层是概念表，或包在 concepts 字段里）。");
  }
  return { points, concepts, byConcept };
}

/**
  probe 组合：`&` 优先于 `;`，不支持嵌套。
  返回 OR 组，每组内是 AND 项；`a & b; c & d` => [[a,b],[c,d]]。
*/
export function parseProbes(raw: string): string[][] {
  return raw.split(";")
    .map((group) => group.split("&").map((term) => term.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
}

/** 主题词归一到规范概念：先精确命中，再在同义词组里找（大小写不敏感）。 */
export function conceptsOfTheme(theme: string, table: Record<string, string[]>): string[] {
  const needle = theme.trim().toLowerCase();
  if (!needle) return [];
  const hits = new Set<string>();
  for (const [concept, synonyms] of Object.entries(table)) {
    if (concept.toLowerCase() === needle || synonyms.some((word) => word.toLowerCase() === needle)) hits.add(concept);
  }
  // 主题可能包含多个词（「Java 特性」「线程 池」），逐个再扫一遍包含关系
  for (const [concept, synonyms] of Object.entries(table)) {
    if ([concept, ...synonyms].some((word) => word.length >= 3 && needle.includes(word.toLowerCase()))) hits.add(concept);
  }
  return [...hits];
}

/** 某个概念展开后要拿去 sym:/text: 检索的词（去规范概念自身，避免中文词撞代码）。 */
export function kwTerms(concept: string, table: Record<string, string[]>): string[] {
  const words = table[concept] ?? [];
  return [...new Set([concept, ...words])].filter((word) => /^[A-Za-z0-9_.-]+$/.test(word));
}

export interface LandingContext {
  corpus: SearchCorpus;
  /** 读文件原文（引擎本地读，不花 token）；不给时 mod:/text: 一律不命中。 */
  readText?: (path: string) => string | undefined;
  /** 一次判定最多读多少个文件的正文，防止全仓扫。 */
  maxFiles?: number;
}

export interface Landing {
  path: string;
  pointId: string;
  line?: number;
  symbol?: string;
  /** 行级结构信号，见 signalOf。 */
  signal: number;
}

/** 行级结构信号：控制流 +3、多调用/赋值+调用 +2、孤立单行 -3，三项相加（可互相抵消）。 */
export function signalOf(lines: string[], index: number): number {
  const near = lines.slice(Math.max(0, index - 3), index + 4).join(" ");
  // 文档第 3.3 章：三项相加（附近有控制流 +3，多调用/赋值+调用 +2，孤立单行 -3）
  let score = /\b(if|for|while|try|catch|synchronized)\b/.test(near) ? 3 : 0;
  const line = lines[index] ?? "";
  const multiCall = (line.match(/\(/g)?.length ?? 0) >= 2 || (/=/.test(line) && /\w+\(/.test(line));
  if (multiCall) score += 2;
  const isolated = /^\s*[\w.]+\([^)]*\)\s*;?\s*$/.test(line) || /^\s*[\w.]+\s*=\s*[^=]/.test(line);
  if (isolated) score -= 3;
  return score;
}

const RUNNABLE = /^(sym|mod|text):/;

interface TermHit { hit: boolean; line?: number; symbol?: string; lines?: string[] }

function matchTerm(term: string, entry: SearchCorpus["entries"][number], text: string | undefined): TermHit {
  // call:/op: 第一版只描述：在含可运行项的 AND 组里视为中性，不阻断判定；
  // 整组都是描述项时由 matchPoint 直接跳过，避免所有条目无条件命中。
  if (!RUNNABLE.test(term)) return { hit: true };
  const kind = term.slice(0, term.indexOf(":"));
  const needle = term.slice(term.indexOf(":") + 1);
  if (kind === "sym") {
    const lower = needle.toLowerCase();
    // sym:<Type>[:<method>]：精确匹配符号名，方法名单独匹配，不用前缀（避免 sym:Integer 命中 IntegerCache）。
    const method = lower.includes(":") ? lower.slice(lower.indexOf(":") + 1) : undefined;
    const type = method ? lower.slice(0, lower.indexOf(":")) : lower;
    const symbol = entry.symbols.find((name) => name.toLowerCase() === type)
      ?? (method ? entry.symbols.find((name) => name.toLowerCase() === method) : undefined);
    if (!symbol) return { hit: false };
    const unit = entry.units.find((item) => item.name === symbol);
    return { hit: true, line: unit?.line, symbol };
  }
  if (!text) return { hit: false };
  const lines = text.split("\n");
  const index = lines.findIndex((line) => {
    try { return new RegExp(needle, "i").test(line); } catch { return line.toLowerCase().includes(needle.toLowerCase()); }
  });
  return index < 0 ? { hit: false } : { hit: true, line: index + 1, lines };
}

/** 一个考点在仓里的所有落点；同一路径同一行只留一条。 */
export function matchPoint(point: ExamPointDef, ctx: LandingContext): Landing[] {
  const groups = parseProbes(point.probes);
  const cache = new Map<string, string | undefined>();
  let reads = 0;
  const readText = (path: string): string | undefined => {
    if (cache.has(path)) return cache.get(path);
    if (!ctx.readText || reads >= (ctx.maxFiles ?? 40)) return undefined;
    reads += 1;
    const value = ctx.readText(path);
    cache.set(path, value);
    return value;
  };
  const seen = new Set<string>();
  const out: Landing[] = [];
  for (const entry of ctx.corpus.entries) {
    const text = groups.some((group) => group.some((term) => /^(mod|text):/.test(term))) ? readText(entry.path) : undefined;
    for (const group of groups) {
      if (!group.some((term) => RUNNABLE.test(term))) continue;
      const hits = group.map((term) => matchTerm(term, entry, text));
      if (!hits.every((hit) => hit.hit)) continue;
      const first = hits.find((hit) => hit.line !== undefined);
      const key = `${entry.path}:${first?.line ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: entry.path,
        pointId: point.id,
        ...(first?.line === undefined ? {} : { line: first.line }),
        ...(hits.find((hit) => hit.symbol)?.symbol ? { symbol: hits.find((hit) => hit.symbol)!.symbol } : {}),
        signal: first?.lines && first.line ? signalOf(first.lines, first.line - 1) : 0
      });
    }
  }
  return out;
}

/** kw: 概念检索：同义词逐个做 sym: 与 text:，任一命中即算。 */
export function kwLandings(concept: string, table: Record<string, string[]>, ctx: LandingContext): Landing[] {
  const out: Landing[] = [];
  for (const word of kwTerms(concept, table)) {
    out.push(...matchPoint({ id: `kw:${word}`, concepts: [concept], probes: `sym:${word}; text:${word}`, point: "", tier: "kw" }, ctx));
  }
  return out;
}
