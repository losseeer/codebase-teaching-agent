import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exercise, ExerciseKind } from "@codebase-tutor/domain";
import { traceEngine } from "@codebase-tutor/platform";

import { defineAnalysisStep } from "../analysis-step.js";
import type { LlmProvider, LlmUsage } from "../application/port/llm-provider.js";
import { completeWithReadTool, withSkillsBrief, type SkillReadAudit } from "../source/tool-loop.js";
import type { FileReadRecord } from "../source/read-file.js";
import { recordEgress, type EgressSource } from "../adapter/outbound/security/egress-log.js";
import { secretMasker } from "@codebase-tutor/domain";
import type { GuardCandidate } from "./guard-proposal.js";
import { NO_TOPICS, validTierOf, type TopicIndex } from "./topic-tiers.js";
import type { ExerciseFaces } from "./turn-faces.js";

/**
  练习题生成的 LLM 润色层（单轮调用）：只重写 title 与 prompt。
  kind / anchors / inputMode / gradingMode / options 不改，判分锚点与标准答案保持静态。
  任何失败都原样返回输入练习。
*/

const MAX_TITLE = 24;
const MAX_PROMPT = 300;
/** 一趟调用能带的摘录行数。 */
const MAX_EXCERPT_LINES = 240;

export interface RefinedExercise {
  exercise: Exercise;
  /** 只有模型真的改写了题面时才有。 */
  usage?: LlmUsage;
  /** 题面是否由模型改写。 */
  polished: boolean;
  polishFailure?: "no_excerpt" | "unparsable" | "provider_error";
}

/** 各题型的题面任务描述与防泄漏约束：题面不得暗示判分锚点。 */
const kindRules: Record<ExerciseKind, string> = {
  change_localization: "题面描述一次假设的修改需求（改行为/修缺陷/换实现），要求学习者从候选项中定位应改动的位置；题面不得暗示哪些候选文件或目录是正确答案。",
  impact_analysis: "题面描述一次假设的修改，要求学习者列出会受影响的调用方或用户路径；题面不得点名任何受影响文件。",
  patch_edit: "题面说明这段实现现在哪里不对、应当改成什么行为，要求学习者改代码让测试通过；题面不得点出缺陷所在的那一行，也不得出现测试断言的内容。",
  author_function: "题面给出函数签名、输入输出的形状与若干示例，要求学习者从零写出实现；题面不得复述参考解的算法步骤。",
  llm_rubric: "题面围绕给定主题描述一个开放的分析任务，要求学习者用自己的话作答；题面不得包含或暗示参考答案。"
};

/** 题面润色的系统提示词。 */
function refineSystemPrompt(kind: ExerciseKind): string {
  return [
    "你是代码教学产品的出题编辑。基于给定的题型、目标单元与源码摘录，重写练习题面，让它贴近真实代码细节、读起来像一道精心设计的手工题。",
    "",
    `本题型的任务与红线：${kindRules[kind]}`,
    "",
    "通用规则：",
    `- title：≤${MAX_TITLE} 字，具体并点出摘录中的真实符号（函数名/配置项/路由等），不用「练习 1」这类泛称。`,
    `- prompt：≤${MAX_PROMPT} 字，清晰陈述任务步骤；可引用摘录中的真实标识符与行号，但不要承诺摘录之外的行为。`,
    "- 不要给解题提示，不要复述标准答案；输出中出现的每个代码事实都必须能在摘录中找到。",
    "",
    "严格输出 JSON：{\"title\":\"…\",\"prompt\":\"…\"}，不要输出任何其他文字。"
  ].join("\n");
}

export async function refineExerciseWithLlm(repositoryPath: string, exercise: Exercise, provider: LlmProvider): Promise<RefinedExercise> {
  try {
    const excerpt = sourceExcerpt(repositoryPath, exercise);
    // 没有摘录就不改写题面
    if (!excerpt) return { exercise, polished: false, polishFailure: "no_excerpt" };

    const system = refineSystemPrompt(exercise.kind);

    const anchor = exercise.anchors[0];
    const user = JSON.stringify({
      kind: exercise.kind,
      target: exercise.targetTitle,
      anchor: anchor ? `${anchor.path}:${anchor.line}${anchor.endLine ? `-${anchor.endLine}` : ""}` : undefined,
      currentTitle: exercise.title,
      currentPrompt: exercise.prompt,
      sourceExcerpt: excerpt.text
    });

    recordEgress({ repositoryPath, scene: "practice.polish", sources: [excerptSource(excerpt)] });
    const response = await provider.complete({ system, user, temperature: 0.3, scene: "practice.polish" });
    const refined = parseRefinement(response.text, exercise);
    if (!refined) return { exercise, polished: false, polishFailure: "unparsable" };
    return { exercise: refined, usage: response.usage, polished: true };
  } catch {
    return { exercise, polished: false, polishFailure: "provider_error" };
  }
}

