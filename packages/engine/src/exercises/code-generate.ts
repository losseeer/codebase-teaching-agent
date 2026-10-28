/**
  代码题出题与自证链：可执行内容全部由模型交出，沙箱不看仓库，题值不值得出由真跑证明。
  自证两跑：solution 必须全过，given 必须至少挂一条测试。
  测试结论只认一行 `TESTS <通过数> <失败数>`，不认异常。
*/
import type { ExerciseLanguage, ImplementationUnit } from "@codebase-tutor/domain";

import { defineAnalysisStep } from "../analysis-step.js";
import type { LlmProvider, LlmUsage } from "../application/port/llm-provider.js";
import { completeWithOptionalSkills, toolLoopAuditsOf, type SkillReadAudit, type SkillsToolContext } from "../source/tool-loop.js";
import { EXERCISE_STEP } from "./llm-generate.js";
import { readFileLines, symbolBodyLines } from "@codebase-tutor/platform";
import { recordEgress } from "../adapter/outbound/security/egress-log.js";
import { maskSecrets, secretMasker } from "@codebase-tutor/domain";
import { runSandbox, SandboxUnavailableError } from "../adapter/outbound/sandbox/isolation.js";
import { assertSafePath, type SandboxFile, type SandboxRun } from "../adapter/outbound/sandbox/runner.js";

export interface CodeFile {
  path: string;
  contents: string;
}

export interface CodeProposal {
  kind: "patch_edit" | "author_function";
  title: string;
  prompt: string;
  language: ExerciseLanguage;
  /** 下发给学习者编辑的那一组文件。 */
  given: CodeFile[];
  /** 应该全过的那一组文件。 */
  solution: CodeFile[];
  /** 测试与替身：判分用，不下发 */
  hidden: CodeFile[];
  entry: string;
  /** 缺陷一句话说明；引擎留档，不出现在题面。 */
  defect: string;
}

/** 拒题的四档，按断在哪一段分；修复方向不同的失败必须可分辨。 */
export type DeclineStage = "provider_error" | "proposal_shape" | "sandbox_unavailable" | "harness_validation";

export interface HarnessRun {
  label: "solution" | "given";
  verdict?: { passed: number; failed: number };
  exitCode: number | null;
  timedOut: boolean;
  /** 沙箱本身跑完了（编译成功、没超时）。 */
  ran: boolean;
}

export type CodeGeneration =
  | { ok: false; stage: DeclineStage; reason: string; runs: HarnessRun[]; skillReads: SkillReadAudit[] }
  | { ok: true; proposal: CodeProposal; runs: HarnessRun[]; usage?: LlmUsage; skillReads: SkillReadAudit[] };

const MAX_TITLE = 40;
const MAX_PROMPT = 700;
const MAX_FILE_BYTES = 24_000;
const MAX_FILES_PER_SLOT = 3;

/** 三语言各自的测试报结论格式，由引擎定死。 */
const TEST_CONTRACT: Record<ExerciseLanguage, string> = {
  typescript: "测试文件（例如 `tests.ts`，入口就是它）自己依次调用各条断言，每条**通过就 pass+1、抛异常就 fail+1 并把原因打到 stderr**；结尾必须打印一行 `TESTS <pass> <fail>`，且 fail>0 时设 `process.exitCode = 1`。跨文件 import **必须写真实扩展名 `.ts`**（沙箱里的 node 不做 `.js`→`.ts` 的重写）。",
  python: '测试文件（例如 `tests.py`，入口就是它）自己依次跑各条断言，每条**用 try/except 包住：过了 pass+1，抛了 fail+1**；结尾 `print(f"TESTS {pass} {fail}")`，fail>0 时 `sys.exit(1)`。只用标准库。',
  java: '入口是一个带 `public static void main` 的类（例如 `Tests`，文件名必须与类名同名且不带包目录）。每条断言用 try/catch 包住计数，结尾 `System.out.println("TESTS " + pass + " " + fail);` 并在 fail>0 时 `System.exit(1)`。只用 JDK。'
};

