import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exercise, ExerciseKind } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import type { GuardCandidate } from "./verify.js";

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

/** 各题型的题面任务描述与防泄漏约束——标准答案/判分锚点永远是静态分析产出，题面不得暗示它们。 */
const kindRules: Record<ExerciseKind, string> = {
  output_prediction: "题面描述目标函数的输入值与运行场景，要求学习者预测这段代码的输出；题面中不得出现真实返回值，也不得复述可直接读出答案的表达式求值结果。",
  change_localization: "题面描述一次假设的修改需求（改行为/修缺陷/换实现），要求学习者从候选项中定位应改动的位置；题面不得暗示哪些候选文件或目录是正确答案。",
  impact_analysis: "题面描述一次假设的修改，要求学习者列出会受影响的调用方或用户路径；题面不得点名任何受影响文件。",
  llm_rubric: "题面围绕给定主题描述一个开放的分析任务，要求学习者用自己的话作答；题面不得包含或暗示参考答案。"
};

export async function refineExerciseWithLlm(repositoryPath: string, exercise: Exercise, provider: LlmProvider): Promise<RefinedExercise> {
  try {
    const excerpt = sourceExcerpt(repositoryPath, exercise);
    if (!excerpt) return { exercise };

    const system = [
      "你是代码教学产品的出题编辑。基于给定的题型、目标单元与源码摘录，重写练习题面，让它贴近真实代码细节、读起来像一道精心设计的手工题。",
      "",
      `本题型的任务与红线：${kindRules[exercise.kind]}`,
      "",
      "通用规则：",
      `- title：≤${MAX_TITLE} 字，具体并点出摘录中的真实符号（函数名/配置项/路由等），不用「练习 1」这类泛称。`,
      `- prompt：≤${MAX_PROMPT} 字，清晰陈述任务步骤；可引用摘录中的真实标识符与行号，但不要承诺摘录之外的行为。`,
      "- 不要给解题提示，不要复述标准答案；输出中出现的每个代码事实都必须能在摘录中找到。",
      "",
      "严格输出 JSON：{\"title\":\"…\",\"prompt\":\"…\"}，不要输出任何其他文字。"
    ].join("\n");

    const anchor = exercise.anchors[0];
    const user = JSON.stringify({
      kind: exercise.kind,
      target: exercise.targetTitle,
      anchor: anchor ? `${anchor.path}:${anchor.line}${anchor.endLine ? `-${anchor.endLine}` : ""}` : undefined,
      currentTitle: exercise.title,
      currentPrompt: exercise.prompt,
      sourceExcerpt: excerpt
    });

    const response = await provider.complete({ system, user, maxTokens: 600, temperature: 0.3, scene: "practice.polish" });
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

/**
  LLM 出题（llm 族，单轮调用）：规则侧只提供候选源码摘录与用户主题标签，
  「能否出题」的判定与出题合并在同一轮——无意义标签 / 素材不足时模型拒绝并给出面向学习者的理由。
  返回的 proposal 仍需过 exercises/verify.ts 的确定性守门才允许落库。
  */
export type LlmGeneration =
  | { ok: false; reason: string }
  | { ok: true; proposal: LlmProposal; usage?: LlmUsage };

export interface LlmProposal {
  title: string;
  prompt: string;
  answerKey: string;
  criteria: { dimension: string; description: string }[];
  anchors: { path: string; line: number; endLine?: number }[];
  targetTitle: string;
}

const GENERATION_SYSTEM_PROMPT = [
  "你是代码教学产品的出题人。基于用户给定的主题标签和若干候选源码摘录（带行号），出一道考察对该主题理解的开放式源码分析题。",
  "",
  "出题前先判断可行性：如果标签无意义、或候选摘录与标签主题无关、或素材不足以支撑一道有明确参考答案的题，直接拒绝出题。",
  "",
  "严格输出 JSON，二选一：",
  "拒绝：{\"ok\":false,\"reason\":\"<面向学习者的一句话拒绝理由，说明为什么当前仓库出不了这个主题的题>\"}",
  "出题：{\"ok\":true,\"title\":\"≤40字\",\"prompt\":\"≤600字题面\",\"answerKey\":\"<简洁的参考答案>\",\"criteria\":[{\"dimension\":\"评分维度\",\"description\":\"该维度的达标描述\"}],\"anchors\":[{\"path\":\"候选摘录中的文件路径\",\"line\":行号,\"endLine\":结束行号}],\"targetTitle\":\"<主题涉及的函数/文件名>\"}",
  "",
  "红线：",
  "- 题面引用的每个代码事实（符号、行为、行号）都必须能在摘录中找到；anchors 的 path 必须取自候选列表，行号必须在摘录标注的范围内。",
  "- 题面不得包含或暗示 answerKey 的内容。",
  "- criteria 给 2-4 条可操作的评分维度；answerKey 要具体到能让另一位评分者据此判分。"
].join("\n");

export async function generateExerciseWithLlm(input: { tag: string; candidates: GuardCandidate[]; provider: LlmProvider }): Promise<LlmGeneration> {
  const excerpts = input.candidates.map((candidate) => ({
    path: candidate.path,
    lineCount: candidate.lineCount,
    excerpt: candidate.excerpt
  }));
  const user = JSON.stringify({ tag: input.tag, candidates: excerpts });
  const response = await input.provider.complete({ system: GENERATION_SYSTEM_PROMPT, user, maxTokens: 1_200, temperature: 0.4, scene: "practice.generate" });
  const parsed = parseJsonObject(response.text);
  if (!parsed) return { ok: false, reason: "LLM 返回内容无法解析为出题结果；请重试。" };
  if (parsed.ok === false) {
    const reason = String(parsed.reason ?? "").trim();
    return { ok: false, reason: reason || "当前仓库没有适合该主题的出题素材。" };
  }
  if (parsed.ok !== true) return { ok: false, reason: "LLM 返回内容缺少出题结果标记；请重试。" };
  const proposal = normalizeProposal(parsed);
  if (!proposal) return { ok: false, reason: "LLM 返回的出题结果字段不完整；请重试。" };
  return { ok: true, proposal, usage: response.usage };
}

/** rubric 判分（LLM-as-Judge + 细则锚点）：拿参考答案与评分细则比对学习者回答，输出结构化分数。 */
export async function judgeRubricWithLlm(input: { prompt: string; answerKey: string; criteria: { dimension: string; description: string }[]; learnerAnswer: string; provider: LlmProvider }): Promise<{ score: number; passed: boolean; feedback: string; usage?: LlmUsage }> {
  const system = [
    "你是编程练习的评分器。依据参考答案与评分细则，逐步比对学习者的回答并打分。",
    "严格输出 JSON：{\"score\":<0到1之间的两位小数>,\"passed\":<true|false>,\"feedback\":\"<≤200字中文反馈，指出答对了什么、差在哪里>\"}",
    "不要输出任何其他文字。"
  ].join("\n");
  const user = JSON.stringify({
    exercisePrompt: input.prompt,
    answerKey: input.answerKey,
    criteria: input.criteria,
    learnerAnswer: input.learnerAnswer
  });
  const response = await input.provider.complete({ system, user, maxTokens: 500, temperature: 0.1, scene: "practice.judge" });
  const parsed = parseJsonObject(response.text);
  if (!parsed || typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) {
    throw new Error("rubric 判分结果无法解析；请重试。");
  }
  const score = Math.max(0, Math.min(1, Number(parsed.score.toFixed(2))));
  const passed = typeof parsed.passed === "boolean" ? parsed.passed : score >= 0.6;
  const feedback = String(parsed.feedback ?? "").trim().slice(0, 300) || (passed ? "回答与参考答案要点基本一致。" : "回答与参考答案存在差距，请对照反馈完善理解。");
  return { score, passed, feedback, usage: response.usage };
}

/** 程序理解题的反馈润色：规则判分结果不变，只把反馈改写成解释性文字。任何失败返回 undefined，调用方保留规则原文。 */
export async function polishFeedbackWithLlm(input: { repositoryPath: string; exercise: Exercise; learnerAnswer: string; graded: { passed: boolean; score: number; feedback: string }; provider: LlmProvider }): Promise<{ feedback: string; usage?: LlmUsage } | undefined> {
  try {
    const excerpt = sourceExcerpt(input.repositoryPath, input.exercise);
    if (!excerpt) return undefined;
    const system = [
      "你是代码教学产品的反馈编辑。规则判分已给出结论（通过与否、得分、原始反馈），请把它改写成一段解释性反馈：说明为什么对，或错在哪里、该怎么想。",
      "- ≤160 字中文；引用的代码事实必须来自给定摘录；不得改动判分结论本身。",
      "严格输出 JSON：{\"feedback\":\"…\"}，不要输出任何其他文字。"
    ].join("\n");
    const user = JSON.stringify({
      exerciseTitle: input.exercise.title,
      exercisePrompt: input.exercise.prompt,
      learnerAnswer: input.learnerAnswer,
      verdict: { passed: input.graded.passed, score: input.graded.score, ruleFeedback: input.graded.feedback },
      sourceExcerpt: excerpt
    });
    const response = await input.provider.complete({ system, user, maxTokens: 300, temperature: 0.3, scene: "practice.feedback" });
    const parsed = parseJsonObject(response.text);
    const feedback = String(parsed?.feedback ?? "").trim();
    if (!feedback) return undefined;
    return { feedback: feedback.slice(0, 300), usage: response.usage };
  } catch {
    return undefined;
  }
}

/** 规则侧候选摘录构造：带行号前缀，LLM 的锚点行号以此为基准，守门可校验。 */
export function buildTagCandidate(repositoryPath: string, path: string, maxLines = 80): GuardCandidate | undefined {
  try {
    const lines = readFileSync(join(repositoryPath, path), "utf8").split("\n");
    const shown = lines.slice(0, maxLines);
    return {
      path,
      lineCount: lines.length,
      excerpt: shown.map((line, index) => `${index + 1}| ${line}`).join("\n").slice(0, 4_000)
    };
  } catch {
    return undefined;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(jsonText.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProposal(parsed: Record<string, unknown>): LlmProposal | undefined {
  const title = String(parsed.title ?? "").trim();
  const prompt = String(parsed.prompt ?? "").trim();
  const answerKey = String(parsed.answerKey ?? "").trim();
  const targetTitle = String(parsed.targetTitle ?? "").trim();
  const rawCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  const criteria = rawCriteria.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return { dimension: String(record.dimension ?? "").trim(), description: String(record.description ?? "").trim() };
  }).filter((item) => item.dimension && item.description);
  const rawAnchors = Array.isArray(parsed.anchors) ? parsed.anchors : [];
  const anchors = rawAnchors.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const anchor: { path: string; line: number; endLine?: number } = { path: String(record.path ?? "").trim(), line: Number(record.line) };
    const endLine = Number(record.endLine);
    if (Number.isInteger(endLine) && endLine > 0) anchor.endLine = endLine;
    return anchor;
  }).filter((item) => item.path && Number.isInteger(item.line) && item.line > 0);
  if (!title || !prompt || !answerKey || !criteria.length || !anchors.length) return undefined;
  return { title, prompt, answerKey, criteria, anchors, targetTitle: targetTitle || title };
}
