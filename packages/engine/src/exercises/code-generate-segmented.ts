/**
  出题分段产出：题面 → 代码 → 测试。

  为什么分段：一次整份 JSON 要吐 1.8 万 tokens，单次输出容易撞上模型调用的时间上限，
  而出题过程对用户是**一段黑箱**——失败时也说不清卡在哪一步。分段之后每一段都是一次独立的
  模型调用，轨迹里逐段可见（出题面 / 写代码 / 写测试），失败能定位到段，段级重出也只重写那一段。

  最终产物仍然是**一道完整的题**、一次性呈现给用户；分段只改变产出节奏。

  三条契约是踩过坑才补齐的，少一条就会整批失败（见每段的注释）：
  ① 段 2 要自己 `read_file` 看目标文件，不能靠段 1 转述源码（转述会把源码塞进段 1 的输出）；
  ② 段 3 必须拿到段 2 的实现全文与下发件的文件名，否则测试与实现对不上、编译不过；
  ③ 三段的 system 都要带各语言的测试形状规范（`TEST_CONTRACT`），缺了模型会写成裸 `assert`，
     断言一抛脚本就中断，stdout 里没有结论行，判分拿不到结果。
*/
import { EXERCISE_SEGMENT_LABEL, type ExerciseLanguage, type ExerciseSegment } from "@codebase-tutor/domain";
import type { LlmProvider, LlmUsage } from "../application/port/llm-provider.js";
import { addUsage } from "../adapter/outbound/llm/usage.js";
import {
  finishProposal,
  parseJsonObject,
  referenceSystemPrompt,
  requestProposal,
  TEST_CONTRACT,
  type CodeGeneration,
  type ProposalResponse
} from "./code-generate.js";
import type { ExerciseFaces } from "./turn-faces.js";
import { withSkillsBrief } from "../source/tool-loop.js";

/**
  分段产出默认开着：它只改产出节奏，产物仍是一道完整的题，而且不成会自动退回整份产出。
  想回到旧的整份产出，设 `TUTOR_EXERCISE_SEGMENTED=off`（0 / false / off 都算关）。
*/
export function segmentedExerciseEnabled(): boolean {
  const raw = (process.env.TUTOR_EXERCISE_SEGMENTED ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
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

const MAX_TITLE = 40;
const MAX_PROMPT = 800;

const baseRules = (kind: "patch_edit" | "author_function"): string[] => [
  `你是代码练习的出题人。${kind === "patch_edit" ? "要出一道给学习者改到测试全过的题：一段有真实缺陷的实现。" : "要出一道给学习者从零写实现的题：给签名与示例。"}`,
  "- 沙箱里没有任何第三方依赖：只用标准库；被测代码需要的仓库内符号，由你写成最小替身（stub）放进测试件。",
  "- 判分只由测试是否全过决定，所以测试必须**逐条断言、逐条计数**，最后印一行结论。",
  "- 测试要打在行为上（给定输入 → 期望输出/副作用），不要打在实现细节上。",
  kind === "patch_edit"
    ? "- 缺陷必须是**行为级**的真实错误（边界、比较符、单位、分支漏一条），一处即可；禁止用语法错误、删掉整个函数来制造缺陷。"
    : "- 骨架里只留签名与 `TODO`，不留任何可用实现。",
  "- 题面不得出现测试断言的原文，也不得点出缺陷所在的那一行。"
];

const promptStageRules = (): string[] => [
  "这一段只出**题面与目标文件清单**，不要写任何代码。",
  "题面用 Markdown 按这三节写：`## 问题描述`、`## 示例`、`## 注意事项`；示例写 1–2 个「调用 → 期望返回」，注意事项只写可核对的约束。",
  "- 各语言的测试形状（你选哪个语言就按哪个写，后面的代码段与测试段会各自遵守）：",
  ...(Object.keys(TEST_CONTRACT) as ExerciseLanguage[]).map((language) => `  ${language}：${TEST_CONTRACT[language]}`),
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
  "**预算：测试文件合计不超过 4000 字符**——只写必要的断言与最少量的导入，不要写多余的辅助函数、注释和样板。"
];

/** 这一段语言的测试形状规范：缺了它，模型会写成裸 assert，断言一抛脚本就中断，stdout 里没有结论行。 */
const testContractOf = (language: string): string[] => [
  `- 本语言的测试形状（必须照做，判分只认最后那行结论）：${TEST_CONTRACT[language as ExerciseLanguage] ?? ""}`
];

/** 段 1（题面）：语言由它声明，所以四种语言的测试形状全带上。 */
export function promptSystem(kind: "patch_edit" | "author_function"): string {
  return [...baseRules(kind), ...promptStageRules()].join("\n");
}

/** 段 2（代码）：语言已知，带那一种语言的测试形状。 */
export function codeSystem(kind: "patch_edit" | "author_function", language: string): string {
  return [...baseRules(kind), ...testContractOf(language), ...codeStageRules()].join("\n");
}

/** 段 3（测试）：同上——这一段最容易漏形状规范，漏了测试就跑不出结论行。 */
export function testsSystem(kind: "patch_edit" | "author_function", language: string): string {
  return [...baseRules(kind), ...testContractOf(language), ...testsStageRules()].join("\n");
}

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

function parsePlan(parsed: Record<string, unknown>): PlanSegment {
  const title = str(parsed.title, MAX_TITLE);
  const prompt = str(parsed.prompt, MAX_PROMPT);
  const language = str(parsed.language, 20);
  const targets = Array.isArray(parsed.targets)
    ? parsed.targets.map((item) => str(item, 200)).filter((item) => item.length > 0).slice(0, 3)
    : [];
  if (!title || !prompt || !language || !targets.length) throw new SegmentError("shape", "题面段缺 title / prompt / language / targets。");
  return { title, prompt, defect: str(parsed.defect, 200), language, targets };
}

function parseCode(parsed: Record<string, unknown>): CodeSegment {
  const given = slots(parsed.given);
  const solution = slots(parsed.solution);
  if (!given || !solution) throw new SegmentError("shape", "代码段缺 given 或 solution。");
  const paths = new Set(given.map((file) => file.path));
  if (solution.length !== given.length || solution.some((file) => !paths.has(file.path))) {
    throw new SegmentError("shape", "given 与 solution 的 path 集合必须完全一致。");
  }
  return { given, solution };
}

function parseTests(parsed: Record<string, unknown>): TestsSegment {
  const hidden = slots(parsed.hidden);
  const entry = str(parsed.entry, 200);
  if (!hidden || !entry) throw new SegmentError("shape", "测试段缺 hidden 或 entry。");
  return { hidden, entry };
}

/** 段内失败分两类：形状错（可重出）与其他（不重试）。 */
class SegmentError extends Error {
  constructor(readonly kind: "shape" | "fatal", message: string) {
    super(message);
  }
}

interface SegmentOutcome<T> {
  data?: T;
  usage?: LlmUsage;
  skillReads: ProposalResponse["skillReads"];
  fileReads: ProposalResponse["fileReads"];
  failure?: { stage: "provider_error" | "proposal_shape"; reason: string };
}

/** 跑一段：形状错可以重出（只重这一段），其余不重试。 */
async function runSegment<T>(
  run: (attempt: number) => Promise<{ data: T; usage?: LlmUsage; skillReads: ProposalResponse["skillReads"]; fileReads: ProposalResponse["fileReads"] }>,
  maxRetries: number
): Promise<SegmentOutcome<T>> {
  let failure: SegmentOutcome<T>["failure"];
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const out = await run(attempt);
      return { data: out.data, usage: out.usage, skillReads: out.skillReads, fileReads: out.fileReads };
    } catch (error) {
      const kind = error instanceof SegmentError ? error.kind : "fatal";
      const reason = error instanceof Error ? error.message : String(error);
      failure = { stage: kind === "shape" ? "proposal_shape" : "provider_error", reason };
      if (kind !== "shape") break;
    }
  }
  return { skillReads: [], fileReads: [], ...(failure ? { failure } : {}) };
}

