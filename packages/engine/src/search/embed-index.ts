import type { EmbeddingProvider } from "../llm/embeddings.js";
import type { TutorDatabase } from "../store/database.js";
import { hash } from "../lib.js";

/**
  文件级 / 函数级向量索引：建什么文本、什么时候需要重嵌、怎么算相似、怎么和词法结果融合。
  全是纯函数 + 一层 SQLite 读写，评测台架和产品路径将来用的是同一份实现（不会出现「台上好看、线上另一套」）。

  两级粒度共用同一张表：`path` 列存「单元 id」——文件级就是文件路径，函数级是 `路径#符号名#行号`。
  坐标键（表里的 model 列）带粒度后缀（`text-embedding-v3#symbol`），因为**换粒度 = 换一套向量坐标系**，
  拿文件级向量与函数级查询算余弦和拿旧模型向量算余弦是同一类错误。
  */

/** 一条被嵌的单元：落在哪个文件（判分与展示都用文件），以及嵌什么文本。 */
export interface EmbedUnit {
  unitId: string;
  file: string;
  text: string;
}

/** 嵌的文本必须与词法臂的三个命中面一字对齐（路径 / 符号名 / 一句话职责）。
    对齐是为了可比：换文本口径再比两臂，赢的可能是文本不是模型。 */
export function embeddableText(entry: { path: string; symbols: string[]; summary: string }): string {
  return `${entry.path}\n${entry.symbols.join(" ")}\n${entry.summary}`;
}

/** 文件级单元 = 现有口径，一字未动（四臂读数的可比性靠这条）。 */
export function fileUnits(entries: { path: string; symbols: string[]; summary: string }[]): EmbedUnit[] {
  return entries.map((entry) => ({ unitId: entry.path, file: entry.path, text: embeddableText(entry) }));
}

/**
  函数级单元：三个命中面**保留**，只把「符号」从一串类名换成这一个函数自己（名字 + 种类 + 形参）。

  为什么不删掉文件摘要：那就不只是换粒度、还同时减了文本量，两臂差值没法归给粒度这一件事。
  文件摘要对同一文件的所有单元相同 ⇒ 单元之间的排序差异全部来自「这个函数叫什么」，正是本对照想量的量。
  另外：**没有符号的文件必须仍有一条自己的单元**，否则它对函数级臂完全不可见，那是覆盖缺失不是粒度差别。
  */
export function symbolUnits(entries: { path: string; symbols: string[]; summary: string }[], symbols: { name: string; kind: string; path: string; line: number; parameters?: string[] }[]): EmbedUnit[] {
  const byFile = new Map(entries.map((entry) => [entry.path, entry]));
  const covered = new Set<string>();
  const units: EmbedUnit[] = [];
  for (const symbol of symbols) {
    const entry = byFile.get(symbol.path);
    if (!entry) continue;   // 未被分析的文件（不在语料里）不进向量表
    covered.add(symbol.path);
    const parameters = (symbol.parameters ?? []).join(", ");
    units.push({
      unitId: `${symbol.path}#${symbol.name}#${symbol.line}`,
      file: symbol.path,
      text: `${entry.path}\n${symbol.name} ${symbol.kind}${parameters ? `(${parameters})` : ""}\n${entry.summary}`
    });
  }
  for (const entry of entries) {
    if (covered.has(entry.path)) continue;
    units.push({ unitId: entry.path, file: entry.path, text: embeddableText(entry) });
  }
  return units;
}

/** 嵌的是这段文本，所以失效键也用这段文本的哈希——摘要重烧（如注释开关）会变，源码没动就不会重嵌。 */
export function embeddableHash(text: string): string {
  return hash(text).slice(0, 16);
}

/** 哪些单元需要（重）嵌：文本哈希对不上就重嵌，没变就跳过。 */
export function pendingUnits(units: EmbedUnit[], stored: Map<string, string>): { unitId: string; text: string; contentHash: string }[] {
  const pending: { unitId: string; text: string; contentHash: string }[] = [];
  for (const unit of units) {
    const contentHash = embeddableHash(unit.text);
    if (stored.get(unit.unitId) !== contentHash) pending.push({ unitId: unit.unitId, text: unit.text, contentHash });
  }
  return pending;
}

export interface StoredVector {
  path: string;
  dim: number;
  vec: Float32Array;
}

/** 嵌入单元的增量部分并落库；顺带清掉已消失的单元（留着会让 dense 臂返回不存在的路径）。 */
export async function embedUnits(database: TutorDatabase, provider: EmbeddingProvider, repositoryId: string, units: EmbedUnit[]): Promise<{ embedded: number; skipped: number; pruned: number }> {
  const stored = database.getVectorHashes(repositoryId, provider.model);
  const pending = pendingUnits(units, stored);
  if (pending.length) {
    const vectors = await provider.embed(pending.map((item) => item.text));
    database.saveVectors(repositoryId, provider.model, pending.map((item, position) => ({ path: item.unitId, dim: vectors[position]!.length, contentHash: item.contentHash, vec: vectors[position]! })));
  }
  return { embedded: pending.length, skipped: units.length - pending.length, pruned: database.pruneVectors(repositoryId, provider.model, units.map((unit) => unit.unitId)) };
}

/** 余弦相似度取 top-N；同分按路径字典序（与词法臂同一可复现纪律）。零向量不参与。 */
export function cosineTop(query: Float32Array, vectors: StoredVector[], limit: number): { path: string; score: number }[] {
  const scored: { path: string; score: number }[] = [];
  for (const vector of vectors) {
    const score = cosine(query, vector.vec);
    if (score > 0) scored.push({ path: vector.path, score });
  }
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return scored.slice(0, limit);
}

/**
  函数级向量按文件取**最高分**（一个文件只要有一个函数对得上，就算这个文件对得上）。
  取 max 而不是均值：均值会让「文件里有一个精确命中的函数」被其余几十个无关函数摊平，那是池化方式在替结论说话。
  同分破平与 `cosineTop` 一致（文件路径字典序），保证两次跑同样输入得到同样顺序。
  */
export function cosineTopByFile(query: Float32Array, units: StoredVector[], limit: number): { path: string; score: number }[] {
  const best = new Map<string, number>();
  for (const unit of units) {
    const score = cosine(query, unit.vec);
    if (score <= 0) continue;
    const file = unit.path.split("#")[0]!;
    if (score > (best.get(file) ?? 0)) best.set(file, score);
  }
  const scored = [...best].map(([path, score]) => ({ path, score }));
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return scored.slice(0, limit);
}

export function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let at = 0; at < length; at += 1) {
    dot += left[at] * right[at];
    normLeft += left[at] * left[at];
    normRight += right[at] * right[at];
  }
  if (!normLeft || !normRight) return 0;
  return dot / Math.sqrt(normLeft * normRight);
}

/**
  RRF（倒数排名融合）：只信名次不信分数量纲——词法分与余弦分量程完全不同，加权求和会把结论做在参数上。
  `k=60` 是通用默认值（不是在这里调出来的），改它等于换算法，要重新出四臂读数。
  */
export function reciprocalRankFusion(lists: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((path, position) => scores.set(path, (scores.get(path) ?? 0) + 1 / (k + position + 1)));
  }
  return [...scores].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([path]) => path);
}
