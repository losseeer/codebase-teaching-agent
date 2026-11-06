/**
  [DEV ONLY] 三段产出：题面 → 代码 → 测试。

  动机：一次整份 JSON 要吐 1.8 万 tokens，基线里 20% 的出题是**单次输出撞 240s 超时**
  （`provider_error` 不重试，直接判失败）。分段之后每次输出都短，超时这条路先被掐掉；
  合并后仍交给产品既有的 `finishProposal` 校验与沙箱两跑，所以判分口径与单段完全一致。

  与对照臂的差别只在产出协议：单段一次整份（产品现状，可带 1 次整份重写的修复回路），
  分段三段各一次、失败只重出那一段。变量单一，其余（模型、素材、题面约束、判分）全同。

  这是实验代码，不进产品构建。
*/
import type { LlmProvider, LlmUsage } from "../../src/application/port/llm-provider.js";
import { addUsage } from "../../src/adapter/outbound/llm/usage.js";
import {
  finishProposal,
  parseJsonObject,
  referenceSystemPrompt,
  requestProposal,
  type CodeGeneration,
  type HarnessRun,
  type ProposalResponse
} from "../../src/exercises/code-generate.js";
import type { ExerciseFaces } from "../../src/exercises/turn-faces.js";
import type { ExerciseProgressSink } from "../../src/exercises/turn-faces.js";
import { withSkillsBrief } from "../../src/source/tool-loop.js";

export type SegmentStage = "prompt" | "code" | "tests";

