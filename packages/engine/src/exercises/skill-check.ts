/** 技能包结构校验：只读，返回全部错误与警告；供 skills:check 与同步脚本使用。 */

import { attachedFiles, buildPointIndex, type BodyOf } from "./exam-points.js";
import { exerciseStrategyOf } from "./exercise-strategy.js";
import { DESCRIPTION_MAX, PAYLOAD_CHARS, SKILL_NAME_PATTERN, parseFrontmatter } from "./skill-spec.js";
import { skillSection, topicIndex } from "./topic-tiers.js";

export interface SkillCheckResult {
  errors: string[];
  warnings: string[];
}

const SKILL = "exercise-code-concepts";
/** 主文件行数上限；超限告警。 */
const MAIN_LINE_LIMIT = 40;

export function checkSkillPackage(bodyOf: BodyOf): SkillCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const main = bodyOf(SKILL);
  if (!main) return { errors: ["SKILL.md 缺失或不可读"], warnings };

  const fields = parseFrontmatter(main);
  if (!Object.keys(fields).length) {
    errors.push("SKILL.md 缺少 frontmatter");
  } else {
    if (!fields.name || !SKILL_NAME_PATTERN.test(fields.name) || fields.name.includes("--")) errors.push("frontmatter.name 不符合命名规格");
    if (fields.name !== SKILL) errors.push(`frontmatter.name 必须为 ${SKILL}，实际为 ${fields.name ?? "（空）"}`);
    if (!fields.description) errors.push("frontmatter.description 缺失");
    else if (fields.description.length > DESCRIPTION_MAX) errors.push(`frontmatter.description 超过 ${DESCRIPTION_MAX} 字`);
  }

  if (!skillSection(main, "出题策略").trim()) errors.push("SKILL.md 缺少「出题策略」章节");

  const index = buildPointIndex(bodyOf);
  if (!index.points.length) errors.push("考点表未解析出条目：检查表头是否含 id 列");
  if (!Object.keys(index.concepts).length) errors.push("concepts.json 未解析出概念");

  const attached = attachedFiles(bodyOf);
  if (!attached.length) errors.push("主题表未列出附属文件");
  const tierNames = new Set(index.points.map((point) => point.tier));
  for (const file of attached) {
    if (bodyOf(SKILL, file) === undefined) {
      errors.push(`附属文件缺失：${file}`);
      continue;
    }
    if (!tierNames.has(file.replace(/\.md$/, ""))) errors.push(`${file} 未解析出考点：检查「能摘出来考的」章节与表头列`);
  }
  if (index.points.some((point) => !point.point.trim())) errors.push("考点表存在空「考点」列：检查表头是否含「考点」");
  if (index.points.some((point) => !point.probes.trim())) errors.push("考点表存在空 probes 列：检查表头是否含 probes");
  for (const [concept, words] of Object.entries(index.concepts)) {
    if (!Array.isArray(words) || words.some((word) => typeof word !== "string")) errors.push(`概念「${concept}」的同义词必须是字符串数组`);
  }

  if (!topicIndex(bodyOf).tiers.length) errors.push("主题表未解析出档位：检查「主题 | 附属文件 | 常见缺陷」表");

  try {
    exerciseStrategyOf(bodyOf);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "config.json 校验失败");
  }

  const pointTiers = bodyOf(SKILL, "point-tiers.json");
  if (pointTiers !== undefined) {
    try {
      const parsed = JSON.parse(pointTiers) as Record<string, unknown>;
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

  const lines = main.trimEnd().split("\n").length;
  if (lines > MAIN_LINE_LIMIT) errors.push(`SKILL.md ${lines} 行，超过 ${MAIN_LINE_LIMIT} 行上限`);
  for (const file of attached.filter((name) => name.endsWith(".md"))) {
    const chars = (bodyOf(SKILL, file) ?? "").length;
    if (chars > PAYLOAD_CHARS) errors.push(`${file} ${chars} 字符，超过 ${PAYLOAD_CHARS} 字符上限`);
  }
  return { errors, warnings };
}
