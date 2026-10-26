import { styleBand } from "@codebase-tutor/domain";

import { sourceExtensions } from "../indexer/indexer.js";
import { maskSecrets } from "../security/secrets.js";

/**
  引用核验认得的扩展名 = 索引会收录的那一份名单（`sourceExtensions`：图内语言由能力表派生 ∪ 图外的配置/文档）。
  判据只有一条，就是「文件表里可能出现的形状」——手写清单既漏了 `.c/.h/.cpp/.cs/.mjs/.cjs`
  （模型编一条 `parser.cpp:88` 的假引用，这台机器连看都不看），也必须跟着索引走，
  不然核验的是引擎根本不会收录的文件形状。名单本身由 `depgraph/capability-coverage.test.ts` 钉住。
*/
const CITATION_EXTENSIONS = [...sourceExtensions].map((extension) => extension.replace(/^\./, "")).sort((a, b) => b.length - a.length || a.localeCompare(b));
const REFERENCE_PATTERN = new RegExp(`[A-Za-z0-9_./\\-]+\\.(?:${CITATION_EXTENSIONS.join("|")})(?![A-Za-z0-9])(?::\\d{1,5})?`, "g");

export interface ReferenceScore {
  total: number;
  ok: number;
  /** 逐条问题（引用原文 + 病因），报告侧截断展示。 */
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

/** 一个回合的机检视图：由 runner 从 journal 装配，判分器保持纯函数。 */
export interface TeachTurn {
  sessionId: string;
  at: string;
  question: string;
  answer: string;
  /** 该回合生效的风格档（回合前最近一次 style_shift 快照）。 */
  style: number;
  /** 回复落盘时被 2000 字截断——引用核对会看到半截引用，这条不参与引用判分。 */
  answerTruncated: boolean;
  /** 默认 = teach（离线样本全是 teach）。运行期复检对三种作用域都跑，但只有 teach 的设计写了
      「绑定锚点」这条承诺，map/practice 只判引用落地那条——不适用不等于通过，分母如实缩。 */
  scene?: "teach" | "map_chat" | "practice_chat";
}

export type InvariantId = "reference-grounding" | "anchor-binding";

/**
  出字前的本地过筛（零 token）：只查机器能判的两件事——疑似密钥外泄、仓库外绝对路径被当证据引用。
  过筛做改写（隐掉再下发）不进分母，与「该做到没做到」的不变量分开计——密钥误进教学法分母会让那条度量失真。
  read_file 只在源头挡住本轮读进来的东西；学习者贴的或历史回合里的密钥会被模型复述，正文下发后收不回，
  所以这一步放在复检最前面、流式之前。
 */
export interface ScreenedReply {
  text: string;
  /** 各隐去了几处（journal 埋点用；只记数量与首个样例，不记原文，避免把要挡的东西再存一遍）。 */
  secrets: number;
  paths: number;
  samples: string[];
}

/** 仓库外的绝对路径：本机目录结构不是代码证据，出现在正文里既误导学习者又泄露机器信息。 */
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

/** 过筛后的说明：改过字就要让用户知道改了什么，否则「落库正文＝用户所见」这条对齐成了暗改。 */
export function screenNotice(screened: ScreenedReply): string | undefined {
  if (!screened.secrets && !screened.paths) return undefined;
  const parts = [screened.secrets ? `${screened.secrets} 处疑似密钥` : "", screened.paths ? `${screened.paths} 处仓库外路径` : ""].filter(Boolean);
  return `\n\n⚠️ 本轮回复中的 ${parts.join(" 与 ")} 已被隐去。`;
}

/** 单回合复检结论。`applicable` 是该回合该判的条目，`failed` 是其中的失守项。 */
export interface TurnInvariantVerdict {
  applicable: InvariantId[];
  failed: InvariantId[];
  /** 每条失守的证据摘录（≤60 字或问题引用清单），journal 埋点与排查用。 */
  evidence: Partial<Record<InvariantId, string>>;
}

const excerpt = (text: string): string => text.replaceAll(/\s+/g, " ").slice(0, 60);

/**
  单回合的不变量机检——离线判分器与运行期复检共用这一个实现，两份实现会出现「线上合格、离线不合格」。
  判「通过」的口径刻意保守：引用核对只看文件在不在索引、行号越不越界，
  代码示例可能造成极个别假通过——读数只用于回归对比，不当绝对分。
  */
export function checkTurnInvariants(turn: TeachTurn, files: Map<string, number>): TurnInvariantVerdict {
  const teach = (turn.scene ?? "teach") === "teach";
  const applicable: InvariantId[] = [];
  const failed: InvariantId[] = [];
  const evidence: TurnInvariantVerdict["evidence"] = {};

  // 截断行的末尾可能悬着半截引用，判它等于误判——缩出分母，报告里单独计数
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
  if (teach && styleBand(turn.style) !== "plain") {
    applicable.push("anchor-binding");
    if (!/[A-Za-z][A-Za-z0-9]{4,}/.test(turn.answer)) {
      failed.push("anchor-binding");
      evidence["anchor-binding"] = excerpt(turn.answer);
    }
  }
  return { applicable, failed, evidence };
}

/**
  运行期给学习者看的那一行明示，只在引用失守时出现：风格类失守是教学侧读数问题，不是学习者能行动的事实。
  这句话刻意不含 `文件.扩展名:行号` 形态的串和工具名——journal 记的是用户真实看到的文本，
  含了它自己会变成下一条被检引用、回放时二次判分。
  */
export function invariantTailNotice(verdict: TurnInvariantVerdict): string | undefined {
  if (!verdict.failed.includes("reference-grounding")) return undefined;
  return "\n\n⚠️ 本轮引用的代码位置未能核实，请以仓库实际内容为准。";
}
