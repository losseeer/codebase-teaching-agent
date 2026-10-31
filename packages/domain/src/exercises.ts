import type { SourceAnchor } from "./repository-index.js";
import type { MasteryLevel, ReviewSchedule } from "./learner-profile.js";

/**
  题型五档：
  - `change_localization` / `impact_analysis`：静态分析产出的理解题，不跑代码。
  - `patch_edit`：给一段有缺陷的实现，学习者在编辑器里改到测试全过。
  - `author_function`：给题面与骨架文件，学习者从零写实现。
  - `llm_rubric`：开放分析题，rubric 判分。
*/
export type ExerciseKind = "change_localization" | "impact_analysis" | "patch_edit" | "author_function" | "llm_rubric";
/** 用户在界面上选的题型三档：理解题吃静态分析，分析题走 rubric，设计题要跑测试。 */
export type ExerciseType = "comprehension" | "analysis" | "design";
/** 题型 → 具体题型。路由、校验、界面分组只用这一份。 */
export const EXERCISE_TYPE_KINDS: Record<ExerciseType, ExerciseKind[]> = {
  comprehension: ["impact_analysis", "change_localization"],
  analysis: ["llm_rubric"],
  design: ["patch_edit", "author_function"]
};
/** 当前引擎真能出、真能判的全部题型（路由 400 校验、复习队列回放共用这一份）。 */
export const SUPPORTED_EXERCISE_KINDS: ExerciseKind[] = Object.values(EXERCISE_TYPE_KINDS).flat();
/** 一道题的题型档位；未登记的 kind 一律按理解题处理（旧缓存行只可能是理解题）。 */
export function exerciseTypeOf(kind: ExerciseKind): ExerciseType {
  if (EXERCISE_TYPE_KINDS.design.includes(kind)) return "design";
  if (EXERCISE_TYPE_KINDS.analysis.includes(kind)) return "analysis";
  return "comprehension";
}
/**
  练习单元 id 的第一段就是它的题型出处：`impact:` 影响分析、`implementation:` 定位与代码题、`llm:` 主题题。
  这一段之外的 id（如 9 月流程题留下的 `workflow:`）今天的引擎既出不出题也判不了分，
  所以回放掌握度时不再当作当前信号——journal 里那些行照旧留着，那是账本。
*/
const LIVE_UNIT_PREFIXES = ["impact:", "implementation:", "llm:"];
export const isLiveExerciseUnit = (unitId: string): boolean => LIVE_UNIT_PREFIXES.some((prefix) => unitId.startsWith(prefix));
/** 练习题族：comprehension=程序理解题（规则出题、确定性判分），code=沙箱代码题（模型出题、跑测试判分），llm=LLM 出题（rubric 判分）。family 是实现层概念，对用户不可见。 */
export type ExerciseFamily = "comprehension" | "code" | "llm";
export type ExerciseInputMode = "text" | "multi_select" | "open" | "code";
/** `execution` 意味着「沙箱真跑测试」，判分只由测试是否全过决定。 */
export type ExerciseGradingMode = "execution" | "set_match" | "rubric";
/** 沙箱支持的语言。就是这一份清单——加一门语言要同时给 runner（怎么起）与探测（能不能真拦住），否则整域禁用。 */
export type ExerciseLanguage = "typescript" | "python" | "java";
/** 下发给界面编辑器的可编辑文件（`patch_edit` 给的是带缺陷的那一份，`author_function` 给的是骨架）。
    判分用的测试与替身不在这里，它们只留在引擎缓存行里。 */
export interface ExerciseCodeSlot {
  language: ExerciseLanguage;
  files: { path: string; contents: string }[];
  /** typescript/python：入口文件名；java：入口类名 */
  entry: string;
}
/** rubric 判分的评分细则维度（LLM 出题时一并产出，存于引擎缓存，不下发 GUI）。 */
export interface RubricCriterion {
  dimension: string;
  description: string;
}

export interface ExerciseOption {
  id: string;
  label: string;
  detail?: string;
}

/** A learner-safe exercise. Expected answers remain in the engine cache. */
export interface Exercise {
  id: string;
  repositoryId: string;
  contentVersion: string;
  kind: ExerciseKind;
  targetUnitId: string;
  targetTitle: string;
  difficulty: MasteryLevel;
  title: string;
  prompt: string;
  anchors: SourceAnchor[];
  inputMode: ExerciseInputMode;
  gradingMode: ExerciseGradingMode;
  options?: ExerciseOption[];
  /** 代码题（`patch_edit` / `author_function`）的可编辑文件包；理解题与主观题没有这个节点。 */
  code?: ExerciseCodeSlot;
  /** 练习题族；旧缓存记录无此字段视为 comprehension。 */
  family?: ExerciseFamily;
  /** llm 族：用户配置的出题主题标签（题面语义提示）。 */
  tag?: string;
  /** 这道题的内容由哪些文件决定（题面 + 标准答案）；作答时逐文件核对哈希，无关文件的修改不打扰已有题目。
      旧缓存记录无此字段，回落 `contentVersion` 全仓比对。 */
  contentHashes?: { path: string; hash: string }[];
  createdAt: string;
}

/** 题库一行：题本身 + 它的复习排期（还没判过分就没有）。 */
export interface ExerciseBankEntry {
  exercise: Exercise;
  review?: ReviewSchedule;
}

export interface ExerciseAnswer {
  text?: string;
  selectedIds?: string[];
  /** 代码题：学习者提交的整组文件。path 必须与题面下发的那一组一致——判分时用它替换 `given`，其余文件用出题时冻结的那一份。 */
  files?: { path: string; contents: string }[];
}

export interface ExerciseResult {
  exerciseId: string;
  repositoryId: string;
  targetUnitId: string;
  kind: ExerciseKind;
  score: number;
  passed: boolean;
  automatic: boolean;
  gradingMode: ExerciseGradingMode;
  feedback: string;
  /** 反馈来源：rule=规则判分原文；llm_polished=LLM 润色的解释；llm_judge=rubric 判分产出。 */
  /** `sandbox` = 结论出自沙箱真跑（测试通过/失败计数），没经过任何模型；`llm_polished` 只改措辞不改结论。 */
  feedbackSource?: "rule" | "llm_polished" | "llm_judge" | "sandbox";
  matchedIds?: string[];
  missingIds?: string[];
  unexpectedIds?: string[];
  reviewedAt: string;
  review: ReviewSchedule;
}
