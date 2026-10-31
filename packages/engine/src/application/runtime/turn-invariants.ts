
import { sourceExtensions } from "../../indexer/indexer.js";
import { maskSecrets } from "@codebase-tutor/domain";

/** 引用核验认得的扩展名，取自索引收录的名单。 */
const CITATION_EXTENSIONS = [...sourceExtensions].map((extension) => extension.replace(/^\./, "")).sort((a, b) => b.length - a.length || a.localeCompare(b));
const REFERENCE_PATTERN = new RegExp(`[A-Za-z0-9_./\\-]+\\.(?:${CITATION_EXTENSIONS.join("|")})(?![A-Za-z0-9])(?::\\d{1,5})?`, "g");

export interface ReferenceScore {
  total: number;
  ok: number;
  /** 逐条问题：引用原文与原因。 */
  problems: { raw: string; why: string }[];
}

/** 从一段文本提取全部 `文件[:行号]` 引用并按仓内文件表核验：不存在/多义/行号越界都算问题。 */
export function scoreReferences(texts: Iterable<string>, files: Map<string, number>): ReferenceScore {
  const score: ReferenceScore = { total: 0, ok: 0, problems: [] };
  for (const text of texts) {
    for (const match of text.matchAll(REFERENCE_PATTERN)) {
      const raw = match[0];
      const colon = raw.lastIndexOf(":");
      const path = colon > 0 ? raw.slice(0, colon) : raw;
      const line = colon > 0 ? Number(raw.slice(colon + 1)) : undefined;
      score.total += 1;
      const exact = files.get(path);
      let resolved: number | undefined = exact;
      if (exact === undefined) {
        const name = path.split("/").pop() ?? path;
        const candidates = [...files.keys()].filter((candidate) => candidate.endsWith(`/${name}`));
        if (candidates.length === 0) {
          score.problems.push({ raw, why: "仓库中不存在该文件" });
          continue;
        }
        if (candidates.length > 1) {
          score.problems.push({ raw, why: `同名文件 ${candidates.length} 个，引用无法定位` });
          continue;
        }
        resolved = files.get(candidates[0]);
      }
      if (line !== undefined && resolved !== undefined && line > resolved) {
        score.problems.push({ raw, why: `行号越界（该文件共 ${resolved} 行）` });
        continue;
      }
      score.ok += 1;
    }
  }
  return score;
}

/** 一个回合的机检视图。 */
export interface TeachTurn {
  sessionId: string;
  at: string;
  question: string;
  answer: string;
  /** 落盘时被截断的回复不参与引用核验。 */
  answerTruncated: boolean;
  /** 默认 = teach；`anchor-binding` 只在 teach 判，其余作用域只判引用核验。 */
  scene?: "teach" | "map_chat" | "practice_chat";
}

export type InvariantId = "reference-grounding" | "anchor-binding";

/** 出字前的本地过筛：隐去疑似密钥与仓库外绝对路径。 */
export interface ScreenedReply {
  text: string;
  /** 各隐去了几处；只记数量与首个样例，不记原文。 */
  secrets: number;
  paths: number;
  samples: string[];
}

/** 匹配仓库外的绝对路径。 */
const OUTSIDE_PATH = /(?:[A-Za-z]:\\|\/?(?:etc|var|usr|private|home|root|Users)\/|~\/|\.\.[/\\])[^\s`"'，。；)）]*\b/g;

const MASK_PATH = "[仓库外路径，已隐去]";

export function screenReply(answer: string): ScreenedReply {
  const secrets = maskSecrets(answer);
  let paths = 0;
  const samples: string[] = [];
  if (secrets.masked) samples.push("密钥形态");
  const text = secrets.text.replaceAll(OUTSIDE_PATH, (match) => {
    paths += 1;
    if (samples.length < 3) samples.push(`${match.slice(0, 24)}…`);
    return MASK_PATH;
  });
  return { text, secrets: secrets.masked, paths, samples };
}

/** 过筛后给用户看的说明句。 */
export function screenNotice(screened: ScreenedReply): string | undefined {
  if (!screened.secrets && !screened.paths) return undefined;
  const parts = [screened.secrets ? `${screened.secrets} 处疑似密钥` : "", screened.paths ? `${screened.paths} 处仓库外路径` : ""].filter(Boolean);
  return `\n\n⚠️ 本轮回复中的 ${parts.join(" 与 ")} 已被隐去。`;
}

/** 单回合复检结论。`applicable` 是该回合该判的条目，`failed` 是其中的失守项。 */
export interface TurnInvariantVerdict {
  applicable: InvariantId[];
  failed: InvariantId[];
  /** 每条失守的证据摘录。 */
  evidence: Partial<Record<InvariantId, string>>;
}

const excerpt = (text: string): string => text.replaceAll(/\s+/g, " ").slice(0, 60);

/** 单回合的不变量机检。 */
export function checkTurnInvariants(turn: TeachTurn, files: Map<string, number>): TurnInvariantVerdict {
  const teach = (turn.scene ?? "teach") === "teach";
  const applicable: InvariantId[] = [];
  const failed: InvariantId[] = [];
  const evidence: TurnInvariantVerdict["evidence"] = {};

  // 截断的回复不参与引用核验
  if (!turn.answerTruncated) {
    const refs = scoreReferences([turn.answer], files);
    if (refs.total > 0) {
      applicable.push("reference-grounding");
      if (refs.ok !== refs.total) {
        failed.push("reference-grounding");
        evidence["reference-grounding"] = refs.problems.map((problem) => `${problem.raw}（${problem.why}）`).join("、");
      }
    }
  }
  if (teach) {
    applicable.push("anchor-binding");
    if (!/[A-Za-z][A-Za-z0-9]{4,}/.test(turn.answer)) {
      failed.push("anchor-binding");
      evidence["anchor-binding"] = excerpt(turn.answer);
    }
  }
  return { applicable, failed, evidence };
}

/** 引用核验失守时给用户看的尾注。 */
export function invariantTailNotice(verdict: TurnInvariantVerdict): string | undefined {
  if (!verdict.failed.includes("reference-grounding")) return undefined;
  // 尾注文本本身不能形似代码引用
  return "\n\n⚠️ 本轮引用的代码位置未能核实，请以仓库实际内容为准。";
}