/** 出题/润色用的源码摘录：正文 + 实际发出去的路径与行区间。 */
interface ExerciseExcerpt {
  path: string;
  from: number;
  to: number;
  text: string;
  /** 这段摘录隐去了几处疑似密钥（0 = 扫过且干净）。 */
  masked: number;
  truncated?: boolean;
}

/** 摘录转成出网清单的一条。 */
function excerptSource(excerpt: ExerciseExcerpt): EgressSource {
  return { kind: "exercise-excerpt", path: excerpt.path, from: excerpt.from, to: excerpt.to, text: excerpt.text, masked: excerpt.masked, truncated: excerpt.truncated };
}

function sourceExcerpt(repositoryPath: string, exercise: Exercise): ExerciseExcerpt | undefined {
  const anchor = exercise.anchors[0];
  if (!anchor) return undefined;
  try {
    const lines = readFileSync(join(repositoryPath, anchor.path), "utf8").split("\n");
    const from = Math.max(0, anchor.line - 1);
    const to = Math.min(lines.length, anchor.endLine ? Math.max(anchor.endLine, anchor.line + 5) : anchor.line + MAX_EXCERPT_LINES);
    const masker = secretMasker();
    const shown = lines.slice(from, Math.min(to, from + MAX_EXCERPT_LINES)).map((line) => masker.take(line));
    const joined = shown.join("\n");
    const text = joined.slice(0, 20_000);
    // to 按实际进请求的行数算
    const sentLines = text.split("\n").length;
    return { path: anchor.path, from: from + 1, to: from + sentLines, text, masked: masker.masked, truncated: sentLines < shown.length || joined.length > text.length || undefined };
  } catch {
    return undefined;
  }
}

function parseRefinement(text: string, exercise: Exercise): Exercise | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;
  const title = String(parsed.title ?? "").trim().slice(0, MAX_TITLE);
  const prompt = String(parsed.prompt ?? "").trim().slice(0, MAX_PROMPT);
  if (!title || !prompt) return undefined;
  return { ...exercise, title, prompt };
}

/** LLM 出题的结果类型；proposal 仍需过确定性守门。被拒的那趟同样花了钱，失败支路也带 usage。 */
export type LlmGeneration =
  | { ok: false; reason: string; usage?: LlmUsage; skillReads: SkillReadAudit[]; fileReads: FileReadRecord[] }
  | { ok: true; proposal: LlmProposal; usage?: LlmUsage; skillReads: SkillReadAudit[]; fileReads: FileReadRecord[] };

export interface LlmProposal {
  title: string;
  prompt: string;
  answerKey: string;
  criteria: { dimension: string; description: string }[];
  anchors: { path: string; line: number; endLine?: number }[];
  targetTitle: string;
  /** 命中的主题档；注入了分解表才有。 */
  topicTier?: string;
  /** 该档里被考的那个可考点原文。 */
  examPoint?: string;
}

const GENERATION_SYSTEM_PROMPT = [
  "你是代码教学产品的出题人。基于用户给定的主题标签和若干候选源码摘录（带行号），出一道考察对该主题理解的开放式源码分析题。",
  "",
  "出题前先判断可行性：标签无意义、摘录里读不出任何可考点、或素材撑不起一道有明确参考答案的题，就拒绝出题。",
  "拒绝理由要写清找过哪些可考点；「某个性质在沙箱里跑不出真实结果」只限制问哪一层，不构成拒题。",
  "",
  "严格输出 JSON，二选一：",
  "拒绝：{\"ok\":false,\"reason\":\"<面向学习者的一句话拒绝理由，说明为什么当前仓库出不了这个主题的题>\"}",
  "出题：{\"ok\":true,\"title\":\"≤40字\",\"prompt\":\"≤200字题面\",\"answerKey\":\"<简洁的参考答案>\",\"criteria\":[{\"dimension\":\"评分维度\",\"description\":\"该维度的达标描述\"}],\"anchors\":[{\"path\":\"候选摘录中的文件路径\",\"line\":行号,\"endLine\":结束行号}],\"targetTitle\":\"<主题涉及的函数/文件名>\"}",
  "",
  "红线：",
  "- 题面只问一件事：不串第二个、第三个追问，学习者一次作答就该覆盖全部问点。",
  "- 题面引用的每个代码事实（符号、行为、行号）都必须能在摘录中找到；anchors 的 path 必须取自候选列表，行号必须在摘录标注的范围内。",
  "- 题面不得包含或暗示 answerKey 的内容。",
  "- criteria 给 2-4 条可操作的评分维度；answerKey 要具体到能让另一位评分者据此判分。"
].join("\n");