function systemPrompt(kind: "patch_edit" | "author_function", language: ExerciseLanguage): string {
  return [
    `你是代码练习的出题人。要出一道**学习者真在编辑器里写代码、由沙箱真跑测试判分**的题：${kind === "patch_edit" ? "给一段有真实缺陷的实现，让他改到测试全过" : "给签名与示例，让他从零写出实现"}。`,
    "",
    "铁律：",
    "- 沙箱里**没有任何第三方依赖**：只用该语言标准库；被测代码需要的仓内符号，由你写成最小替身（stub）放进 `hidden`。",
    "- 判分只由测试是否全过决定，所以测试必须**逐条断言、逐条计数**，最后印一行结论。",
    `- 本语言的测试形状：${TEST_CONTRACT[language]}`,
    "- 测试要打在行为上（给定输入 → 期望输出/副作用），不要打在实现细节上（不要断言源码文本、不要断言调用次数这类脆弱项）。",
    kind === "patch_edit"
      ? "- 缺陷必须是**行为级**的真实错误（边界、比较符、单位、分支漏一条），一处即可；禁止用语法错误、拼错的标识符、删掉整个函数来「制造缺陷」——那会让学习者在改编译器而不是改逻辑。"
      : "- 骨架里只留签名与 `TODO`，不留任何可用实现；题面要给足输入输出形状与至少两个示例。",
    "- 题面不得出现测试断言的原文，也不得点出缺陷所在的那一行。",
    "",
    "严格输出 JSON（不要任何其他文字）：",
    `{"ok":true,"language":"${language}","title":"≤${MAX_TITLE}字","prompt":"≤${MAX_PROMPT}字题面","defect":"<缺陷/要求的一句话说明，仅留档>",`,
    `"given":[{"path":"target.ts","contents":"<下发给学习者的整份文件源码>"}],`,
    `"solution":[{"path":"target.ts","contents":"<应当全过的那一份>"}],`,
    `"hidden":[{"path":"tests.ts","contents":"<测试>"},{"path":"stub.ts","contents":"<替身，可无>"}],"entry":"tests.ts"}`,
    "或拒绝：{\"ok\":false,\"reason\":\"<面向学习者的一句话：这个单元为什么出不了代码题>\"}",
    "",
    "约束：`given` 与 `solution` 的 **path 集合必须完全一致**；`hidden` 不得与它们同名；`entry` 必须是 `hidden` 里那个测试文件（java 填类名，不带 .java）。每档至多 " + MAX_FILES_PER_SLOT + " 个文件，单文件 ≤ " + MAX_FILE_BYTES + " 字节。"
  ].join("\n");
}

/** 代码题这一步的口径登记；版本号与 llm 出题那一步共用同一个。 */
defineAnalysisStep({
  layer: "exercise-code-generate",
  contractVersion: EXERCISE_STEP.contractVersion,
  prompts: [() => (["patch_edit", "author_function"] as const).flatMap((kind) => (Object.keys(TEST_CONTRACT) as ExerciseLanguage[]).map((language) => systemPrompt(kind, language))).join("\n")]
});