export interface SegmentEvent {
  stage: SegmentStage;
  attempt: number;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export interface SegmentedResult {
  generation: CodeGeneration;
  segments: SegmentEvent[];
}

interface FileSlot {
  path: string;
  contents: string;
}
interface PlanSegment {
  title: string;
  prompt: string;
  defect: string;
  language: string;
  targets: string[];
}
interface CodeSegment {
  given: FileSlot[];
  solution: FileSlot[];
}
interface TestsSegment {
  hidden: FileSlot[];
  entry: string;
}

/** 段内失败分两类：形状错（可重出）与 provider 失败（不重试，与产品一致）。 */
class SegmentError extends Error {
  constructor(readonly kind: "proposal_shape" | "provider_error", message: string) {
    super(message);
  }
}

const MAX_TITLE = 40;
const MAX_PROMPT = 800;

const baseRules = (kind: "patch_edit" | "author_function"): string[] => [
  `你是代码练习的出题人。${kind === "patch_edit" ? "要出一道给学习者改到测试全过的题：一段有真实缺陷的实现。" : "要出一道给学习者从零写实现的题：给签名与示例。"}`,
  "- 沙箱里没有任何第三方依赖：只用标准库；被测代码需要的仓库内符号，由你写成最小替身（stub）放进测试件。",
  "- 判分只由测试是否全过决定，所以测试必须逐条断言、逐条计数，最后印一行结论。",
  "- 测试要打在行为上（给定输入 → 期望输出/副作用），不要打在实现细节上。",
  kind === "patch_edit"
    ? "- 缺陷必须是**行为级**的真实错误（边界、比较符、单位、分支漏一条），一处即可；禁止用语法错误、删掉整个函数来制造缺陷。"
    : "- 骨架里只留签名与 `TODO`，不留任何可用实现。",
  "- 题面不得出现测试断言的原文，也不得点出缺陷所在的那一行。"
];

const promptStageRules = (): string[] => [
  "这一段只出**题面与目标文件清单**，不要写任何代码。",
  "题面用 Markdown 按这三节写：`## 问题描述`、`## 示例`、`## 注意事项`；示例写 1–2 个「调用 → 期望返回」，注意事项只写可核对的约束。",
  '严格输出 JSON（不要任何其他文字）：{"ok":true,"language":"typescript|python|java|go","title":"≤40字","prompt":"≤800字题面","defect":"<缺陷的一句话说明，仅留档>","targets":["<要改或要写的文件路径>"]}',
  '或拒绝：{"ok":false,"reason":"<面向学习者的一句话：这个主题为什么出不了代码题>"}'
];

const codeStageRules = (): string[] => [
  "这一段只出**给定件与参考解**两份文件，不要写测试，也不要写题面。",
  "目标文件的现状自己用 `read_file` 读，不要凭空编接口：这一段允许你检索仓库。",
  '严格输出 JSON（不要任何其他文字）：{"given":[{"path":"target.ts","contents":"<下发给学习者的整份文件源码>"}],"solution":[{"path":"target.ts","contents":"<应当全过的那一份>"]}',
  "两份文件的 **path 集合必须完全一致**；contents 是整份文件源码，不是片段。",
  "同一语言的项目里，除测试件外不要再引入第三方依赖。",
  "预算：两份文件合计不超过 6000 字符，只写必要实现，不要加多余的注释与辅助函数。"
];

const testsStageRules = (): string[] => [
  "这一段只出**测试件**（以及必要的替身），不要写题面，也不要写给定件与参考解。",
  "参考实现已经给你了，测试必须**对着它的函数名、签名与导入路径**写，否则编译不过。",
  '严格输出 JSON（不要任何其他文字）：{"hidden":[{"path":"tests.ts","contents":"<测试>"},{"path":"stub.ts","contents":"<替身，可无>"}],"entry":"tests.ts"}',
  "hidden 的文件不得与给定件同名；entry 必须是 hidden 里那个测试文件（java 填类名，不带 .java）。",
  "测试逐条断言、逐条计数，最后印一行结论。",
  "**预算：测试文件合计不超过 4000 字符**——只写必要的断言与最少量的导入，不要写多余的辅助函数、注释和样板。"
];

const str = (value: unknown, limit: number): string => (typeof value === "string" ? value.trim().slice(0, limit) : "");
const slots = (value: unknown): FileSlot[] | undefined => {
  if (!Array.isArray(value) || !value.length || value.length > 3) return undefined;
  const out: FileSlot[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const entry = item as Record<string, unknown>;
    const path = str(entry.path, 200);
    const contents = typeof entry.contents === "string" ? entry.contents : "";
    if (!path || !contents.trim()) return undefined;
    out.push({ path, contents });
  }
  return out;
};

export function parsePlan(parsed: Record<string, unknown>): PlanSegment {
  const title = str(parsed.title, MAX_TITLE);
  const prompt = str(parsed.prompt, MAX_PROMPT);
  const language = str(parsed.language, 20);
  const targets = Array.isArray(parsed.targets)
    ? parsed.targets.map((item) => str(item, 200)).filter((item) => item.length > 0).slice(0, 3)
    : [];
  if (!title || !prompt || !language || !targets.length) throw new SegmentError("proposal_shape", "题面段缺 title / prompt / language / targets。");
  return { title, prompt, defect: str(parsed.defect, 200), language, targets };
}

export function parseCode(parsed: Record<string, unknown>): CodeSegment {
  const given = slots(parsed.given);
  const solution = slots(parsed.solution);
  if (!given || !solution) throw new SegmentError("proposal_shape", "代码段缺 given 或 solution。");
  const paths = new Set(given.map((file) => file.path));
  if (solution.length !== given.length || solution.some((file) => !paths.has(file.path))) {
    throw new SegmentError("proposal_shape", "given 与 solution 的 path 集合必须完全一致。");
  }
  return { given, solution };
}

export function parseTests(parsed: Record<string, unknown>): TestsSegment {
  const hidden = slots(parsed.hidden);
  const entry = str(parsed.entry, 200);
  if (!hidden || !entry) throw new SegmentError("proposal_shape", "测试段缺 hidden 或 entry。");
  return { hidden, entry };
}

/** harness 没过时该重出哪一段：参考实现自己没过就是实现写错了，否则是测试没覆盖住缺陷。 */
export function repairSegmentOf(runs: readonly HarnessRun[]): SegmentStage {
  const solution = runs.find((run) => run.label === "solution");
  return solution?.verdict && solution.verdict.failed > 0 ? "code" : "tests";
}

interface SegmentOutcome<T> {
  data?: T;
  usage?: LlmUsage;
  skillReads: ProposalResponse["skillReads"];
  fileReads: ProposalResponse["fileReads"];
  failure?: { stage: "provider_error" | "proposal_shape"; reason: string };
}

/** 跑一段：形状错可以重出（只重这一段），provider 失败不重试（与产品一致）。 */
async function runSegment<T>(
  stage: SegmentStage,
  run: () => Promise<{ data: T; usage?: LlmUsage; skillReads: ProposalResponse["skillReads"]; fileReads: ProposalResponse["fileReads"] }>,
  segments: SegmentEvent[],
  maxRetries: number
): Promise<SegmentOutcome<T>> {
  let failure: SegmentOutcome<T>["failure"];
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const started = Date.now();
    try {
      const out = await run();
      segments.push({
        stage, attempt, ok: true, ms: Date.now() - started,
        ...(out.usage ? { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens } : {})
      });
      return { data: out.data, usage: out.usage, skillReads: out.skillReads, fileReads: out.fileReads };
    } catch (error) {
      const kind = error instanceof SegmentError ? error.kind : "provider_error";
      const reason = error instanceof Error ? error.message : String(error);
      segments.push({ stage, attempt, ok: false, ms: Date.now() - started, error: reason });
      failure = { stage: kind, reason };
      if (kind !== "proposal_shape") break;
    }
  }
  return { skillReads: [], fileReads: [], ...(failure ? { failure } : {}) };
}

