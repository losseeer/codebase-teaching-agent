import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exercise, ExerciseKind } from "@codebase-tutor/domain";
import { traceEngine } from "@codebase-tutor/platform";

import { defineAnalysisStep } from "../analysis-step.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { completeWithOptionalSkills, type SkillReadAudit, type SkillsToolContext } from "../source/tool-loop.js";
import { recordEgress, type EgressSource } from "../security/egress-log.js";
import { secretMasker } from "../security/secrets.js";
import type { GuardCandidate } from "./guard-proposal.js";

/**
  练习题生成的 LLM 润色层（单轮调用）：
  - 输入：静态分析产出的结构化练习（题型 / 目标单元 / 锚点源码摘录）
  - 输出：仅重写 title（题面标题）与 prompt（题面描述），让题目更贴近真实代码细节
  - 不改 kind / anchors / inputMode / gradingMode / options —— 判分锚点与标准答案保持静态，
    保证 execution / set_match / rubric 三种判分路径不受 LLM 输出影响
  - 任何失败都原样返回输入练习；与其余调用点共用同一套 `TUTOR_LLM_*` 配置（见 llm/provider.ts）
  */

const MAX_TITLE = 24;
const MAX_PROMPT = 300;
const MAX_EXCERPT_LINES = 60;

export interface RefinedExercise {
  exercise: Exercise;
  /** 只有模型真的改写了题面时才有；回落那几条一律不给，免得记录把降级读成调用成功 */
  usage?: LlmUsage;
  /**
    题面是不是模型真的改写的：润色失败回落启发式题面，调用方要把三种成因分开记；
    回落原因一并交出去，才知道该修端点还是修解析。
    */
  polished: boolean;
  polishFailure?: "no_excerpt" | "unparsable" | "provider_error";
}

/** 各题型的题面任务描述与防泄漏约束——理解题与主观题的判分锚点永远是静态分析产出，题面不得暗示它们。 */
const kindRules: Record<ExerciseKind, string> = {
  change_localization: "题面描述一次假设的修改需求（改行为/修缺陷/换实现），要求学习者从候选项中定位应改动的位置；题面不得暗示哪些候选文件或目录是正确答案。",
  impact_analysis: "题面描述一次假设的修改，要求学习者列出会受影响的调用方或用户路径；题面不得点名任何受影响文件。",
  patch_edit: "题面说明这段实现现在哪里不对、应当改成什么行为，要求学习者改代码让测试通过；题面不得点出缺陷所在的那一行，也不得出现测试断言的内容。",
  author_function: "题面给出函数签名、输入输出的形状与若干示例，要求学习者从零写出实现；题面不得复述参考解的算法步骤。",
  llm_rubric: "题面围绕给定主题描述一个开放的分析任务，要求学习者用自己的话作答；题面不得包含或暗示参考答案。"
};

/**
  题面润色这一步的提示词（按题型取 `kindRules` 那一条红线）。提出来成函数是为了让口径登记的指纹
  能把全部题型的文案一次覆盖（见 `EXERCISE_STEP` 的 prompts）。
*/
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
    // 摘录读不出来＝这道题连源码都没给模型看，题面必然是规则拼的——不记一笔就没人知道润色没跑
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
    const response = await provider.complete({ system, user, maxTokens: 600, temperature: 0.3, scene: "practice.polish" });
    const refined = parseRefinement(response.text, exercise);
    if (!refined) return { exercise, polished: false, polishFailure: "unparsable" };
    return { exercise: refined, usage: response.usage, polished: true };
  } catch {
    return { exercise, polished: false, polishFailure: "provider_error" };
  }
}

/** 出题/润色用的源码摘录：除了正文还带「哪条路径的哪几行确实发出去了」，供出网清单登记（`security/egress-log.ts`）。 */
interface ExerciseExcerpt {
  path: string;
  from: number;
  to: number;
  text: string;
  /** 这段摘录隐去了几处疑似密钥（0 = 扫过且干净）。报表要靠它区分「扫过且为 0」与「没扫」。 */
  masked: number;
  truncated?: boolean;
}