/** 出题侧读源码：文件头 import 段 + 符号体，两边都过密钥筛并登记出网。 */
export function unitSource(repositoryPath: string, unit: ImplementationUnit): { imports: string; body: string; sources: { path: string; from: number; to: number; text: string; masked: number }[] } | undefined {
  const lines = readFileLines(repositoryPath, unit.symbol.path);
  if (!lines) return undefined;
  const importLines: string[] = [];
  const maskerForImports = secretMasker();
  lines.forEach((line, index) => {
    if (index + 1 >= unit.symbol.line) return;
    if (/^\s*(?:import\s|from\s|use\s|using\s|#include|package\s|require\s)/.test(line)) importLines.push(maskerForImports.take(line));
  });
  const maskerForBody = secretMasker();
  const body = symbolBodyLines(lines, unit.symbol).map((line) => maskerForBody.take(line)).join("\n");
  if (!body.trim()) return undefined;
  return {
    imports: importLines.join("\n"),
    body,
    sources: [
      ...(importLines.length ? [{ path: unit.symbol.path, from: 1, to: Math.min(unit.symbol.line - 1, lines.length), text: importLines.join("\n"), masked: maskerForImports.masked }] : []),
      { path: unit.symbol.path, from: unit.symbol.line, to: unit.symbol.endLine, text: body, masked: maskerForBody.masked }
    ]
  };
}

function shapeFiles(files: unknown, language: ExerciseLanguage): CodeFile[] | undefined {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES_PER_SLOT) return undefined;
  const out: CodeFile[] = [];
  for (const item of files) {
    const record = (item ?? {}) as Record<string, unknown>;
    const path = String(record.path ?? "").trim();
    const contents = typeof record.contents === "string" ? record.contents : "";
    try { out.push({ path: assertSafePath(path, language), contents }); } catch { return undefined; }
    if (!contents.trim() || contents.length > MAX_FILE_BYTES) return undefined;
  }
  return out;
}

function samePathSet(left: CodeFile[], right: CodeFile[]): boolean {
  const key = (files: CodeFile[]): string => files.map((file) => file.path).sort().join(",");
  return key(left) === key(right);
}

function normalizeProposal(parsed: Record<string, unknown>): { proposal?: CodeProposal; issue?: string } {
  const language = String(parsed.language ?? "").trim() as ExerciseLanguage;
  if (!["typescript", "python", "java"].includes(language)) return { issue: `语言不在沙箱支持范围内：${language || "（空）"}` };
  const kind = String(parsed.kind ?? "").trim();
  if (kind !== "patch_edit" && kind !== "author_function") return { issue: `题型字段不对：${kind || "（空）"}` };
  const title = String(parsed.title ?? "").trim().slice(0, MAX_TITLE);
  const prompt = String(parsed.prompt ?? "").trim().slice(0, MAX_PROMPT);
  const defect = String(parsed.defect ?? "").trim().slice(0, 200);
  if (!title || !prompt) return { issue: "题面标题或描述为空" };
  const given = shapeFiles(parsed.given, language);
  const solution = shapeFiles(parsed.solution, language);
  const hidden = shapeFiles(parsed.hidden, language);
  if (!given || !solution || !hidden) return { issue: "given/solution/hidden 三组文件形状不合法（空、超限、或文件名不合该语言形状）" };
  if (!samePathSet(given, solution)) return { issue: "given 与 solution 的文件集合必须完全一致（学习者改的就是这一组）" };
  const entry = String(parsed.entry ?? "").trim();
  if (!hidden.some((file) => file.path === entry || file.path.replace(/\.(ts|py|java)$/, "") === entry)) return { issue: `入口 ${entry || "（空）"} 不在 hidden 的测试文件里` };
  if (hidden.some((file) => given.some((slot) => slot.path === file.path))) return { issue: "hidden 与 given 有同名文件：下发件会被测试盖掉" };
  return { proposal: { kind, title, prompt, language, given, solution, hidden, entry, defect } };
}

/** 只认这一行：`TESTS <通过> <失败>`；没有它 = 测试没跑完。 */
export function verdictOf(run: SandboxRun): { passed: number; failed: number } | undefined {
  const lines = run.stdout.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^TESTS (\d+) (\d+)$/.exec(lines[index].trim());
    if (match) return { passed: Number(match[1]), failed: Number(match[2]) };
  }
  return undefined;
}

function overlay(hidden: CodeFile[], variant: CodeFile[]): SandboxFile[] {
  const byPath = new Map<string, SandboxFile>();
  for (const file of [...hidden, ...variant]) byPath.set(file.path, file);
  return [...byPath.values()];
}

async function harnessRun(proposal: CodeProposal, label: "solution" | "given", repositoryPath: string): Promise<HarnessRun> {
  const variant = label === "solution" ? proposal.solution : proposal.given;
  // 仓的根必须点名拒读：沙箱里的代码读到 `.tutor/tutor.db` 就是读到标准答案。
  const run = await runSandbox({ language: proposal.language, entry: proposal.entry, files: overlay(proposal.hidden, variant), repositoryPath });
  return { label, verdict: verdictOf(run), exitCode: run.steps.at(-1)?.exitCode ?? null, timedOut: run.timedOut, ran: run.ok };
}

