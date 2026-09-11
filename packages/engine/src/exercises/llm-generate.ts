import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exercise } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";

/**
  练习题生成的 LLM 润色层（单轮调用）：
  - 输入：静态分析产出的结构化练习（题型 / 目标单元 / 锚点源码摘录）
  - 输出：仅重写 title（题面标题）与 prompt（题面描述），让题目更贴近真实代码细节
  - **不改** kind / anchors / inputMode / gradingMode / options —— 判分锚点与标准答案保持静态，
    保证 execution / set_match / rubric 三种判分路径不受 LLM 输出影响
  - 任何失败都原样返回输入练习；与 refineCourseMap 共用 TUTOR_TEACHING_PROVIDER 配置
  */

const MAX_TITLE = 24;
const MAX_PROMPT = 300;
const MAX_EXCERPT_LINES = 60;

export interface RefinedExercise {
  exercise: Exercise;
  usage?: LlmUsage;
}

export async function refineExerciseWithLlm(repositoryPath: string, exercise: Exercise, provider: LlmProvider): Promise<RefinedExercise> {
  try {
    const excerpt = sourceExcerpt(repositoryPath, exercise);
    if (!excerpt) return { exercise };

    const system = [
      "你是代码教学产品的出题编辑。根据给定的题型、目标单元与源码摘录，重写练习题面：",
      `title（≤${MAX_TITLE} 字，具体、点出真实代码符号）与 prompt（≤${MAX_PROMPT} 字，清晰陈述任务，`,
      "可引用摘录中的真实标识符，但不要泄漏答案，也不要承诺摘录之外的行为）。",
      "严格输出 JSON：{\"title\":\"…\",\"prompt\":\"…\"}，不要输出其他文字。"
    ].join("");

    const user = JSON.stringify({
      kind: exercise.kind,
      target: exercise.targetTitle,
      currentTitle: exercise.title,
      currentPrompt: exercise.prompt,
      sourceExcerpt: excerpt
    });

    const response = await provider.complete({ system, user, maxTokens: 600, temperature: 0.3 });
    const refined = parseRefinement(response.text, exercise);
    return { exercise: refined ?? exercise, usage: refined ? response.usage : undefined };
  } catch {
    return { exercise };
  }
}

function sourceExcerpt(repositoryPath: string, exercise: Exercise): string | undefined {
  const anchor = exercise.anchors[0];
  if (!anchor) return undefined;
  try {
    const lines = readFileSync(join(repositoryPath, anchor.path), "utf8").split("\n");
    const from = Math.max(0, anchor.line - 1);
    const to = Math.min(lines.length, anchor.endLine ? Math.max(anchor.endLine, anchor.line + 5) : anchor.line + MAX_EXCERPT_LINES);
    return lines.slice(from, Math.min(to, from + MAX_EXCERPT_LINES)).join("\n").slice(0, 4_000);
  } catch {
    return undefined;
  }
}

function parseRefinement(text: string, exercise: Exercise): Exercise | undefined {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const title = String((parsed as { title?: unknown }).title ?? "").trim().slice(0, MAX_TITLE);
  const prompt = String((parsed as { prompt?: unknown }).prompt ?? "").trim().slice(0, MAX_PROMPT);
  if (!title || !prompt) return undefined;
  return { ...exercise, title, prompt };
}