/** 摘录 → 出网清单的一条（润色与反馈两处共用）。 */
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
    // 与锚点摘录、L1、read_file 同一道出网前筛（`security/secrets.ts`）：这段是源码原文，出网前必须过筛。
    const masker = secretMasker();
    const shown = lines.slice(from, Math.min(to, from + MAX_EXCERPT_LINES)).map((line) => masker.take(line));
    const joined = shown.join("\n");
    const text = joined.slice(0, 4_000);
    // `to` 按真的进请求的那几行算：4,000 字符上限也可能在中间中止，最后几行没出门就不能算进去
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

/**
  LLM 出题（llm 族，单轮调用）：规则侧只提供候选源码摘录与用户主题标签，
  「能否出题」的判定与出题合并在同一轮——无意义标签 / 素材不足时模型拒绝并给出面向学习者的理由。
  返回的 proposal 仍需过 exercises/guard-proposal.ts 的确定性守门才允许落库。
  */
export type LlmGeneration =
  | { ok: false; reason: string; skillReads: SkillReadAudit[] }
  | { ok: true; proposal: LlmProposal; usage?: LlmUsage; skillReads: SkillReadAudit[] };

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

/**
  出题层的输入口径版本，进出题缓存的作用域键（见 `ExerciseService.exerciseScope`）。
  版本号只留给不进提示词文案的那类失效——生成逻辑本身变了（比如正确答案怎么进选项池），
  已冻结进缓存的坏题不会自愈，只能整体作废重来。
  「题面提示词、`kindRules`、裁剪上限」不用手 bump：它们都被插进提示词文案，改任何一处
  下面的指纹就变，守卫测试当场拦（见 `analysis-step.ts`）。
  代码族另外挂 `#runner=<指纹>`（见 `exercises.ts` 的 `fileScope`），那一轴不在本版本号里。
  */
export const EXERCISE_STEP = defineAnalysisStep({
  layer: "exercise-generate",
  contractVersion: "exercise-v3",
  prompts: [GENERATION_SYSTEM_PROMPT, () => (Object.keys(kindRules) as ExerciseKind[]).map((kind) => refineSystemPrompt(kind)).join("\n")]
});

export async function generateExerciseWithLlm(input: { repositoryPath: string; tag: string; candidates: GuardCandidate[]; provider: LlmProvider; skills?: SkillsToolContext }): Promise<LlmGeneration> {
  const excerpts = input.candidates.map((candidate) => ({
    path: candidate.path,
    lineCount: candidate.lineCount,
    excerpt: candidate.excerpt
  }));
  const user = JSON.stringify({ tag: input.tag, candidates: excerpts });
  // 出网清单：候选摘录是带行号的源码窗口。`to` 用构造时算好的实际末行——窗口里折过注释、也可能被字符上限截断，行数不再等于行跨度
  recordEgress({
    repositoryPath: input.repositoryPath,
    scene: "practice.generate",
    sources: input.candidates.map((candidate) => {
      const from = candidate.startLine ?? 1;
      return { kind: "exercise-excerpt" as const, path: candidate.path, from, to: candidate.endLine ?? from + candidate.excerpt.split("\n").length - 1, text: candidate.excerpt, masked: candidate.masked };
    })
  });
  const response = await completeWithOptionalSkills({
    provider: input.provider,
    // 清单由技能通道自己并进系统提示词：这一趟没有 read_file，能取的就是技能正文（两轮封顶）
    system: GENERATION_SYSTEM_PROMPT,
    user,
    maxTokens: 1_200,
    temperature: 0.4,
    scene: "practice.generate",
    ...(input.skills ? { skills: input.skills } : {})
  });
  const parsed = parseJsonObject(response.text);
  if (!parsed) return { ok: false, skillReads: response.skillReads, reason: "模型给的题目读不出来，请重试。" };
  if (parsed.ok === false) {
    const reason = String(parsed.reason ?? "").trim();
    return { ok: false, skillReads: response.skillReads, reason: reason || "当前仓库没有适合该主题的出题素材。" };
  }
  if (parsed.ok !== true) return { ok: false, skillReads: response.skillReads, reason: "模型说它出不了这个题，或返回的内容缺判断标记；换个主题再试。" };
  const proposal = normalizeProposal(parsed);
  if (!proposal) return { ok: false, skillReads: response.skillReads, reason: "模型给的题目字段不完整，请重试。" };
  return { ok: true, proposal, usage: response.usage, skillReads: response.skillReads };
}

