/**
  [DEV ONLY] design-followup-2026-11 的实验臂：三段生成包。

  对照臂（产品现状）= 单次生成整份自由 JSON + 整份修复 + 模型自己写测试。
  本模块 = 三段拆分 + 逐段结构化校验 + 定向修复 + 引擎测试骨架。

  三段：
    1. plan  —— 题面 / 缺陷 / 语言 / anchors（沿用工具循环，可自己检索素材）
    2. impl  —— given / solution / stubs（不带测试）
    3. tests —— 测试文件（引擎给骨架，模型只填断言）

  只有失败的那一段会被重发；harness 自证失败时按 runs 定位到 impl 或 tests 段，
  不再重出题面与实现全套。沙箱两跑自证复用产品的 validateHarness，判据不变。

  本文件不进入产品构建（tsconfig.json 只 include src），也不登记分析步骤，
  因此不改 prompt 指纹锁、不改出题缓存作用域、不改 HTTP 接口。
*/
import { z } from "zod";
import type { ExerciseLanguage } from "@codebase-tutor/domain";

import type { LlmProvider, LlmUsage } from "../../src/application/port/llm-provider.js";
import { LlmAbortedError, isLlmAborted } from "../../src/application/port/llm-provider.js";
import type { CodeFile, CodeGeneration, CodeProposal, DeclineStage, HarnessRun } from "../../src/exercises/code-generate.js";
import { validateHarness } from "../../src/exercises/code-generate.js";
import type { ExerciseFaces, ExerciseProgressSink } from "../../src/exercises/turn-faces.js";
import { forwardToolProgress } from "../../src/exercises/turn-faces.js";
import { completeWithReadTool, toolLoopAuditsOf, withSkillsBrief } from "../../src/source/tool-loop.js";
import { addUsage } from "../../src/adapter/outbound/llm/usage.js";
import { assertSafePath } from "../../src/adapter/outbound/sandbox/runner.js";
import { SandboxUnavailableError } from "../../src/adapter/outbound/sandbox/isolation.js";
import type { SkillReadRecord } from "../../src/source/tools/types.js";
import type { FileReadRecord } from "../../src/source/read-file.js";

const MAX_TITLE = 40;
const MAX_PROMPT = 1_600;
const MAX_FILE_BYTES = 24_000;
const MAX_FILES_PER_SLOT = 3;
const PROMPT_SECTIONS = ["## 问题描述", "## 示例", "## 注意事项"] as const;

export const LANGUAGES = ["typescript", "python", "java", "go"] as const;

/** 三段各自的 schema：模型输出先过这里，再进入组装。 */
const fileSchema = z.object({ path: z.string().min(1), contents: z.string().min(1) });

export const planSchema = z.object({
  ok: z.literal(true),
  language: z.enum(LANGUAGES),
  title: z.string().trim().min(1).max(MAX_TITLE * 4),
  prompt: z.string().trim().min(1).max(MAX_PROMPT * 4),
  defect: z.string().trim().min(1).max(400),
  anchors: z.array(z.object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    why: z.string().max(60).optional()
  })).max(3).optional()
});

export const implSchema = z.object({
  given: z.array(fileSchema).min(1).max(MAX_FILES_PER_SLOT),
  solution: z.array(fileSchema).min(1).max(MAX_FILES_PER_SLOT),
  stubs: z.array(fileSchema).max(MAX_FILES_PER_SLOT).optional()
});

export const testsSchema = z.object({
  hidden: z.array(fileSchema).min(1).max(2),
  entry: z.string().min(1)
});

export type StagePlan = z.infer<typeof planSchema>;
export type StageImpl = z.infer<typeof implSchema>;
export type StageTests = z.infer<typeof testsSchema>;

/** 与产品 parseJsonObject 同款：剥围栏、取首尾大括号。 */
export function parseStageJson(text: string): unknown {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(jsonText.slice(start, end + 1)) as unknown; } catch { return undefined; }
}

/** 题面三节完整是质量护栏之一；单测守这条。 */
export function promptSectionsComplete(prompt: string): boolean {
  return PROMPT_SECTIONS.every((section) => prompt.includes(section));
}

export interface TestSkeleton {
  filename: string;
  entry: string;
  /** 给模型看的完整骨架，`<ASSERTIONS>` 是唯一允许替换的位置。 */
  template: string;
  /** 引擎校验用的关键行，缺一条就判形状失败。 */
  markers: string[];
  /** 断言调用的写法示例，按语言给。 */
  assertionHint: string;
}

