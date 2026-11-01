/**
  出题策略：写在出题技能的「出题策略」一节里，引擎现场读。
  - `unit`：题目锚在真实代码单元上（引擎挑单元、摘源码、按单元缓存）。
  - `reference`：源码只作参考，题目与素材由模型自定（代码题不再要求摘自仓库）。
*/

import { skillSection } from "./topic-tiers.js";

export type ExerciseStrategy = "unit" | "reference";

/** 技能没装、没写、写得认不出时的策略：锚在真实代码上，最容易自证通过。 */
export const DEFAULT_EXERCISE_STRATEGY: ExerciseStrategy = "unit";

const STRATEGY_SKILL = "exercise-code-concepts";
/** 声明行只认这一种写法，避免和下面解释两条策略的正文混淆。 */
const DECLARATION = /当前策略[：:]\s*`?(unit|reference)`?/;

export function exerciseStrategyOf(bodyOf: (name: string, file?: string) => string | undefined): ExerciseStrategy {
  const body = bodyOf(STRATEGY_SKILL);
  if (!body) return DEFAULT_EXERCISE_STRATEGY;
  const declared = DECLARATION.exec(skillSection(body, "出题策略"))?.[1];
  return declared === "reference" || declared === "unit" ? declared : DEFAULT_EXERCISE_STRATEGY;
}
