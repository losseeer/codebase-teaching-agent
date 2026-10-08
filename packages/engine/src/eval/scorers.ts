import type { RepositoryFlow } from "@codebase-tutor/shared";
import { styleBand } from "@codebase-tutor/shared";
import { citesOwnedFile } from "../flows/deepen.js";

/**
  B 档（离线评测）的**确定性判分器**——一条 LLM 调用都不发起，判的是「产出的形态与可定位性」。
  对应设计方案 §10「教学内容质量」里可机器检查的两类：
  1. **引用落地**：产物文本里每个 `文件[:行号]` 都必须在仓内真实存在、行号不越界（归因正确性）；
  2. **边证据可核对**：code 边的 evidence 必须引到这条边端点自己的文件（与 deepen 的驳回闸同一口径），
     static 边至少引到一个能落地的文件；
  3. **检索 gold 命中**：`executeSearchCode` 离线重放，摘要上/不上两臂算 hit@k 与 recall@k，
     负例（仓内没有的东西）期望零命中——这是 search_code / L1 摘要消融的零成本前测。

  口径纪律同 A 档：数据源缺失报「未执行」，不拿空数组伪装成满分。
*/

const EXTENSIONS = "java|kt|kts|scala|groovy|py|ts|tsx|js|jsx|vue|go|rb|php|rs|swift|sql|xml|yaml|yml|md";
const REFERENCE_PATTERN = new RegExp(`[A-Za-z0-9_./\\-]+\\.(?:${EXTENSIONS})(?::\\d{1,5})?`, "g");

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

export interface EdgeEvidenceScore {
  code: { total: number; ok: number; bad: { key: string; evidence: string }[] };
  static: { total: number; ok: number; bad: { key: string; evidence: string }[] };
}

export interface FlowArtifactScore extends EdgeEvidenceScore {
  flows: number;
  refs: ReferenceScore;
}

/** 评一批 flow 产物：全文引用落地 + code/static 边的证据可核对性。inferred 边不核对（它本来就是「没依据」的自认）。 */
export function scoreFlowArtifacts(flows: RepositoryFlow[], files: Map<string, number>): FlowArtifactScore {
  const refs: ReferenceScore = { total: 0, ok: 0, problems: [] };
  const code: EdgeEvidenceScore["code"] = { total: 0, ok: 0, bad: [] };
  const static_: EdgeEvidenceScore["static"] = { total: 0, ok: 0, bad: [] };
  for (const flow of flows) {
    const texts: string[] = [flow.title, flow.summary ?? ""];
    for (const stage of flow.stages) {
      // 只判**模型写的文本**：stage.files 的结构化 path/line 已被 parseFlow 对着索引验过，再算进来是拿校验过的字段刷分
      texts.push(stage.title, stage.detail, ...stage.files.map((file) => file.note ?? ""), ...stage.branches);
    }
    for (const edge of flow.edges) texts.push(edge.evidence ?? "");
    if (flow.caveats) texts.push(flow.caveats);
    const merged = scoreReferences(texts, files);
    refs.total += merged.total;
    refs.ok += merged.ok;
    refs.problems.push(...merged.problems);
    const stageFiles = new Map(flow.stages.map((stage) => [stage.order, stage.files.map((file) => file.path)]));
    for (const edge of flow.edges) {
      const key = `${flow.entry.path}#${edge.from}->${edge.to}`;
      if (edge.origin === "code") {
        code.total += 1;
        const owned = [...new Set([...(stageFiles.get(edge.from) ?? []), ...(stageFiles.get(edge.to) ?? [])])];
        if (citesOwnedFile(edge.evidence ?? "", owned)) code.ok += 1;
        else code.bad.push({ key, evidence: edge.evidence ?? "" });
      } else if (edge.origin === "static") {
        static_.total += 1;
        const check = scoreReferences([edge.evidence ?? ""], files);
        if (check.ok > 0) static_.ok += 1;
        else static_.bad.push({ key, evidence: edge.evidence ?? "" });
      }
    }
  }
  return { flows: flows.length, refs, code, static: static_ };
}

