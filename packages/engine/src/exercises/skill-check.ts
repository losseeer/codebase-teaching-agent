/** 技能包结构校验：只读，返回全部错误与警告；写入或同步前调用。 */

import { buildPointIndex } from "./exam-points.js";
import { exerciseStrategyOf } from "./exercise-strategy.js";
import { topicIndex } from "./topic-tiers.js";

export interface SkillCheckResult {
  errors: string[];
  warnings: string[];
}

const SKILL = "exercise-code-concepts";
/** 主文件行数上限；改写完成前超限只告警。 */
const MAIN_LINE_LIMIT = 40;

export function checkSkillPackage(bodyOf: (name: string, file?: string) => string | undefined): SkillCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const main = bodyOf(SKILL);
  if (!main) return { errors: ["SKILL.md 缺失或不可读"], warnings };

  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(main);
  if (!front) {
    errors.push("SKILL.md 缺少 frontmatter");
  } else {
    const name = /^name:\s*(.+)$/m.exec(front[1])?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(front[1])?.[1]?.trim();
    if (name !== SKILL) errors.push(`frontmatter.name 必须为 ${SKILL}，实际为 ${name ?? "（空）"}`);
    if (!description) errors.push("frontmatter.description 缺失");
  }

  const index = buildPointIndex(bodyOf);
  if (!index.points.length) errors.push("考点表未解析出条目：检查六列表头与 id / concepts / probes 三列");
  if (!Object.keys(index.concepts).length) errors.push("concepts.json 未解析出概念");

  if (!topicIndex(bodyOf).tiers.length) errors.push("主题表未解析出档位：检查「主题 | 附属文件 | 形态」表与附属文件是否存在");

  try {
    exerciseStrategyOf(bodyOf);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "config.json 校验失败");
  }

  const tiers = bodyOf(SKILL, "point-tiers.json");
  if (tiers !== undefined) {
    try {
      const parsed = JSON.parse(tiers) as Record<string, unknown>;
      for (const key of ["enabled", "grey", "disabled"]) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) errors.push(`point-tiers.json 的 ${key} 必须为数组`);
      }
    } catch {
      errors.push("point-tiers.json 不是合法 JSON");
    }
  }

  const referenced = new Set(index.points.flatMap((point) => point.concepts));
  for (const concept of Object.keys(index.concepts)) {
    if (!referenced.has(concept)) errors.push(`概念「${concept}」未被任何考点引用`);
  }

  const lines = main.split("\n").length;
  if (lines > MAIN_LINE_LIMIT) warnings.push(`SKILL.md ${lines} 行，超过 ${MAIN_LINE_LIMIT} 行上限`);
  return { errors, warnings };
}
