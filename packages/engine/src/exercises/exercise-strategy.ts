/**
  出题策略：读技能包内的 config.json（exerciseStrategy 字段）。
  取值非 unit / reference 时抛错，不回落默认值；迁移期兼容 SKILL.md「出题策略」一节的旧声明。
*/

import { skillSection } from "./topic-tiers.js";

export type ExerciseStrategy = "unit" | "reference";

/** 技能未安装、未提供配置且无旧声明时采用：题目锚在真实代码单元上。 */
export const DEFAULT_EXERCISE_STRATEGY: ExerciseStrategy = "unit";

const STRATEGY_SKILL = "exercise-code-concepts";
const CONFIG_FILE = "config.json";
const DECLARATION = /当前策略[：:]\s*`?(unit|reference)`?/;

function parseConfig(raw: string): ExerciseStrategy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`技能配置 ${CONFIG_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const value = (parsed as { exerciseStrategy?: unknown } | null)?.exerciseStrategy;
  if (value === "unit" || value === "reference") return value;
  throw new Error(`技能配置 ${CONFIG_FILE} 的 exerciseStrategy 必须为 "unit" 或 "reference"，实际为 ${JSON.stringify(value)}`);
}

export function exerciseStrategyOf(bodyOf: (name: string, file?: string) => string | undefined): ExerciseStrategy {
  const raw = bodyOf(STRATEGY_SKILL, CONFIG_FILE);
  if (raw !== undefined) return parseConfig(raw);
  const body = bodyOf(STRATEGY_SKILL);
  const declared = body ? DECLARATION.exec(skillSection(body, "出题策略"))?.[1] : undefined;
  return declared === "reference" || declared === "unit" ? declared : DEFAULT_EXERCISE_STRATEGY;
}