export interface SearchCase {
  id: string;
  query: string;
  /** 该查询的正确答案文件；负例为空数组（期望零命中）。 */
  goldPaths: string[];
  /** 留出例（true）：建集时**没参照任何一代摘要**措辞，只按代码事实写 query 与 gold。
      报告把它与调优例分列——口径变更后若只有调优例涨、留出例不涨，就是「对着考纲出题」的证据。 */
  holdout?: boolean;
}

export interface CaseArmResult {
  id: string;
  top: string[];
  hit: boolean;
  recall: number;
}

export interface ArmResult {
  perCase: CaseArmResult[];
  hitRate: { numerator: number; denominator: number };
  meanRecall: number;
  /** 负例：上了错误结果才算错——单独统计误命中率。 */
  negatives: { id: string; wrongHits: string[] }[];
}

/** 一臂评测：对每个 case 跑一次离线检索，算 hit@k / recall@k；负例算误命中。 */
export function scoreSearchArm(cases: SearchCase[], search: (query: string) => string[]): ArmResult {
  const perCase: CaseArmResult[] = [];
  const negatives: { id: string; wrongHits: string[] }[] = [];
  let numerator = 0;
  let denominator = 0;
  let recallSum = 0;
  for (const item of cases) {
    const top = search(item.query);
    if (!item.goldPaths.length) {
      negatives.push({ id: item.id, wrongHits: top });
      continue;
    }
    const gold = new Set(item.goldPaths);
    const found = top.filter((path) => gold.has(path));
    perCase.push({ id: item.id, top, hit: found.length > 0, recall: found.length / item.goldPaths.length });
    numerator += found.length > 0 ? 1 : 0;
    denominator += 1;
    recallSum += found.length / item.goldPaths.length;
  }
  return {
    perCase,
    hitRate: { numerator, denominator },
    meanRecall: perCase.length ? recallSum / perCase.length : 0,
    negatives
  };
}

// ---------- 第 2 刀：教学法不变量机检（数据源 = journal 的 turn_text + hint_depth + style_shift） ----------

/** 一个教学回合的机检视图：由 runner 从 journal 装配，判分器保持纯函数。 */
export interface TeachTurn {
  sessionId: string;
  at: string;
  question: string;
  answer: string;
  /** 回合后状态机阶段（hint_depth.payload.stage）。 */
  stage: string;
  /** 该回合生效的教学法/风格（回合前最近一次 style_shift 快照）。 */
  pedagogy: string;
  style: number;
  /** 回复落盘时被 2000 字截断——引用核对会看到半截引用，这条不参与引用判分。 */
  answerTruncated: boolean;
  /**
    缺省 = teach（离线样本全是 teach）。运行期复检对三种作用域都跑，但只有 teach 的设计写了
    「留问句」与「绑定锚点」两条承诺，map/practice 只判引用落地那条——不适用不等于通过，分母如实缩。
    */
  scene?: "teach" | "map_chat" | "practice_chat";
}

export type InvariantId = "socratic-question" | "reference-grounding" | "anchor-binding";

/** 三条不变量的定义表：离线报告与运行期提示共用同一份措辞与出处，改一处就两边一起变。 */
const INVARIANTS: { id: InvariantId; label: string; source: string }[] = [
  { id: "socratic-question", label: "苏格拉底每轮留一个可核对的问题（回复含问句）", source: "tutor-settings.ts「每轮保留一个可验证的问题」" },
  { id: "reference-grounding", label: "回复零编造（每个 文件[:行号] 引用都能落地）", source: "锚点可靠性纪律（第 1 刀同一口径）" },
  { id: "anchor-binding", label: "非小白档回复点名至少一个标识符/路径", source: "tutor-settings.ts「将问题绑定到当前源码锚点」" }
];

