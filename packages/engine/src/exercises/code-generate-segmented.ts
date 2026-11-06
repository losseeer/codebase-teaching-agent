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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXERCISE_SEGMENT_ACTIVE, EXERCISE_SEGMENT_LABEL, type ExerciseLanguage, type ExerciseSegment } from "@codebase-tutor/domain";
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
import { pathReadBlock } from "../source/read-file.js";
import type { ExerciseFaces, ExerciseProgressSink } from "./turn-faces.js";
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
interface Anchor {
  path: string;
  line: number;
  endLine?: number;
  why?: string;
}
interface CodeSegment {
  given: FileSlot[];
  solution: FileSlot[];
  anchors: Anchor[];
}
interface TestsSegment {
  hidden: FileSlot[];
  entry: string;
}

const MAX_TITLE = 40;
/** 产品侧 PROMPT_TARGET=800 是目标字数、MAX_PROMPT=1600 才是截断线。这里对齐上限——
    当成 800 截会把三节里的「注意事项」整段切掉，题面就不成篇了。 */
const MAX_PROMPT = 1_600;

/** 题面必须齐的三节；缺一节就重出，别把半篇题面发给学习者。 */
const PROMPT_SECTIONS = ["## 问题描述", "## 示例", "## 注意事项"] as const;

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
  "题面用 Markdown 按这三节写，**三节缺一不可**：",
  "  `## 问题描述`：背景 + 要改/写哪个函数 + 判定看什么行为；",
  "  `## 示例`：1–2 个「调用 → 期望返回」（类题用操作序列），不要复刻隐藏断言；",
  "  `## 注意事项`：只写可核对的约束（语言/标准库、能否改签名、边界条件），不写性能要求，也不点出缺陷所在的那一行。",
  "- 不要写「相关文件 / 参考代码」小节，也不要在题面里粘贴参考文件路径：参考文件由界面按 anchors 展示（在代码段的 JSON 里给）。",
  "- 各语言的测试形状（你选哪个语言就按哪个写，后面的代码段与测试段会各自遵守）：",
  ...(Object.keys(TEST_CONTRACT) as ExerciseLanguage[]).map((language) => `  ${language}：${TEST_CONTRACT[language]}`),
  '严格输出 JSON（不要任何其他文字）：{"ok":true,"language":"typescript|python|java|go","title":"≤40字","prompt":"≤800字题面","defect":"<缺陷的一句话说明，仅留档>","targets":["<要改或要写的文件>"]}',
  "- `targets` 必须是**仓库内的真实相对路径**（带目录，例如 `sl-admin/src/main/java/com/x/BoundedWorkerPool.java`），而且必须是你这一趟用 `read_file` **成功读到过**的文件；只写裸文件名（`BoundedWorkerPool.java`）会让下一段读不到文件。",
  '或拒绝：{"ok":false,"reason":"<面向学习者的一句话：这个主题为什么出不了代码题>"}'
];

