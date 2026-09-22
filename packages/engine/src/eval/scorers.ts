import type { RepositoryFlow } from "@codebase-tutor/shared";
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