/**
  判分读数：`score` 要的是 0~1 的数字，但模型常按「两位小数」的字面意思把它写成字符串（`"0.00"`）。
  能读成数字就照它给的分判（含越界钳制），读不出就是没判出来——不猜分、不补分。
*/
function judgeScore(value: unknown): number | undefined {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || (typeof raw !== "number" && typeof raw !== "string")) return undefined;
  const score = Number(raw);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, Math.round(score * 100) / 100)) : undefined;
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
  const score = judgeScore(parsed?.score);
  if (!parsed || score === undefined) {
    // 读不出分数就是没判出来，不能补一个数；这里只报形状不抄正文——判分反馈会引述源码，日志不该再开一个出网面
    traceEngine("degrade", { what: "exercise_judge_unreadable", reason: parsed ? `score=${typeof parsed.score}` : "no_json_object", reply_chars: response.text.length });
    throw new Error("这次判分没成功，请再试一次。");
  }
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
      sourceExcerpt: excerpt.text
    });
    recordEgress({ repositoryPath: input.repositoryPath, scene: "practice.feedback", sources: [excerptSource(excerpt)] });
    const response = await input.provider.complete({ system, user, maxTokens: 300, temperature: 0.3, scene: "practice.feedback" });
    const parsed = parseJsonObject(response.text);
    const feedback = String(parsed?.feedback ?? "").trim();
    if (!feedback) return undefined;
    return { feedback: feedback.slice(0, 300), usage: response.usage };
  } catch {
    return undefined;
  }
}

/** 规则侧候选摘录：只认「整行是注释」的行，行尾注释不猜——那行代码本身是素材。 */
const COMMENT_LINE = /^\s*(\/\/|#|--|\/\*|[*])/;
/** 连续到第 4 行才折：三行以下的注释常常正是题目要问的东西。 */
const MIN_COMMENT_RUN = 4;

/**
  规则侧候选摘录构造：按符号边界开窗（固定 80 行硬窗会把锚点旁边的无关函数一起端进去），
  并把窗口内连续 ≥4 行的整段注释折成一行标注。带行号前缀，LLM 的锚点行号以此为基准，守门可校验。
  折叠处不给行号：那几行没出网，模型引用不到，守门也不该让它当成锚点。
  符号比 maxLines 长时截到上限并在末尾说明截到哪，不静默丢。
 */
export function buildTagCandidate(repositoryPath: string, path: string, span: { start: number; end?: number }, maxLines = 80): GuardCandidate | undefined {
  try {
    const lines = readFileSync(join(repositoryPath, path), "utf8").split("\n");
    const start = Math.min(Math.max(1, Math.floor(span.start) || 1), lines.length);
    const symbolEnd = span.end !== undefined && span.end >= start ? Math.min(span.end, lines.length) : undefined;
    // 窗口两头：符号末尾行与 maxLines 取更近的那个——只看 maxLines 就等于把锚点旁边的无关函数也端进来
    const stop = Math.min(symbolEnd ?? lines.length, start + maxLines - 1, lines.length);
    const masker = secretMasker();
    const kept: string[] = [];
    const maxChars = 4_000;
    let used = 0;
    // 实际出门的最后一行：折叠掉的注释与字符上限之后截断的行都不算，出网清单要报的就是这一格
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
      // 逐行过筛：整段源码在这一条路上同样是原文出网
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

/** 题面标题的显示上限：标题只进列表与下拉，超长在这里截，不再整题否决（拒题＝白付这一趟调用）。 */
export const MAX_PROPOSAL_TITLE = 60;
export function clipProposalTitle(title: string): string {
  return title.trim().slice(0, MAX_PROPOSAL_TITLE);
}

function normalizeProposal(parsed: Record<string, unknown>): LlmProposal | undefined {
  // 标题只用于列表与会话下拉：超长不再整题否决（拒题＝白付这一趟），在这里截到稳定上限
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
  return { title, prompt, answerKey, criteria, anchors, targetTitle: targetTitle || title };
}