/** 两跑自证；沙箱不可用要原样上抛，由调用方记成 `sandbox_unavailable`。 */
export async function validateHarness(proposal: CodeProposal, repositoryPath: string): Promise<{ ok: boolean; reason?: string; runs: HarnessRun[] }> {
  const runs: HarnessRun[] = [];
  const solution = await harnessRun(proposal, "solution", repositoryPath);
  runs.push(solution);
  if (!solution.verdict) return { ok: false, reason: "参考实现那次运行没有测试结论（可能没编译过，或测试文件自己出错）", runs };
  if (solution.verdict.passed < 1) return { ok: false, reason: `参考解一条测试都没过（TESTS ${solution.verdict.passed} ${solution.verdict.failed}）`, runs };
  if (solution.verdict.failed > 0 || solution.exitCode !== 0) return { ok: false, reason: `参考解没过：TESTS ${solution.verdict.passed} ${solution.verdict.failed}`, runs };

  const given = await harnessRun(proposal, "given", repositoryPath);
  runs.push(given);
  if (!given.verdict) return { ok: false, reason: "发出去的代码那次运行没有测试结论，可能连语法都没过；这种题不能出", runs };
  if (given.verdict.failed < 1) return { ok: false, reason: `发出去的代码不改也能全过（${given.verdict.passed} 项通过），这道题没有可练的内容`, runs };
  return { ok: true, runs };
}

/** 引擎侧对 patch_edit 的额外要求：`solution` 必须逐字含仓里那段真实现。 */
function solutionMatchesSource(proposal: CodeProposal, body: string): boolean {
  const needle = body.trim().replace(/\s+/g, " ");
  if (!needle) return false;
  return proposal.solution.some((file) => file.contents.replace(/\s+/g, " ").includes(needle));
}

export async function generateCodeExercise(input: { repositoryPath: string; unit: ImplementationUnit; kind: "patch_edit" | "author_function"; provider: LlmProvider; skills?: SkillsToolContext }): Promise<CodeGeneration> {
  const source = unitSource(input.repositoryPath, input.unit);
  if (!source) return { ok: false, stage: "proposal_shape", reason: "读不出这个单元的源码正文。", runs: [], skillReads: [] };
  const language = input.unit.symbol.language === "typescript" ? "typescript" : input.unit.symbol.language === "python" ? "python" : input.unit.symbol.language === "java" ? "java" : undefined;
  if (!language) return { ok: false, stage: "proposal_shape", reason: `${input.unit.symbol.language} 的代码题还不支持。`, runs: [], skillReads: [] };

  recordEgress({ repositoryPath: input.repositoryPath, scene: "practice.generate-code", sources: source.sources.map((entry) => ({ kind: "exercise-excerpt" as const, ...entry })) });
  let response: { text: string; usage?: LlmUsage; skillReads: SkillReadAudit[] };
  try {
    response = await completeWithOptionalSkills({
      provider: input.provider,
      system: systemPrompt(input.kind, language),
      user: JSON.stringify({
        kind: input.kind,
        language,
        target: { path: input.unit.symbol.path, symbol: input.unit.symbol.name, line: input.unit.symbol.line, parameters: input.unit.symbol.parameters },
        imports: source.imports,
        source: source.body.slice(0, MAX_FILE_BYTES)
      }),
      // 出题要交四份源码，思考 token 也计在这个数里。
      maxTokens: 6_000,
      scene: "practice.generate-code",
      ...(input.skills ? { skills: input.skills } : {})
    });
  } catch (error) {
    // 端点失败单列一档，不与形状档混。
    return { ok: false, stage: "provider_error", reason: `出题时模型调用失败：${(error as Error).message}`, runs: [], skillReads: toolLoopAuditsOf(error)?.skillReads ?? [] };
  }
  const parsed = parseJsonObject(response.text);
  if (!parsed) return { ok: false, stage: "proposal_shape", reason: "出题返回的不是可解析的 JSON。", runs: [], skillReads: response.skillReads };
  if (parsed.ok === false) return { ok: false, stage: "proposal_shape", reason: String(parsed.reason ?? "模型认为这个单元出不了代码题。").trim() || "模型拒绝出题。", runs: [], skillReads: response.skillReads };

  const normalized = normalizeProposal({ ...parsed, kind: input.kind, language });
  if (!normalized.proposal) return { ok: false, stage: "proposal_shape", reason: normalized.issue ?? "出题结果形状不合法。", runs: [], skillReads: response.skillReads };
  const proposal = normalized.proposal;
  if (proposal.language !== language) return { ok: false, stage: "proposal_shape", reason: `模型报的语言（${proposal.language}）与目标单元（${language}）不一致。`, runs: [], skillReads: response.skillReads };
  if (proposal.kind === "patch_edit" && !solutionMatchesSource(proposal, source.body)) {
    return { ok: false, stage: "proposal_shape", reason: "参考实现与仓库里那段代码对不上。", runs: [], skillReads: response.skillReads };
  }

  let validation: { ok: boolean; reason?: string; runs: HarnessRun[] };
  try {
    validation = await validateHarness(proposal, input.repositoryPath);
  } catch (error) {
    if (error instanceof SandboxUnavailableError) return { ok: false, stage: "sandbox_unavailable", reason: error.message, runs: [], skillReads: response.skillReads };
    throw error;
  }
  if (!validation.ok) return { ok: false, stage: "harness_validation", reason: validation.reason ?? "自证未通过。", runs: validation.runs, skillReads: response.skillReads };
  return { ok: true, proposal, runs: validation.runs, usage: response.usage, skillReads: response.skillReads };
}

