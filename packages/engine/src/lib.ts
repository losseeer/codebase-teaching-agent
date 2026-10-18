import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const id = (): string => randomUUID();
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function repositoryId(path: string): string {
  return `repo_${hash(realpathSync(path)).slice(0, 16)}`;
}

/**
  地址簿条目的 id：目录在就按 `repositoryId` 的口径（realpath 后哈希）；目录不在时 realpath 会抛，
  退化成按字面路径哈希——等它回到原路径时 `realpath(path) === path`（入簿时存的就是 realpath），
  两种算法给出同一个 id，条目不会漂。列清单与按帧归属仓 id 都不能因为某个目录被挪走就抛：
  前者整页 500，后者会把异常顺着 `emit("event")` 的同步链捅进已经算完的导入（见 server.ts 的 `broadcast`）。
  */
export function catalogRepositoryId(path: string): string {
  try {
    return repositoryId(path);
  } catch {
    return `repo_${hash(path).slice(0, 16)}`;
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
  读文件为行数组，统一 `/\r?\n/` 换行口径（CRLF 文件不留行尾 `\r`）；读不到返回 `undefined`，
  由调用方决定「缺席」还是「待确认」。实现单元、质量校验、练习出题共用这一份读行口径，别各写一份 split。
  */
export function readFileLines(repositoryPath: string, relativePath: string): string[] | undefined {
  try {
    return readFileSync(join(repositoryPath, relativePath), "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** 取符号定义体的行区间 `[line-1, endLine)`：`SymbolInfo.endLine` 是「含末行」，slice 右界因此不必 +1。 */
export function symbolBodyLines(fileLines: string[], symbol: { line: number; endLine: number }): string[] {
  return fileLines.slice(symbol.line - 1, symbol.endLine);
}

/** 「只打控制台、不落盘」的取值表：`llm.log` 与 `engine.jsonl` 两条线共用，不各写一份。 */
const LOG_DISABLED = new Set(["off", "none", "0", "false"]);

/**
  日志落点解析：环境变量没给 → 用默认文件；给了 `LOG_DISABLED` 之一 → `null`（只打控制台）；否则当路径用。
  每次现读 `process.env` 而不是模块级缓存，测试才能各自把落点指到临时文件。
  */
export function logTargetFromEnv(raw: string | undefined, defaultFile: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return defaultFile;
  return LOG_DISABLED.has(value.toLowerCase()) ? null : value;
}

/** 回合文本单边落盘上限：与 journal HTTP 出口的 payload 字符串校验同口径（2000 字符）。 */
export const TURN_TEXT_LIMIT = 2_000;

/**
  `turn_text` 事件的 payload 构造（2026-09-22 拍板口径）：三种对话（teach / map_chat / practice_chat）的
  问题+回复双边原文进 journal，各截 2000 字；截断必须留痕（`*_truncated`）——丢了字要能看出来，
  与「回复达到预算上限明示」同一先例。
  */
export function turnTextPayload(scene: "teach" | "map_chat" | "practice_chat", question: string, answer: string): Record<string, string | number | boolean> {
  const q = question.slice(0, TURN_TEXT_LIMIT);
  const a = answer.slice(0, TURN_TEXT_LIMIT);
  return {
    scene,
    question: q,
    question_truncated: question.length > q.length,
    answer: a,
    answer_truncated: answer.length > a.length
  };
}

/**
  L2 产物缓存键的构造已经搬进 `analysis-step.ts` 并且**不再导出**：
  键必须由登记过的分析步骤（`AnalysisStep.cacheKey()`）产出，这样「新加一层忘了交提示词口径」不可能悄悄发生。
  L1 摘要与出题作用域两把键各有各的形状（理由见 `summarizer.ts` 的 `cacheKeyOf`、`exercises.ts` 的 `exerciseScope`），
  但它们的口径版本同样登记成步骤，一起受提示词指纹守卫约束。
  */
