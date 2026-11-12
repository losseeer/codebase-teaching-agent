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

/** 旧副本的散文声明；技能正文不含该声明时返回 undefined。 */
export function legacyStrategyOf(body: string | undefined): ExerciseStrategy | undefined {
  if (body === undefined) return undefined;
  const declared = DECLARATION.exec(skillSection(body, "出题策略"))?.[1];
  return declared === "reference" || declared === "unit" ? declared : undefined;
}

export function exerciseStrategyOf(bodyOf: (name: string, file?: string) => string | undefined): ExerciseStrategy {
  const raw = bodyOf(STRATEGY_SKILL, CONFIG_FILE);
  if (raw !== undefined) return parseConfig(raw);
  const body = bodyOf(STRATEGY_SKILL);
  if (body === undefined) throw new Error(`出厂技能 ${STRATEGY_SKILL} 缺失：请在设置里恢复出厂技能。`);
  const legacy = legacyStrategyOf(body);
  if (legacy) return legacy;
  throw new Error(`技能 ${STRATEGY_SKILL} 缺少 ${CONFIG_FILE}：需要 {"exerciseStrategy":"unit"|"reference"}，或在「出题策略」一节声明当前策略。`);
}