/** 测试骨架由引擎定死：计数、TESTS 结论行、退出码都不交给模型。 */
export function testSkeleton(language: ExerciseLanguage): TestSkeleton {
  switch (language) {
    case "typescript": return {
      filename: "tests.ts", entry: "tests.ts",
      template: [
        "// <IMPORTS>",
        "let pass = 0;",
        "let fail = 0;",
        "function check(name: string, fn: () => boolean): void {",
        "  try { if (fn()) { pass += 1; } else { fail += 1; console.error(`FAIL ${name}`); } }",
        "  catch (error) { fail += 1; console.error(`FAIL ${name}: ${String(error)}`); }",
        "}",
        "<ASSERTIONS>",
        "console.log(`TESTS ${pass} ${fail}`);",
        "if (fail > 0) process.exitCode = 1;"
      ].join("\n"),
      markers: ["let pass = 0;", "console.log(`TESTS ${pass} ${fail}`);", "process.exitCode = 1"],
      assertionHint: '每条写 `check("断言名", () => <布尔表达式>);`，例如 `check("空输入返回 0", () => fn(0) === 0);`'
    };
    case "python": return {
      filename: "tests.py", entry: "tests.py",
      template: [
        "# <IMPORTS>",
        "import sys",
        "pass_count = 0",
        "fail_count = 0",
        "def check(name, fn):",
        "    global pass_count, fail_count",
        "    try:",
        "        if fn():",
        "            pass_count += 1",
        "        else:",
        "            fail_count += 1",
        '            print(f"FAIL {name}", file=sys.stderr)',
        "    except Exception as exc:",
        "        fail_count += 1",
        '        print(f"FAIL {name}: {exc}", file=sys.stderr)',
        "<ASSERTIONS>",
        'print(f"TESTS {pass_count} {fail_count}")',
        "if fail_count > 0: sys.exit(1)"
      ].join("\n"),
      markers: ["pass_count = 0", 'print(f"TESTS {pass_count} {fail_count}")', "sys.exit(1)"],
      assertionHint: '每条写 `check("断言名", lambda: <布尔表达式>)`，例如 `check("空输入返回 0", lambda: fn(0) == 0)`'
    };
    case "java": return {
      filename: "Tests.java", entry: "Tests",
      template: [
        "public class Tests {",
        "    static int pass = 0;",
        "    static int fail = 0;",
        "    interface Check { boolean run() throws Exception; }",
        "    static void check(String name, Check c) {",
        '        try { if (c.run()) pass += 1; else { fail += 1; System.err.println("FAIL " + name); } }',
        '        catch (Exception e) { fail += 1; System.err.println("FAIL " + name + ": " + e); }',
        "    }",
        "    public static void main(String[] args) {",
        "        <ASSERTIONS>",
        '        System.out.println("TESTS " + pass + " " + fail);',
        "        if (fail > 0) System.exit(1);",
        "    }",
        "}"
      ].join("\n"),
      markers: ["static int pass = 0;", 'System.out.println("TESTS " + pass + " " + fail);', "System.exit(1)"],
      assertionHint: '每条写 `check("断言名", () -> <布尔表达式>);`，例如 `check("空输入返回 0", () -> Target.fn(0) == 0);`'
    };
    case "go": return {
      filename: "tests.go", entry: "tests.go",
      template: [
        "package main",
        'import ("fmt"; "os")',
        "var pass int",
        "var fail int",
        "func check(name string, ok bool) {",
        '    if ok { pass++ } else { fail++; fmt.Fprintf(os.Stderr, "FAIL %s\\n", name) }',
        "}",
        "func main() {",
        "    <ASSERTIONS>",
        '    fmt.Printf("TESTS %d %d\\n", pass, fail)',
        "    if fail > 0 { os.Exit(1) }",
        "}"
      ].join("\n"),
      markers: ["var pass int", 'fmt.Printf("TESTS %d %d\\n", pass, fail)', "os.Exit(1)"],
      assertionHint: '每条写 `check("断言名", <布尔表达式>)`，例如 `check("空输入返回 0", fn(0) == 0)`'
    };
  }
}