const codeStageRules = (): string[] => [
  "这一段只出**给定件与参考解**两份文件，不要写测试，也不要写题面。",
  "目标文件的现状自己用 `read_file` 读，不要凭空编接口：这一段允许你检索仓库。",
  '严格输出 JSON（不要任何其他文字）：{"given":[{"path":"target.ts","contents":"<下发给学习者的整份文件源码>"}],"solution":[{"path":"target.ts","contents":"<应当全过的那一份>"}],"anchors":[{"path":"<你真正读过、并取用了实现的文件>","line":起始行,"endLine":结束行,"why":"取用了什么，≤30字"}]}',
  "anchors 最多 3 条，只填真正取材过的文件；一处都没参考就填空数组。产品靠它显示「相关文件」。",
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

/**
  直接把目标文件的当前内容读给段 2（引擎本地读，不花 token）。
  走 read_file 同一套安全判据（禁读文件名 / 越出仓库 / 非普通文件），单文件截到 12,000 字符。
*/
function targetSnapshots(repositoryPath: string, targets: string[]): { path: string; contents: string }[] {
  const out: { path: string; contents: string }[] = [];
  for (const target of targets.slice(0, 3)) {
    if (pathReadBlock(repositoryPath, target)) continue;
    try {
      const text = readFileSync(join(repositoryPath, target), "utf8");
      out.push({ path: target, contents: text.slice(0, 12_000) });
    } catch {
      // 读不到就不给，让模型自己检索
    }
  }
  return out;
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
  if (!title || !prompt || !language || !targets.length) throw new Error("题面段缺 title / prompt / language / targets。");
  const missing = PROMPT_SECTIONS.filter((section) => !prompt.includes(section));
  if (missing.length) throw new Error(`题面缺这几节：${missing.join("、")}——必须按「问题描述 / 示例 / 注意事项」三节写完整。`);
  return { title, prompt, defect: str(parsed.defect, 200), language, targets };
}

export function parseCode(parsed: Record<string, unknown>): CodeSegment {
  const given = slots(parsed.given);
  const solution = slots(parsed.solution);
  if (!given || !solution) throw new Error("代码段缺 given 或 solution。");
  const paths = new Set(given.map((file) => file.path));
  if (solution.length !== given.length || solution.some((file) => !paths.has(file.path))) {
    throw new Error("given 与 solution 的 path 集合必须完全一致。");
  }
  const anchors: Anchor[] = Array.isArray(parsed.anchors)
    ? (parsed.anchors as unknown[]).flatMap((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        const path = str(record.path, 200);
        const line = Math.floor(Number(record.line));
        if (!path || !Number.isFinite(line) || line < 1) return [];
        const endLine = Math.floor(Number(record.endLine));
        const why = str(record.why, 60);
        return [{ path, line, ...(Number.isFinite(endLine) && endLine > line ? { endLine } : {}), ...(why ? { why } : {}) }];
      }).slice(0, 3)
    : [];
  return { given, solution, anchors };
}

function parseTests(parsed: Record<string, unknown>): TestsSegment {
  const hidden = slots(parsed.hidden);
  const entry = str(parsed.entry, 200);
  if (!hidden || !entry) throw new Error("测试段缺 hidden 或 entry。");
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
  /** 出题进度：界面靠它显示「正在出题面 / 写代码 / 写测试」，不传就只剩一个转圈。 */
  onProgress?: ExerciseProgressSink;
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
      // 只有模型帧改成段名；工具帧必须保留工具自己的名字——否则「读技能 / 检索代码」全被盖成
      // 「出题面」，轨迹里就看不到模型到底调了什么工具（曾经因此误以为前期没加载技能）。
      onTrace: (step) => inner({
        ...step,
        stepId: `${prefix}-${step.stepId}`,
        ...(step.kind === "model" ? { label: EXERCISE_SEGMENT_ACTIVE[segment] } : {})
      })
    };
  };

  /** 每段开始时播报一次：界面据此把「出题面 / 写代码 / 写测试」显示成当前步骤。 */
  const announce = (segment: ExerciseSegment): void => {
    input.onProgress?.({ stage: "proposing", detail: EXERCISE_SEGMENT_ACTIVE[segment] });
  };

  const planOut = await runSegment<PlanSegment>(async (attempt) => {
    announce("prompt");
    const response = await requestProposal({
      provider: input.provider,
      system: withSkillsBrief(promptSystem(input.kind), faces.skills),
      user: JSON.stringify({ kind: input.kind, theme: input.tag, reference: input.reference }),
      temperature,
      ...(faces ? { faces: facesFor("prompt", attempt) } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
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
    announce("code");
    const response = await requestProposal({
      provider: input.provider,
      system: withSkillsBrief(codeSystem(input.kind, plan.language), faces.skills),
      user: JSON.stringify({
        stage: "code", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect,
        targets: plan.targets,
        // 目标文件的现状由引擎直接给（本地读，不花 token）：段 2 就不用再 read_file 读一遍，
        // 省一轮工具往返和那一轮的上下文。读不到（targets 写歪了）才留空让它自己检索。
        targetFiles: targetSnapshots(input.repositoryPath, plan.targets),
        // 段 1 真正读成功过的路径：targets 写歪了（比如只剩裸文件名）时，这一段照这份清单读。
        readPaths: planOut.fileReads.filter((read) => !read.denied && !read.error).map((read) => read.path).slice(0, 8),
        note: "targetFiles 是目标文件当前的全文，直接用；接口、函数名、导入路径都要照它来。读不到的内容自己 read_file 补。"
      }),
      temperature,
      ...(faces ? { faces: facesFor("code", attempt) } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {})
    });
    const parsed = parseJsonObject(response.text);
    if (!parsed) throw new SegmentError("shape", "代码段返回的不是可解析的 JSON。");
    return { data: parseCode(parsed), usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads };
  }, maxRetries);
  if (codeOut.failure) {
    return { ok: false, stage: codeOut.failure.stage, reason: codeOut.failure.reason, runs: [], skillReads: [...skillReads], ...(usage ? { usage } : {}), plan: { title: plan.title, prompt: plan.prompt, defect: plan.defect } };
  }
  const code = codeOut.data!;
  usage = addUsage(usage, codeOut.usage);
  skillReads.push(...codeOut.skillReads);
  fileReads.push(...codeOut.fileReads);

  const testsOut = await runSegment<TestsSegment>(async () => {
    announce("tests");
    // 段 3 是裸调用，没有工具循环替我们发帧：补一条「开始」，
    // 否则轨迹会停在上一段的最后一帧，看起来像已经结束了。
    faces.onTrace?.({
      kind: "model", status: "start", stepId: "tests-start",
      label: EXERCISE_SEGMENT_ACTIVE.tests, round: 1, model: input.provider.modelVersion
    });
    const startedAt = Date.now();
    const response = await input.provider.complete({
      system: withSkillsBrief(testsSystem(input.kind, plan.language), faces.skills),
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
      // stepId 与上面那条「开始」帧一致：界面按 stepId 合并，一条从上到下走完，
      // 不要变成「正在写测试（转圈）」+「正在写测试（已完成）」两行。
      kind: "model", status: "ok", stepId: "tests-start", label: EXERCISE_SEGMENT_ACTIVE.tests,
      round: 1, model: input.provider.modelVersion, ms: Date.now() - startedAt,
      ...(response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : {}),
      finishReason: "stop",
      reply: response.text.slice(0, 4_000)
    });
    return { data: parseTests(parsed), usage: response.usage, skillReads: [], fileReads: [] };
  }, maxRetries);
  if (testsOut.failure) {
    return { ok: false, stage: testsOut.failure.stage, reason: testsOut.failure.reason, runs: [], skillReads: [...skillReads], ...(usage ? { usage } : {}), plan: { title: plan.title, prompt: plan.prompt, defect: plan.defect } };
  }
  const tests = testsOut.data!;
  usage = addUsage(usage, testsOut.usage);

  // 「相关文件」靠 anchors：模型在代码段点名取材来源；没点名就用这一趟真读过的文件兜底，
  // 否则界面那一栏永远是空的（分段刚上线时就是漏了这个字段）。
  const anchors = code.anchors.length
    ? code.anchors
    : codeOut.fileReads.filter((read) => !read.denied && !read.error).slice(0, 3)
        .map((read) => ({ path: read.path, line: 1, why: "这一趟读过" }));
  const merged = {
    ok: true,
    language: plan.language,
    title: plan.title,
    prompt: plan.prompt,
    defect: plan.defect,
    given: code.given,
    solution: code.solution,
    hidden: tests.hidden,
    entry: tests.entry,
    ...(anchors.length ? { anchors } : {})
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
            system: withSkillsBrief(codeSystem(input.kind, plan.language), faces.skills),
            user: JSON.stringify({
              stage: "code", kind: input.kind, language: plan.language, title: plan.title, prompt: plan.prompt, defect: plan.defect,
              targets: plan.targets, note: "上一版的参考解没让测试全过，重出这一段"
            }),
            temperature,
            ...(faces ? { faces: facesFor(stage) } : {})
          })
        : await input.provider.complete({
            system: withSkillsBrief(testsSystem(input.kind, plan.language), faces.skills),
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