/**
  按需讲评：判完之后由学习者点一次才发这一趟，先重跑沙箱拿失败原因。
  出网登记用 `sandbox-output`，学习者代码照过密钥筛。
  不返回判分字段：passed / score 归沙箱。
*/
export async function explainCodeAttempt(input: {
  repositoryPath: string;
  title: string;
  prompt: string;
  harness: { language: ExerciseLanguage; entry: string; hidden: CodeFile[]; defect: string };
  learnerFiles: CodeFile[];
  provider: LlmProvider;
}): Promise<{ explanation: string; usage?: LlmUsage; verdict: { passed: number; failed: number } | undefined }> {
  const files = [...input.harness.hidden.map((file) => ({ ...file })), ...input.learnerFiles.map((file) => ({ ...file }))];
  const run = await runSandbox({ language: input.harness.language, entry: input.harness.entry, files, repositoryPath: input.repositoryPath });
  const verdict = verdictOf(run);
  const failing = (run.stderr || "").trim().split("\n").filter(Boolean).slice(0, 12).join("\n").slice(0, 2_000);
  const sources = input.learnerFiles.map((file) => {
    // 逐文件各自计数：一个累加器不能摊到多段上。
    const screened = maskSecrets(file.contents);
    return { kind: "sandbox-output" as const, path: file.path, from: 1, to: screened.text.split("\n").length, text: screened.text, masked: screened.masked };
  });
  recordEgress({ repositoryPath: input.repositoryPath, scene: "practice.explain", sources });
  const system = [
    "你是代码练习的讲评者。学习者刚交了一版代码，沙箱已经跑完并给出结论；你的活儿是把「这次运行说明白」：哪里对了、哪几条断言挂在什么上面、下一步该往哪看。",
    "",
    "- 只依据给定的题面、学习者代码与测试输出说话；不要引入它们之外的代码事实。",
    "- 不得改动判分结论（通过与否、得分都不在你手里），也不要替学习者重写整份实现——点方向，不代写。",
    "- ≤160 字中文，纯文本，不要 Markdown、不要 JSON、不要复述代码原文。"
  ].join("\n");
  const user = JSON.stringify({
    exercise: input.title,
    prompt: input.prompt,
    defectHint: input.harness.defect || undefined,
    learnerCode: sources.map((source) => ({ path: source.path, contents: source.text })),
    verdict: verdict ? `${verdict.passed} 条通过 / ${verdict.failed} 条失败${run.timedOut ? "，且运行超时被终止" : ""}` : "测试没跑完（没印出 TESTS 结论）",
    testOutput: failing || "（无输出）"
  });
  const response = await input.provider.complete({ system, user, maxTokens: 400, temperature: 0.3, scene: "practice.explain" });
  return { explanation: response.text.trim().slice(0, 400), usage: response.usage, verdict };
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