/** 骨架校验：关键行齐 + `check(` 至少两条 + 占位符已被替换。 */
export function skeletonSatisfied(contents: string, language: ExerciseLanguage, minAssertions = 2): boolean {
  const skeleton = testSkeleton(language);
  if (!skeleton.markers.every((marker) => contents.includes(marker))) return false;
  if (contents.includes("<ASSERTIONS>")) return false;
  return (contents.match(/\bcheck\s*\(/g) ?? []).length >= minAssertions + 1; // 含骨架里那次定义
}

/** 单组文件形状：路径按语言校验、非空、不超长。 */
export function shapeStageFiles(files: CodeFile[], language: ExerciseLanguage): string | undefined {
  if (!files.length || files.length > MAX_FILES_PER_SLOT) return "文件数不在 1..3";
  for (const file of files) {
    try { assertSafePath(file.path, language); } catch (error) { return error instanceof Error ? error.message : "非法文件名"; }
    if (!file.contents.trim() || file.contents.length > MAX_FILE_BYTES) return `${file.path} 内容为空或超过 ${MAX_FILE_BYTES} 字节`;
  }
  return undefined;
}

const pathKey = (files: CodeFile[]): string => files.map((file) => file.path).sort().join(",");

/** 三段结果组装成产品同款 CodeProposal；这里就是「结构化校验」的最后一关。 */
export function assembleProposal(plan: StagePlan, impl: StageImpl, tests: StageTests, kind: "patch_edit" | "author_function"): { proposal?: CodeProposal; issue?: string } {
  const language = plan.language;
  if (!promptSectionsComplete(plan.prompt)) return { issue: `题面缺三节之一（${PROMPT_SECTIONS.join(" / ")}）` };
  const givenIssue = shapeStageFiles(impl.given, language);
  if (givenIssue) return { issue: `given：${givenIssue}` };
  const solutionIssue = shapeStageFiles(impl.solution, language);
  if (solutionIssue) return { issue: `solution：${solutionIssue}` };
  const stubs = impl.stubs ?? [];
  const stubsIssue = stubs.length ? shapeStageFiles(stubs, language) : undefined;
  if (stubsIssue) return { issue: `stubs：${stubsIssue}` };
  if (pathKey(impl.given) !== pathKey(impl.solution)) return { issue: "given 与 solution 的文件集合必须完全一致" };

  const hidden = [...tests.hidden, ...stubs];
  const hiddenIssue = shapeStageFiles(hidden, language);
  if (hiddenIssue) return { issue: `hidden：${hiddenIssue}` };
  const skeleton = testSkeleton(language);
  const testFile = tests.hidden.find((file) => file.path === skeleton.filename || file.path.replace(/\.(ts|py|java|go)$/, "") === tests.entry);
  if (!testFile) return { issue: `测试文件必须是 ${skeleton.filename}，entry 必须是 ${skeleton.entry}` };
  if (!skeletonSatisfied(testFile.contents, language)) return { issue: "测试文件没有原样使用引擎骨架，或断言少于 2 条" };
  if (hidden.some((file) => impl.given.some((slot) => slot.path === file.path))) return { issue: "hidden 与 given 有同名文件" };
  if (tests.entry !== skeleton.entry) return { issue: `entry 必须是 ${skeleton.entry}` };

  const anchors = (plan.anchors ?? []).flatMap((anchor) => [{
    path: anchor.path,
    line: anchor.line,
    ...(anchor.endLine && anchor.endLine > anchor.line ? { endLine: anchor.endLine } : {}),
    ...(anchor.why ? { why: anchor.why } : {})
  }]).slice(0, 3);
  return {
    proposal: {
      kind,
      title: plan.title.slice(0, MAX_TITLE),
      prompt: plan.prompt.slice(0, MAX_PROMPT),
      language,
      given: impl.given,
      solution: impl.solution,
      hidden,
      entry: skeleton.entry,
      defect: plan.defect.slice(0, 200),
      ...(anchors.length ? { anchors } : {})
    }
  };
}

/**
  定向修复的目标。判据来自产品 validateHarness 的失败形状：
  - 没跑出 TESTS 结论 / 一条都没过 / 下发件全过 → 测试文件自身有问题或没打到缺陷，重出 tests；
  - 有部分通过、部分失败 → 参考解与断言对不上，重出 impl。
  题面段永不重出。注意：无论定位到哪一段，修复回合都会带上 harness 输出、
  当前测试文件与当前实现（见 attemptImpl/attemptTests），避免「只修一边却看不到另一边」。
*/
export function repairTargetFor(reason: string, runs: HarnessRun[]): "impl" | "tests" {
  if (/没有测试结论|一条测试都没过|不改也能全过/.test(reason)) return "tests";
  const solution = runs.find((run) => run.label === "solution");
  if (!solution?.verdict || solution.verdict.passed < 1) return "tests";
  return "impl";
}

interface StageAttempt<T> {
  value?: T;
  issue?: string;
  usage?: LlmUsage;
  skillReads: SkillReadRecord[];
  fileReads: FileReadRecord[];
  /** 原始模型文本，定向修复时回带给该段。 */
  raw: string;
}

interface StageContext {
  provider: LlmProvider;
  faces?: ExerciseFaces;
  onProgress?: ExerciseProgressSink;
  /** 累计用量，三段与修复回合都并进来。 */
  usage?: LlmUsage;
  skillReads: SkillReadRecord[];
  fileReads: FileReadRecord[];
  runs: HarnessRun[];
}

function account(ctx: StageContext, attempt: StageAttempt<unknown>): void {
  ctx.usage = addUsage(ctx.usage, attempt.usage);
  ctx.skillReads.push(...attempt.skillReads);
  ctx.fileReads.push(...attempt.fileReads);
}

function testsPrompt(plan: StagePlan, skeleton: TestSkeleton): string {
  return [
    "你是代码练习的出题人。题面、实现都已定；这一趟**只交测试文件**。",
    "",
    `语言：${plan.language}。缺陷（仅留档，不要写进题面）：${plan.defect}`,
    "",
    "引擎已经定好测试骨架，**原样保留**，只做两件事：",
    "1. 把 `<IMPORTS>` 那行注释换成真正需要的 import（不需要就删掉该行）；跨文件引用按该语言规则写。",
    `2. 把 \`<ASSERTIONS>\` 换成**至少 2 条**断言调用。${skeleton.assertionHint}`,
    "",
    "- 断言打在行为上（给定输入 → 期望输出/副作用），至少一条必须能区分「参考解」与「带缺陷的下发件」。",
    "- 不许删、跳过或放宽骨架里的计数与 `TESTS` 结论行；不许自己另写 main / 计数 / exit。",
    "- 若输入带 `repair`：依据 `harness` 输出、当前 `tests` 与 `given`（带缺陷的下发件）修正断言，保证至少一条能区分两者。",
    `- 测试文件名必须是 \`${skeleton.filename}\`，entry 是 \`${skeleton.entry}\`。`,
    `严格输出 JSON（不要任何其他文字）：{"hidden":[{"path":"${skeleton.filename}","contents":"<完整测试文件，含骨架>"}],"entry":"${skeleton.entry}"}`,
    "",
    "骨架如下（照抄，只替换两个占位）：",
    "```",
    skeleton.template,
    "```"
  ].join("\n");
}

type PlanLoopResult = { text: string; usage?: LlmUsage; skillReads: SkillReadRecord[]; fileReads: FileReadRecord[] };

/** 段 1 走与对照臂同一条工具循环（同素材、同技能面），只是输出短。 */
async function completeStage(system: string, user: string, input: DesignGenerationInput): Promise<{ text: string; usage?: LlmUsage }> {
  const completion = await input.provider.complete({ system, user, temperature: 0.4, scene: "practice.generate-code", ...(input.faces?.signal ? { signal: input.faces.signal } : {}) });
  return { text: completion.text, usage: completion.usage };
}

/** 定向修复上下文：无论重出哪一段，都把两边的产物与沙箱输出一起带给模型。 */
export interface RepairContext {
  raw: string;
  issue: string;
  harness?: string;
  tests?: CodeFile[];
  given?: CodeFile[];
  solution?: CodeFile[];
}

const briefFiles = (files: CodeFile[]): { path: string; contents: string }[] =>
  files.map((file) => ({ path: file.path, contents: file.contents.slice(0, 8_000) }));

async function attemptTests(input: DesignGenerationInput, plan: StagePlan, impl: StageImpl, repair?: RepairContext): Promise<StageAttempt<StageTests>> {
  const skeleton = testSkeleton(plan.language);
  const user = JSON.stringify({
    plan: { title: plan.title, prompt: plan.prompt, defect: plan.defect, language: plan.language },
    implementation: briefFiles(impl.solution),
    ...(repair ? { repair: {
      previous: repair.raw.slice(0, 12_000),
      issue: repair.issue,
      ...(repair.harness ? { harness: repair.harness } : {}),
      ...(repair.tests ? { tests: briefFiles(repair.tests) } : {}),
      ...(repair.given ? { given: briefFiles(repair.given) } : {})
    } } : {})
  });
  const { text, usage } = await completeStage(testsPrompt(plan, skeleton), user, input);
  const attempt: StageAttempt<StageTests> = { raw: text, usage, skillReads: [], fileReads: [] };
  const parsed = parseStageJson(text);
  const checked = testsSchema.safeParse(parsed);
  if (!checked.success) { attempt.issue = `测试段 schema 不合法：${checked.error.issues.map((issue) => issue.message).join("; ").slice(0, 240)}`; return attempt; }
  const testFile = checked.data.hidden.find((file) => file.path === skeleton.filename);
  if (!testFile || checked.data.entry !== skeleton.entry) { attempt.issue = `测试文件名/入口必须是 ${skeleton.filename} / ${skeleton.entry}`; return attempt; }
  if (!skeletonSatisfied(testFile.contents, plan.language)) { attempt.issue = "测试没有原样使用引擎骨架，或断言少于 2 条"; return attempt; }
  attempt.value = checked.data;
  return attempt;
}

export interface DesignGenerationInput {
  repositoryPath: string;
  tag: string;
  kind: "patch_edit" | "author_function";
  reference: string;
  provider: LlmProvider;
  faces?: ExerciseFaces;
  onProgress?: ExerciseProgressSink;
  /** [DEV ONLY] 离线自检注入点：绕开工具循环与真沙箱，不用于实验执行。 */
  hooks?: {
    /** 首段（题面 + 实现）的离线注入点。 */
    firstLoop?: (user: string) => Promise<PlanLoopResult>;
    validate?: (proposal: CodeProposal, repositoryPath: string) => Promise<{ ok: boolean; reason?: string; runs: HarnessRun[] }>;
  };
}

/** 每段各自最多一次定向重发；harness 失败再按 runs 定位到一段重发一次。 */
const MAX_STAGE_RETRIES = 1;
const MAX_HARNESS_REPAIRS = 1;

export const stageOneSchema = planSchema.extend({
  given: z.array(fileSchema).min(1).max(MAX_FILES_PER_SLOT),
  solution: z.array(fileSchema).min(1).max(MAX_FILES_PER_SLOT),
  stubs: z.array(fileSchema).max(MAX_FILES_PER_SLOT).optional()
});
export type StageOne = z.infer<typeof stageOneSchema>;

function twoStageFirstPrompt(kind: "patch_edit" | "author_function"): string {
  return [
    `你是代码练习的出题人。这一趟一次交出「题面 + 实现」；测试文件由下一趟单独生成，这里不要写。围绕主题出一道自足的代码题——${kind === "patch_edit" ? "一段带真实缺陷的实现，学习者改到测试全过" : "给签名与示例，学习者从零写出实现"}。`,
    "",
    "仓库代码只作参考：可以从候选摘录里取材，但题目必须自足——给定件与测试不 import 仓库文件、不依赖仓库运行。",
    "- 动笔前先确认本仓库有没有可参考的落脚：读一下本主题的技能文件，再用 2–4 个英文/代码关键词调用 `search_code`，命中的文件用 `read_file` 看一眼。",
    "",
    "题面用 Markdown 按这三节写：`## 问题描述`、`## 示例`、`## 注意事项`。示例写 1–2 个「调用 → 期望返回」；注意事项只写可核对的约束；不要写「相关文件」小节，不要点出缺陷所在那一行，不要出现测试断言原文。",
    kind === "patch_edit"
      ? "- 缺陷必须是行为级的真实错误（边界、比较符、单位、分支漏一条），一处即可；禁止语法错误、拼错标识符、删函数。"
      : "- `given` 只留签名与 TODO，`solution` 是完整实现；题面给足输入输出形状与至少两个示例。",
    "",
    "实现约束：",
    "- 语言只能从 typescript / python / java / go 里选，只用标准库；文件路径必须用该语言扩展名。",
    "- `given` 与 `solution` 的 path 集合必须完全一致，两份内容只在缺陷那一处行为上不同；需要辅助件放进 `stubs`。",
    "- typescript 跨文件 import 必须写 `.ts`；java 文件不带 package、public 类名与文件名同名、实现里不写 main；go 所有文件同属 `package main` 且实现文件不定义 func main。",
    `- 每档至多 ${MAX_FILES_PER_SLOT} 个文件，单文件 ≤ ${MAX_FILE_BYTES} 字节。`,
    "- 若输入带 `repair`：依据 `harness` 输出与 `tests` 修正实现，只改必要处；不要改测试、不要删断言。",
    "",
    "严格输出 JSON（不要任何其他文字）：",
    `{"ok":true,"language":"${LANGUAGES.join("|")}","title":"≤${MAX_TITLE}字","prompt":"≤800字题面","defect":"<缺陷一句话>",`,
    '"given":[{"path":"target.ts","contents":"<整份源码>"}],"solution":[{"path":"target.ts","contents":"<整份源码>"}],',
    '"stubs":[{"path":"stub.ts","contents":"<可无>"}],"anchors":[{"path":"<取材文件路径>","line":起始行,"why":"<≤30字>"}]}',
    "或拒绝：{\"ok\":false,\"reason\":\"<为什么出不了代码题>\"}",
    "`anchors` 最多 3 条，只填真正取材过的；一处都没参考就填空数组。"
  ].join("\n");
}

async function twoStageFirstLoop(input: DesignGenerationInput, user: string): Promise<PlanLoopResult> {
  const faces = input.faces ?? {};
  const loop = await completeWithReadTool({
    ...faces,
    provider: input.provider,
    scope: faces.scope ?? "practice",
    system: withSkillsBrief(twoStageFirstPrompt(input.kind), faces.skills),
    user,
    temperature: 0.4,
    onProgress: forwardToolProgress(input.onProgress),
    scene: "practice.generate-code"
  });
  return { text: loop.completion.text, usage: loop.usage, skillReads: loop.skillReads, fileReads: loop.fileReads };
}

async function attemptFirst(input: DesignGenerationInput, repair?: RepairContext): Promise<StageAttempt<StageOne>> {
  const user = JSON.stringify({
    kind: input.kind, theme: input.tag, reference: input.reference,
    ...(repair ? { repair: {
      previous: repair.raw.slice(0, 20_000),
      issue: repair.issue,
      ...(repair.harness ? { harness: repair.harness } : {}),
      ...(repair.tests ? { tests: briefFiles(repair.tests) } : {}),
      ...(repair.solution ? { solution: briefFiles(repair.solution) } : {})
    } } : {})
  });
  const loop = input.hooks?.firstLoop ? await input.hooks.firstLoop(user) : await twoStageFirstLoop(input, user);
  const attempt: StageAttempt<StageOne> = { raw: loop.text, usage: loop.usage, skillReads: loop.skillReads, fileReads: loop.fileReads };
  const parsed = parseStageJson(loop.text);
  if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok === false) {
    attempt.issue = `首段返回了拒绝或不可解析的 JSON：${String((parsed as { reason?: unknown } | undefined)?.reason ?? loop.text.slice(0, 120))}`;
    return attempt;
  }
  const checked = stageOneSchema.safeParse(parsed);
  if (!checked.success) { attempt.issue = `首段 schema 不合法：${checked.error.issues.map((issue) => issue.message).join("; ").slice(0, 240)}`; return attempt; }
  const data = checked.data;
  if (!promptSectionsComplete(data.prompt)) { attempt.issue = "题面缺三节之一"; return attempt; }
  const issue = shapeStageFiles(data.given, data.language) ?? shapeStageFiles(data.solution, data.language)
    ?? (data.stubs?.length ? shapeStageFiles(data.stubs, data.language) : undefined)
    ?? (pathKey(data.given) !== pathKey(data.solution) ? "given 与 solution 文件集合不一致" : undefined);
  if (issue) { attempt.issue = `首段形状不合法：${issue}`; return attempt; }
  attempt.value = data;
  return attempt;
}