export async function generateCodeExerciseSegmented(input: {
  repositoryPath: string;
  tag: string;
  kind: "patch_edit" | "author_function";
  /** 参考素材：候选文件与摘录（只作参考，不要求逐字使用）。 */
  reference: string;
  provider: LlmProvider;
  faces?: ExerciseFaces;
  onProgress?: ExerciseProgressSink;
  /** 每段最多重出几次（形状错才重）。 */
  maxSegmentRetries?: number;
}): Promise<SegmentedResult> {
  const segments: SegmentEvent[] = [];
  const temperature = 0.4;
  const maxRetries = input.maxSegmentRetries ?? 1;
  const faces = input.faces ?? {};
  let usage: LlmUsage | undefined;
  const skillReads: ProposalResponse["skillReads"] = [];
  const fileReads: ProposalResponse["fileReads"] = [];

  input.onProgress?.({ stage: "proposing" });
  const planOut = await runSegment<PlanSegment>("prompt", async () => {
    const response = await requestProposal({
      provider: input.provider,
      system: withSkillsBrief([...baseRules(input.kind), ...promptStageRules()].join("\n"), faces.skills),
      user: JSON.stringify({ kind: input.kind, theme: input.tag, reference: input.reference }),
      temperature,
      ...(input.faces ? { faces: input.faces } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
    });
    const parsed = parseJsonObject(response.text);
    if (!parsed) throw new SegmentError("proposal_shape", "题面段返回的不是可解析的 JSON。");
    if (parsed.ok === false) throw new SegmentError("proposal_shape", str(parsed.reason, 200) || "模型拒绝出题。");
    return { data: parsePlan(parsed), usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads };
  }, segments, maxRetries);
  if (planOut.failure) {
    return {
      generation: { ok: false, stage: planOut.failure.stage, reason: planOut.failure.reason, runs: [], skillReads: [], ...(planOut.usage ? { usage: planOut.usage } : {}) },
      segments
    };
  }
  const plan = planOut.data!;
  usage = addUsage(usage, planOut.usage);
  skillReads.push(...planOut.skillReads);
  fileReads.push(...planOut.fileReads);

  const codeOut = await runSegment<CodeSegment>("code", async () => {
    // 段 2 也走工具循环：目标文件的现状让它自己 read_file，不靠段 1 转述（转述会把源码带进段 1 的输出）。
    const response = await requestProposal({
      provider: input.provider,
      system: [...baseRules(input.kind), ...codeStageRules()].join("\n"),
      user: JSON.stringify({ stage: "code", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect, targets: plan.targets, note: "目标文件的现状自己 read_file 读；接口、函数名、导入路径都要照仓库里的来" }),
      temperature,
      ...(input.faces ? { faces: input.faces } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
    });
    const parsed = parseJsonObject(response.text);
    if (!parsed) throw new SegmentError("proposal_shape", "代码段返回的不是可解析的 JSON。");
    return { data: parseCode(parsed), usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads };
  }, segments, maxRetries);
  if (codeOut.failure) {
    return {
      generation: { ok: false, stage: codeOut.failure.stage, reason: codeOut.failure.reason, runs: [], skillReads: [...skillReads], ...(usage ? { usage } : {}) },
      segments
    };
  }
  const code = codeOut.data!;
  usage = addUsage(usage, codeOut.usage);

  const testsOut = await runSegment<TestsSegment>("tests", async () => {
    const response = await input.provider.complete({
      system: [...baseRules(input.kind), ...testsStageRules()].join("\n"),
      // 段 3 必须拿到段 2 的实现全文：测试要照它的函数名与签名写，否则编译不过（上一轮就是这里断的）。
      user: JSON.stringify({ stage: "tests", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect, targets: plan.targets, solution: code.solution, note: "solution 是参考实现的全文，测试要对着它写" }),
      temperature,
      scene: "practice.generate-code"
    });
    const parsed = parseJsonObject(response.text);
    if (!parsed) throw new SegmentError("proposal_shape", "测试段返回的不是可解析的 JSON。");
    return { data: parseTests(parsed), usage: response.usage, skillReads: [], fileReads: [] };
  }, segments, maxRetries);
  if (testsOut.failure) {
    return {
      generation: { ok: false, stage: testsOut.failure.stage, reason: testsOut.failure.reason, runs: [], skillReads: [...skillReads], ...(usage ? { usage } : {}) },
      segments
    };
  }
  const tests = testsOut.data!;
  usage = addUsage(usage, testsOut.usage);

  const merged = {
    ok: true,
    language: plan.language,
    title: plan.title,
    prompt: plan.prompt,
    defect: plan.defect,
    given: code.given,
    solution: code.solution,
    hidden: tests.hidden,
    entry: tests.entry
  };
  const finish = async (body: typeof merged): Promise<CodeGeneration> =>
    await finishProposal(
      { text: JSON.stringify(body), ...(usage ? { usage } : {}), skillReads, fileReads },
      {
        kind: input.kind,
        repositoryPath: input.repositoryPath,
        refusal: "模型认为这个主题出不了代码题。",
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        ...(input.faces?.signal ? { signal: input.faces.signal } : {})
      }
    );

  let generation = await finish(merged);
  // 自证没过：只重出该改的那一段（实现没过就重代码，否则重测试），不整份重来。
  if (!generation.ok && generation.stage === "harness_validation") {
    const stage = repairSegmentOf(generation.runs);
    const started = Date.now();
    try {
      const retry = stage === "code"
        ? await requestProposal({
            provider: input.provider,
            system: [...baseRules(input.kind), ...codeStageRules()].join("\n"),
            user: JSON.stringify({ stage: "code", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect, targets: plan.targets, note: "上一版的参考解没让测试全过，重出这一段" }),
            temperature,
            ...(input.faces ? { faces: input.faces } : {})
          })
        : await input.provider.complete({
            system: [...baseRules(input.kind), ...testsStageRules()].join("\n"),
            user: JSON.stringify({ stage: "tests", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect, targets: plan.targets, note: "上一版的测试没覆盖住缺陷（或与实现对不上），重出这一段" }),
            temperature,
            scene: "practice.generate-code"
          });
      const parsed = parseJsonObject(retry.text);
      if (!parsed) throw new SegmentError("proposal_shape", "重出段返回的不是可解析的 JSON。");
      usage = addUsage(usage, retry.usage);
      segments.push({ stage, attempt: 2, ok: true, ms: Date.now() - started, ...(retry.usage ? { inputTokens: retry.usage.inputTokens, outputTokens: retry.usage.outputTokens } : {}) });
      const next = stage === "code" ? { ...merged, ...parseCode(parsed) } : { ...merged, ...parseTests(parsed) };
      generation = await finish(next);
    } catch (error) {
      segments.push({ stage, attempt: 2, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { generation, segments };
}

/** 参考素材拼装：与单段实验同一份候选摘录，两臂必须完全一致。 */
export function referenceOf(candidates: { path: string; excerpt: string }[]): string {
  return candidates.map((candidate) => `## ${candidate.path}\n${candidate.excerpt}`).join("\n\n").slice(0, 24_000);
}