/** 单回合复检结论。`applicable` 是该回合该判的条目，`failed` 是其中的失守项。 */
export interface TurnInvariantVerdict {
  applicable: InvariantId[];
  failed: InvariantId[];
  /** 每条失守的证据摘录（≤60 字或问题引用清单），journal 埋点与排查用。 */
  evidence: Partial<Record<InvariantId, string>>;
}

const excerpt = (text: string): string => text.replaceAll(/\s+/g, " ").slice(0, 60);

/**
  单回合的三条不变量机检——**离线判分器与运行期在环复检共用这一个实现**。
  分成两份实现的后果是「线上说合格、离线算不合格」，那比没有复检更糟。

  判「通过」的口径刻意保守：如问号检查只抓「整条回复一个问句都没有」，
  代码示例里的三元 `?` 可能造成极个别假通过——读数只用于回归对比，不当绝对分。
  */
export function checkTurnInvariants(turn: TeachTurn, files: Map<string, number>): TurnInvariantVerdict {
  const teach = (turn.scene ?? "teach") === "teach";
  const applicable: InvariantId[] = [];
  const failed: InvariantId[] = [];
  const evidence: TurnInvariantVerdict["evidence"] = {};

  if (teach && turn.pedagogy === "socratic" && turn.stage !== "confirmed") {
    applicable.push("socratic-question");
    if (!/[?？]/.test(turn.answer)) {
      failed.push("socratic-question");
      evidence["socratic-question"] = excerpt(turn.answer);
    }
  }
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
  运行期给学习者看的那一行明示。**只在引用失守时出现**：风格类失守是教学侧的读数问题，
  不是学习者能据以行动的事实，把它显示出来只是噪音。
  这句话里刻意不含任何 `文件.扩展名:行号` 形态的串，也不含 `read_file` 这类工具名——
  否则它自己会变成下一条被检的引用（journal 记的是用户真看到的文本，回放同一条时会二次判分）。
  */
export function invariantTailNotice(verdict: TurnInvariantVerdict): string | undefined {
  if (!verdict.failed.includes("reference-grounding")) return undefined;
  return "\n\n⚠️ 自动复检：本轮有代码位置引用未能在当前仓库核实，请以仓库实际内容为准。";
}

export interface InvariantCheck {
  id: InvariantId;
  label: string;
  /** 适用回合数（不适用 ≠ 通过，分母如实缩）。 */
  applicable: number;
  pass: number;
  misses: { at: string; sessionId: string; excerpt: string }[];
  /** 该条不变量的设计出处，报告里可核对。 */
  source: string;
}

export interface TeachInvariantScore {
  turns: number;
  skippedTruncated: number;
  checks: InvariantCheck[];
}

/**
  只判**设计上写了保证、且文本层可核对**的三条不变量（出处见 INVARIANTS 表）；
  「先要求说明推理再给结论」「不自造词」这类需要语义理解的留给第 3 刀裁判。
  逐条判定在 `checkTurnInvariants`——运行期在环复检也走它，这里只负责按条目聚合。
  */
export function scoreTeachInvariants(turns: TeachTurn[], files: Map<string, number>): TeachInvariantScore {
  const checks = new Map<string, InvariantCheck>(INVARIANTS.map((item) => [item.id, { ...item, applicable: 0, pass: 0, misses: [] }]));
  let skippedTruncated = 0;

  for (const turn of turns) {
    if (turn.answerTruncated) skippedTruncated += 1;
    const verdict = checkTurnInvariants(turn, files);
    for (const id of verdict.applicable) {
      const check = checks.get(id)!;
      check.applicable += 1;
      if (verdict.failed.includes(id)) check.misses.push({ at: turn.at, sessionId: turn.sessionId, excerpt: verdict.evidence[id] ?? "" });
      else check.pass += 1;
    }
  }
  return { turns: turns.length, skippedTruncated, checks: [...checks.values()] };
}