/**
  出题层的输入口径版本，进出题缓存键。
  指纹只锁引擎自己写的文案：主题分解表由技能内容注入，随用户装的技能变，不进锁。
*/
export const EXERCISE_STEP = defineAnalysisStep({
  layer: "exercise-generate",
  contractVersion: "exercise-v3",
  prompts: [GENERATION_SYSTEM_PROMPT, () => (Object.keys(kindRules) as ExerciseKind[]).map((kind) => refineSystemPrompt(kind)).join("\n")]
});

export async function generateExerciseWithLlm(input: { repositoryPath: string; tag: string; candidates: GuardCandidate[]; provider: LlmProvider; topics?: TopicIndex; faces?: ExerciseFaces }): Promise<LlmGeneration> {
  const topics = input.topics ?? NO_TOPICS;
  const excerpts = input.candidates.map((candidate) => ({
    path: candidate.path,
    lineCount: candidate.lineCount,
    excerpt: candidate.excerpt
  }));
  const user = JSON.stringify({ tag: input.tag, candidates: excerpts });
  // to 取构造时算好的实际末行
  recordEgress({
    repositoryPath: input.repositoryPath,
    scene: "practice.generate",
    sources: input.candidates.map((candidate) => {
      const from = candidate.startLine ?? 1;
      return { kind: "exercise-excerpt" as const, path: candidate.path, from, to: candidate.endLine ?? from + candidate.excerpt.split("\n").length - 1, text: candidate.excerpt, masked: candidate.masked };
    })
  });
  // 与问答回合同一条循环：有仓就能自己读文件、检索、查静态产物，轮数与读文件数取缺省
  const faces = input.faces ?? {};
  const baseSystem = topics.prompt ? `${GENERATION_SYSTEM_PROMPT}\n\n${topics.prompt}` : GENERATION_SYSTEM_PROMPT;
  const loop = await completeWithReadTool({
    ...faces,
    provider: input.provider,
    system: withSkillsBrief(baseSystem, faces.skills),
    user,
    temperature: 0.4,
    scene: "practice.generate"
  });
  const response = { text: loop.completion.text, usage: loop.usage, skillReads: loop.skillReads, fileReads: loop.fileReads };
  const parsed = parseJsonObject(response.text);
  if (!parsed) return { ok: false, usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads, reason: "模型给的题目读不出来，请重试。" };
  if (parsed.ok === false) {
    const reason = String(parsed.reason ?? "").trim();
    return { ok: false, usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads, reason: reason || "当前仓库没有适合该主题的出题素材。" };
  }
  if (parsed.ok !== true) return { ok: false, usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads, reason: "模型说它出不了这个题，或返回的内容缺判断标记；换个主题再试。" };
  const proposal = normalizeProposal(parsed, topics);
  if (!proposal) return { ok: false, usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads, reason: "模型给的题目字段不完整，请重试。" };
  return { ok: true, proposal, usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads };
}

/** 判分数字解析：可解析则钳到 0-1，否则返回 `undefined`。 */
function judgeScore(value: unknown): number | undefined {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || (typeof raw !== "number" && typeof raw !== "string")) return undefined;
  const score = Number(raw);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, Math.round(score * 100) / 100)) : undefined;
}

/** rubric 判分：拿参考答案与评分细则比对学习者回答，输出结构化分数。 */
export async function judgeRubricWithLlm(input: { prompt: string; answerKey: string; criteria: { dimension: string; description: string }[]; learnerAnswer: string; provider: LlmProvider; faces?: ExerciseFaces }): Promise<{ score: number; passed: boolean; feedback: string; usage?: LlmUsage; fileReads: FileReadRecord[] }> {
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
  const loop = await completeWithReadTool({ ...input.faces, provider: input.provider, system, user, temperature: 0.1, scene: "practice.judge" });
  const response = { text: loop.completion.text, usage: loop.usage };
  const fileReads = loop.fileReads;
  const parsed = parseJsonObject(response.text);
  const score = judgeScore(parsed?.score);
  if (!parsed || score === undefined) {
    // 读不出分数就不补值，只记录形状
    traceEngine("degrade", { what: "exercise_judge_unreadable", reason: parsed ? `score=${typeof parsed.score}` : "no_json_object", reply_chars: response.text.length });
    throw new Error("这次判分没成功，请再试一次。");
  }
  const passed = typeof parsed.passed === "boolean" ? parsed.passed : score >= 0.6;
  const feedback = String(parsed.feedback ?? "").trim().slice(0, 300) || (passed ? "回答与参考答案要点基本一致。" : "回答与参考答案存在差距，请对照反馈完善理解。");
  return { score, passed, feedback, usage: response.usage, fileReads };
}