function splitFirst(data: StageOne): { plan: StagePlan; impl: StageImpl } {
  return {
    plan: {
      ok: true, language: data.language, title: data.title, prompt: data.prompt, defect: data.defect,
      ...(data.anchors ? { anchors: data.anchors } : {})
    },
    impl: { given: data.given, solution: data.solution, ...(data.stubs ? { stubs: data.stubs } : {}) }
  };
}

/** 两段编排：首段（题面+实现）→ 测试段 → 两跑自证 → 定向修复（impl 定位回段 1）。 */
export async function generateTwoStage(input: DesignGenerationInput): Promise<CodeGeneration> {
  const ctx: StageContext = { provider: input.provider, faces: input.faces, onProgress: input.onProgress, skillReads: [], fileReads: [], runs: [] };
  const fail = (stage: DeclineStage, reason: string): CodeGeneration => ({
    ok: false, stage, reason, runs: ctx.runs,
    ...(ctx.usage ? { usage: ctx.usage } : {}),
    skillReads: ctx.skillReads, fileReads: ctx.fileReads
  });

  try {
    input.onProgress?.({ stage: "proposing", detail: "题面+实现" });
    let first = await attemptFirst(input);
    account(ctx, first);
    for (let i = 0; !first.value && i < MAX_STAGE_RETRIES; i += 1) {
      first = await attemptFirst(input, { raw: first.raw, issue: first.issue ?? "首段不合法" });
      account(ctx, first);
    }
    if (!first.value) return fail("proposal_shape", `首段失败：${first.issue ?? "未知"}`);
    let { plan, impl } = splitFirst(first.value);

    input.onProgress?.({ stage: "proposing", detail: "测试" });
    let tests = await attemptTests(input, plan, impl);
    account(ctx, tests);
    for (let i = 0; !tests.value && i < MAX_STAGE_RETRIES; i += 1) {
      tests = await attemptTests(input, plan, impl, { raw: tests.raw, issue: tests.issue ?? "测试段不合法" });
      account(ctx, tests);
    }
    if (!tests.value) return fail("proposal_shape", `测试段失败：${tests.issue ?? "未知"}`);
    let testValue = tests.value;

    for (let round = 0; round <= MAX_HARNESS_REPAIRS; round += 1) {
      const assembled = assembleProposal(plan, impl, testValue, input.kind);
      if (!assembled.proposal) return fail("proposal_shape", `组装失败：${assembled.issue ?? "未知"}`);
      if (input.faces?.signal?.aborted) throw new LlmAbortedError();
      input.onProgress?.({ stage: "validating" });
      const validation = input.hooks?.validate
        ? await input.hooks.validate(assembled.proposal, input.repositoryPath)
        : await validateHarness(assembled.proposal, input.repositoryPath);
      ctx.runs.push(...validation.runs);
      if (validation.ok) {
        return {
          ok: true, proposal: assembled.proposal, runs: ctx.runs,
          ...(ctx.usage ? { usage: ctx.usage } : {}),
          skillReads: ctx.skillReads, fileReads: ctx.fileReads
        };
      }
      if (round === MAX_HARNESS_REPAIRS) return fail("harness_validation", `${validation.reason ?? "自证未通过"}（定向修复 ${round} 次后仍未通过）`);

      const reason = validation.reason ?? "自证未通过";
      const target = repairTargetFor(reason, validation.runs);
      const harness = validation.runs.map((run) => `${run.label}: ${run.output ?? "(无输出)"}`).join("\n").slice(-4_000);
      const shared: Omit<RepairContext, "raw"> = {
        issue: `沙箱自证失败：${reason}`, harness,
        tests: testValue.hidden, given: impl.given, solution: impl.solution
      };
      input.onProgress?.({ stage: "repairing", detail: target });
      if (target === "impl") {
        const repaired = await attemptFirst(input, { ...shared, raw: JSON.stringify(first.value).slice(0, 20_000) });
        account(ctx, repaired);
        if (repaired.value) { const next = splitFirst(repaired.value); plan = next.plan; impl = next.impl; }
      } else {
        const repaired = await attemptTests(input, plan, impl, { ...shared, raw: JSON.stringify(testValue).slice(0, 12_000) });
        account(ctx, repaired);
        if (repaired.value) testValue = repaired.value;
      }
    }
    return fail("harness_validation", "自证未通过。");
  } catch (error) {
    if (isLlmAborted(error, input.faces?.signal)) throw error;
    const audits = toolLoopAuditsOf(error);
    ctx.skillReads.push(...(audits?.skillReads ?? []));
    if (error instanceof SandboxUnavailableError) return fail("sandbox_unavailable", error.message);
    return {
      ok: false, stage: "provider_error", reason: `出题时模型调用失败：${error instanceof Error ? error.message : String(error)}`,
      runs: ctx.runs, ...(ctx.usage ? { usage: ctx.usage } : {}),
      skillReads: ctx.skillReads, fileReads: ctx.fileReads
    };
  }
}