/**
  按三段产出代码题；产物仍是一道完整的题。
  形状不合或自证不过时，调用方应退回整份产出的路径（分段是快速路径，不是唯一路径）。
*/
export async function generateCodeExerciseSegmented(input: {
  repositoryPath: string;
  tag: string;
  kind: "patch_edit" | "author_function";
  /** 参考素材：候选文件与摘录（只作参考，不要求逐字使用）。 */
  reference: string;
  provider: LlmProvider;
  faces?: ExerciseFaces;
  /** 每段最多重出几次（形状错才重）。 */
  maxSegmentRetries?: number;
}): Promise<CodeGeneration> {
  const faces = input.faces ?? {};
  const temperature = 0.4;
  const maxRetries = input.maxSegmentRetries ?? 1;
  let usage: LlmUsage | undefined;
  const skillReads: ProposalResponse["skillReads"] = [];
  const fileReads: ProposalResponse["fileReads"] = [];

  /** 段前缀：模型帧的 stepId 带上段名，轨迹里就能分清这是哪一段。段内重出要带序号，否则 stepId 会撞。 */
  const facesFor = (segment: ExerciseSegment, attempt = 1): ExerciseFaces => {
    const inner = faces.onTrace;
    if (!inner) return faces;
    const prefix = attempt > 1 ? `${segment}-${attempt}` : segment;
    return {
      ...faces,
      onTrace: (step) => inner({ ...step, stepId: `${prefix}-${step.stepId}`, label: EXERCISE_SEGMENT_LABEL[segment] })
    };
  };

  const planOut = await runSegment<PlanSegment>(async (attempt) => {
    const response = await requestProposal({
      provider: input.provider,
      system: withSkillsBrief(promptSystem(input.kind), faces.skills),
      user: JSON.stringify({ kind: input.kind, theme: input.tag, reference: input.reference }),
      temperature,
      ...(faces ? { faces: facesFor("prompt", attempt) } : {})
    });
    const parsed = parseJsonObject(response.text);
    if (!parsed) throw new SegmentError("shape", "题面段返回的不是可解析的 JSON。");
    if (parsed.ok === false) throw new SegmentError("shape", str(parsed.reason, 200) || "模型拒绝出题。");
    return { data: parsePlan(parsed), usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads };
  }, maxRetries);
  if (planOut.failure) {
    return { ok: false, stage: planOut.failure.stage, reason: planOut.failure.reason, runs: [], skillReads: [], ...(planOut.usage ? { usage: planOut.usage } : {}) };
  }
  const plan = planOut.data!;
  usage = addUsage(usage, planOut.usage);
  skillReads.push(...planOut.skillReads);
  fileReads.push(...planOut.fileReads);

  const codeOut = await runSegment<CodeSegment>(async (attempt) => {
    const response = await requestProposal({
      provider: input.provider,
      system: codeSystem(input.kind, plan.language),
      user: JSON.stringify({
        stage: "code", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect,
        targets: plan.targets, note: "目标文件的现状自己 read_file 读；接口、函数名、导入路径都要照仓库里的来"
      }),
      temperature,
      ...(faces ? { faces: facesFor("code", attempt) } : {})
    });
    const parsed = parseJsonObject(response.text);
    if (!parsed) throw new SegmentError("shape", "代码段返回的不是可解析的 JSON。");
    return { data: parseCode(parsed), usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads };
  }, maxRetries);
  if (codeOut.failure) {
    return { ok: false, stage: codeOut.failure.stage, reason: codeOut.failure.reason, runs: [], skillReads: [...skillReads], ...(usage ? { usage } : {}) };
  }
  const code = codeOut.data!;
  usage = addUsage(usage, codeOut.usage);
  skillReads.push(...codeOut.skillReads);
  fileReads.push(...codeOut.fileReads);

  const testsOut = await runSegment<TestsSegment>(async () => {
    const response = await input.provider.complete({
      system: testsSystem(input.kind, plan.language),
      user: JSON.stringify({
        stage: "tests", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect,
        targets: plan.targets,
        solution: code.solution,
        givenPaths: code.given.map((file) => file.path),
        note: "solution 是参考实现的全文，测试要对着它写；givenPaths 是下发件的文件名，hidden 里不要用这些名字"
      }),
      temperature,
      scene: "practice.generate-code"
    });
    const parsed = parseJsonObject(response.text);
    if (!parsed) throw new SegmentError("shape", "测试段返回的不是可解析的 JSON。");
    // 这一段没有工具循环，模型帧要自己发出去，否则轨迹里看不到「写测试」这一步。
    faces.onTrace?.({
      kind: "model", status: "ok", stepId: "tests-1", label: EXERCISE_SEGMENT_LABEL.tests,
      round: 1, model: input.provider.modelVersion, ms: undefined,
      ...(response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : {}),
      finishReason: "stop",
      reply: response.text.slice(0, 4_000)
    });
    return { data: parseTests(parsed), usage: response.usage, skillReads: [], fileReads: [] };
  }, maxRetries);
  if (testsOut.failure) {
    return { ok: false, stage: testsOut.failure.stage, reason: testsOut.failure.reason, runs: [], skillReads: [...skillReads], ...(usage ? { usage } : {}) };
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
        ...(faces.signal ? { signal: faces.signal } : {})
      }
    );

  const generation = await finish(merged);
  if (!generation.ok && generation.stage === "harness_validation") {
    // 自证没过：只重出该改的那一段（参考解没过就重代码，否则重测试），不整份重来。
    const solutionRun = generation.runs.find((run) => run.label === "solution");
    const stage: ExerciseSegment = solutionRun?.verdict && solutionRun.verdict.failed > 0 ? "code" : "tests";
    try {
      const retry = stage === "code"
        ? await requestProposal({
            provider: input.provider,
            system: codeSystem(input.kind, plan.language),
            user: JSON.stringify({
              stage: "code", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect,
              targets: plan.targets, note: "上一版的参考解没让测试全过，重出这一段"
            }),
            temperature,
            ...(faces ? { faces: facesFor(stage) } : {})
          })
        : await input.provider.complete({
            system: testsSystem(input.kind, plan.language),
            user: JSON.stringify({
              stage: "tests", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect,
              targets: plan.targets, solution: code.solution, givenPaths: code.given.map((file) => file.path),
              note: "上一版的测试没覆盖住缺陷（或与实现对不上），重出这一段"
            }),
            temperature,
            scene: "practice.generate-code"
          });
      const parsed = parseJsonObject(retry.text);
      if (!parsed) throw new SegmentError("shape", "重出段返回的不是可解析的 JSON。");
      usage = addUsage(usage, retry.usage);
      const next = stage === "code" ? { ...merged, ...parseCode(parsed) } : { ...merged, ...parseTests(parsed) };
      return await finish(next);
    } catch (error) {
      return { ...generation, reason: `${generation.reason}（重出「${EXERCISE_SEGMENT_LABEL[stage]}」段仍没过：${error instanceof Error ? error.message : String(error)}）` };
    }
  }
  return generation;
}