/** 反馈润色：规则判分结果不变，只改写反馈；失败返回 undefined。 */
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
      sourceExcerpt: excerpt.text
    });
    recordEgress({ repositoryPath: input.repositoryPath, scene: "practice.feedback", sources: [excerptSource(excerpt)] });
    const response = await input.provider.complete({ system, user, temperature: 0.3, scene: "practice.feedback" });
    const parsed = parseJsonObject(response.text);
    const feedback = String(parsed?.feedback ?? "").trim();
    if (!feedback) return undefined;
    return { feedback: feedback.slice(0, 300), usage: response.usage };
  } catch {
    return undefined;
  }
}

/** 规则侧候选摘录：只认整行是注释的行。 */
const COMMENT_LINE = /^\s*(\/\/|#|--|\/\*|[*])/;
/** 连续到第几行才折叠注释。 */
const MIN_COMMENT_RUN = 4;

/** 按符号边界构造候选摘录，整段注释折成一行标注。 */
export function buildTagCandidate(repositoryPath: string, path: string, span: { start: number; end?: number }, maxLines = 240): GuardCandidate | undefined {
  try {
    const lines = readFileSync(join(repositoryPath, path), "utf8").split("\n");
    const start = Math.min(Math.max(1, Math.floor(span.start) || 1), lines.length);
    const symbolEnd = span.end !== undefined && span.end >= start ? Math.min(span.end, lines.length) : undefined;
    // 窗口末尾取两头中更近的那个
    const stop = Math.min(symbolEnd ?? lines.length, start + maxLines - 1, lines.length);
    const masker = secretMasker();
    const kept: string[] = [];
    const maxChars = 20_000;
    let used = 0;
    // lastEmitted 只记实际输出的最后一行
    let lastEmitted = start - 1;
    for (let index = start - 1; index < stop;) {
      if (COMMENT_LINE.test(lines[index] ?? "")) {
        let runEnd = index;
        while (runEnd + 1 < stop && COMMENT_LINE.test(lines[runEnd + 1] ?? "")) runEnd += 1;
        if (runEnd - index + 1 >= MIN_COMMENT_RUN) {
          kept.push(`…（第 ${index + 1}-${runEnd + 1} 行是注释，省略 ${runEnd - index + 1} 行）`);
          index = runEnd + 1;
          continue;
        }
      }
      const row = `${index + 1}| ${masker.take(lines[index] ?? "")}`;
      if (kept.length && used + row.length + 1 > maxChars) break;
      kept.push(row);
      used += row.length + 1;
      lastEmitted = index + 1;
      index += 1;
    }
    if (symbolEnd !== undefined && symbolEnd > lastEmitted) kept.push(`…（该符号到第 ${symbolEnd} 行才结束，摘录只给到第 ${lastEmitted} 行）`);
    return {
      path,
      lineCount: lines.length,
      startLine: start,
      endLine: lastEmitted,
      excerpt: kept.join("\n"),
      masked: masker.masked
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

/** 题面标题的显示上限（字符）。 */
export const MAX_PROPOSAL_TITLE = 60;
export function clipProposalTitle(title: string): string {
  return title.trim().slice(0, MAX_PROPOSAL_TITLE);
}

function normalizeProposal(parsed: Record<string, unknown>, topics: TopicIndex): LlmProposal | undefined {
  const title = clipProposalTitle(String(parsed.title ?? ""));
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
  // 注入了分解表才要求档位；表外的值当 off，不补一个看着合理的档。
  const topicTier = topics.tiers.length ? validTierOf(topics, String(parsed.topic_tier ?? "")) : undefined;
  const examPoint = String(parsed.exam_point ?? "").trim().slice(0, 60);
  return {
    title, prompt, answerKey, criteria, anchors,
    targetTitle: targetTitle || title,
    ...(topicTier ? { topicTier } : {}),
    ...(topicTier && examPoint ? { examPoint } : {})
  };
}
