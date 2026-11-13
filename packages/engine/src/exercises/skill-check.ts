/** 技能包结构校验：通用基础校验 + 出题技能专属校验；只读。 */

import { attachedFiles, buildPointIndex, type BodyOf } from "./exam-points.js";
import { exerciseStrategyOf } from "./exercise-strategy.js";
import { DESCRIPTION_MAX, PAYLOAD_CHARS, SKILL_NAME_PATTERN, parseFrontmatter } from "./skill-spec.js";
import { skillSection, topicIndex } from "./topic-tiers.js";

export interface SkillCheckResult {
  errors: string[];
  warnings: string[];
}

export interface SkillCheckOptions {
  name?: string;
  /** 出题技能专有：考点表、概念词表、档位与配置。 */
  strict?: boolean;
}

export interface SkillSetReport {
  results: { name: string; strict: boolean; result: SkillCheckResult }[];
  skipped: { dir: string; reason: string }[];
  errorCount: number;
}

export const EXERCISE_SKILL = "exercise-code-concepts";
const MAIN_LINE_LIMIT = 40;

function checkBase(bodyOf: BodyOf, name: string, strict: boolean): SkillCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const main = bodyOf(name);
  if (!main) return { errors: [`${name}/SKILL.md 缺失或不可读`], warnings };

  const fields = parseFrontmatter(main);
  if (!Object.keys(fields).length) {
    errors.push("SKILL.md 缺少 frontmatter");
  } else {
    if (!fields.name || !SKILL_NAME_PATTERN.test(fields.name) || fields.name.includes("--")) errors.push("frontmatter.name 不符合命名规格");
    if (fields.name !== name) errors.push(`frontmatter.name 必须为 ${name}，实际为 ${fields.name ?? "（空）"}`);
    if (!fields.description) errors.push("frontmatter.description 缺失");
    else if (fields.description.length > DESCRIPTION_MAX) errors.push(`frontmatter.description 超过 ${DESCRIPTION_MAX} 字`);
  }

  for (const file of [...new Set([...main.matchAll(/`?([a-z0-9-]+\.md)`?/g)].map((match) => match[1]))].filter((entry) => entry !== "SKILL.md")) {
    const text = bodyOf(name, file);
    if (text === undefined) {
      errors.push(`附属文件缺失：${file}`);
      continue;
    }
    if (text.length > PAYLOAD_CHARS) errors.push(`${file} ${text.length} 字符，超过 ${PAYLOAD_CHARS} 字符上限`);
  }

  const lines = main.trimEnd().split("\n").length;
  if (lines > MAIN_LINE_LIMIT) {
    (strict ? errors : warnings).push(`SKILL.md ${lines} 行，超过 ${MAIN_LINE_LIMIT} 行上限`);
  }
  return { errors, warnings };
}

export function checkSkill(bodyOf: BodyOf, options: SkillCheckOptions = {}): SkillCheckResult {
  const name = options.name ?? EXERCISE_SKILL;
  const strict = options.strict ?? false;
  const base = checkBase(bodyOf, name, strict);
  if (!strict || bodyOf(name) === undefined) return base;
  const errors = [...base.errors];
  const warnings = [...base.warnings];
  const main = bodyOf(name)!;

  if (!skillSection(main, "出题策略").trim()) errors.push("SKILL.md 缺少「出题策略」章节");
  const index = buildPointIndex(bodyOf);
  if (!index.points.length) errors.push("考点表未解析出条目：检查表头是否含 id 列");
  if (!Object.keys(index.concepts).length) errors.push("concepts.json 未解析出概念");
  for (const [concept, words] of Object.entries(index.concepts)) {
    if (!Array.isArray(words) || words.some((word) => typeof word !== "string")) errors.push(`概念「${concept}」的同义词必须是字符串数组`);
  }

  const attached = attachedFiles(bodyOf);
  if (!attached.length) errors.push("主题表未列出附属文件");
  const tierNames = new Set(index.points.map((point) => point.tier));
  for (const file of attached) {
    if (bodyOf(name, file) !== undefined && !tierNames.has(file.replace(/\.md$/, ""))) errors.push(`${file} 未解析出考点：检查「能摘出来考的」章节与表头列`);
  }
  if (index.points.some((point) => !point.point.trim())) errors.push("考点表存在空「考点」列：检查表头是否含「考点」");
  if (index.points.some((point) => !point.probes.trim())) errors.push("考点表存在空 probes 列：检查表头是否含 probes");
  if (!topicIndex(bodyOf).tiers.length) errors.push("主题表未解析出档位：检查「主题 | 附属文件 | 常见缺陷」表");

  try {
    exerciseStrategyOf(bodyOf);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "config.json 校验失败");
  }

  const pointTiers = bodyOf(name, "point-tiers.json");
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
  return { errors, warnings };
}

/** 兼容入口：只校验出题技能。 */
export function checkSkillPackage(bodyOf: BodyOf): SkillCheckResult {
  return checkSkill(bodyOf, { name: EXERCISE_SKILL, strict: true });
}

/** 遍历技能清单；出厂技能缺失或解析失败都由 skipped 计入错误。 */
export function checkSkillSet(bodyOf: BodyOf, names: string[], skipped: { dir: string; reason: string }[] = []): SkillSetReport {
  const results = names.map((name) => {
    const strict = name === EXERCISE_SKILL;
    return { name, strict, result: checkSkill(bodyOf, { name, strict }) };
  });
  const errorCount = results.reduce((total, item) => total + item.result.errors.length, 0) + skipped.length;
  return { results, skipped, errorCount };
}
