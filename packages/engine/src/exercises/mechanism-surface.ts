import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { createTutorIgnoreMatcher } from "@codebase-tutor/analysis";
import { hash } from "@codebase-tutor/platform";

import { deniedSecretNameReason } from "../source/read-file.js";
import type { GuardCandidate } from "./guard-proposal.js";
import { buildTagCandidate } from "./llm-generate.js";

/**
  机制声明面：配置键、建表语句与依赖清单里的声明行。
  这些文件不进收录集（不让它们叫醒摘要），只给出题补一格可读摘录。
*/

/** 各扩展名的声明行形状：只按文件结构判，不列学科词。 */
const DECLARATION_PATTERNS: Record<string, RegExp> = {
  ".sql": /^\s*(?:create|alter|drop|primary|unique|key|index|constraint|partition|distribute|engine)\b/i,
  ".properties": /^\s*[\w.$-]+\s*[:=]/,
  ".yml": /^\s*[\w.$-]+:\s*\S/,
  ".yaml": /^\s*[\w.$-]+:\s*\S/,
  ".xml": /^\s*<(?:artifactId|groupId|version|packaging|property|dependency)\b/i,
  ".gradle": /^\s*(?:implementation|api|compileonly|runtimeonly|testimplementation|classpath|ext)\b/i
};

/** 一块声明至少几行才值得当素材：一行的声明读不出取舍。 */
const MIN_DECLARATIONS = 2;
/** 声明行之间容几行空隙仍算同一块。 */
const BLOCK_GAP = 2;
/** 单次最多扫多少个候选文件。 */
const MAX_FILES = 400;
/** 超过这个体积的文件不读。 */
const MAX_FILE_BYTES = 200_000;
/** 一块摘录最多几行。 */
const MAX_BLOCK_LINES = 240;
/** 线索词元最短长度：太短的只剩关键字。 */
const MIN_CLUE_LENGTH = 5;
/** 语言关键字与恒泛词：它们命中哪个声明面都不说明问题。 */
const CLUE_NOISE = new Set(["const", "function", "import", "export", "return", "class", "public", "private", "static", "void", "this", "true", "false", "null", "async", "await", "string", "number", "value", "override", "new", "super", "throws"]);

interface Block {
  start: number;
  end: number;
  declared: number;
}

/** 主题词元：整串加切词，与收录集那条检索同一形状。 */
export function tagTokens(tag: string): string[] {
  const lowered = tag.toLowerCase();
  return [...new Set([lowered, ...lowered.split(/[\s,，、/·:：_-]+/).filter((token) => token.length >= 2)])];
}

/** 已选摘录里的标识符，当接上声明面的线索：桥是仓内自己的名字，不是学科词表。 */
export function excerptClues(pool: GuardCandidate[], limit = 30): string[] {
  const counts = new Map<string, number>();
  for (const candidate of pool) {
    for (const match of candidate.excerpt.matchAll(/[A-Za-z_][A-Za-z0-9_]+/g)) {
      const clue = match[0].toLowerCase();
      if (clue.length < MIN_CLUE_LENGTH || CLUE_NOISE.has(clue)) continue;
      counts.set(clue, (counts.get(clue) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([clue]) => clue);
}

/** 连续声明行归成块：空行截块，块内最多容两行非声明行。 */
function blocksOf(lines: string[], pattern: RegExp): Block[] {
  const found: Block[] = [];
  let start = -1;
  let last = -1;
  let declared = 0;
  const flush = (): void => {
    if (start >= 0) found.push({ start: start + 1, end: last + 1, declared });
    start = -1;
    declared = 0;
  };
  lines.forEach((line, index) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (!pattern.test(line)) return;
    if (start >= 0 && index - last <= BLOCK_GAP + 1) {
      declared += 1;
      last = index;
      return;
    }
    flush();
    start = index;
    last = index;
    declared = 1;
  });
  flush();
  return found;
}

function readText(repositoryPath: string, path: string): string | undefined {
  try {
    const absolute = join(repositoryPath, path);
    if (statSync(absolute).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
}

export interface MechanismCandidate {
  candidate: GuardCandidate;
  /** 与收录集同一算法的内容哈希，进出题缓存作用域。 */
  digest: string;
}

/** 找一处与线索接得上的声明块；接不上就不补，不为凑数花钱。 */
export function mechanismCandidate(repositoryPath: string, clues: string[], taken: Set<string>): MechanismCandidate | undefined {
  const ignore = createTutorIgnoreMatcher(repositoryPath);
  const paths: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ignore.shouldTraverse(path)) visit(join(directory, entry.name), path);
      } else if (entry.isFile() && DECLARATION_PATTERNS[extname(path).toLowerCase()] && !taken.has(path) && !ignore.ignores(path) && !deniedSecretNameReason(path)) {
        paths.push(path);
      }
    }
  };
  visit(repositoryPath, "");
  const matches: { path: string; block: Block; digest: string; matched: string[] }[] = [];
  for (const path of paths.sort().slice(0, MAX_FILES)) {
    const text = readText(repositoryPath, path);
    if (text === undefined) continue;
    const pattern = DECLARATION_PATTERNS[extname(path).toLowerCase()]!;
    const lines = text.split("\n");
    const digest = hash(text).slice(0, 16);
    for (const block of blocksOf(lines, pattern)) {
      if (block.declared < MIN_DECLARATIONS) continue;
      const body = lines.slice(block.start - 1, Math.min(block.end, block.start - 1 + MAX_BLOCK_LINES)).join("\n").toLowerCase();
      const matched = clues.filter((clue) => body.includes(clue));
      if (matched.length) matches.push({ path, block, digest, matched });
    }
  }
  if (!matches.length) return undefined;
  // 人人都撞得上的词不说明相关：一个词被越多块撞上，它在打分里越轻。
  const documents = new Map<string, number>();
  for (const item of matches) for (const clue of item.matched) documents.set(clue, (documents.get(clue) ?? 0) + 1);
  const ranked = matches
    .map((item) => ({ item, score: item.matched.reduce((sum, clue) => sum + 1 / (documents.get(clue) ?? 1), 0) + Math.min(item.block.declared, 3) / 100 }))
    .sort((left, right) => right.score - left.score || left.item.path.localeCompare(right.item.path) || left.item.block.start - right.item.block.start);
  const found = ranked[0]!.item;
  const candidate = buildTagCandidate(repositoryPath, found.path, { start: found.block.start, end: Math.min(found.block.end, found.block.start + MAX_BLOCK_LINES - 1) });
  return candidate ? { candidate, digest: found.digest } : undefined;
}
