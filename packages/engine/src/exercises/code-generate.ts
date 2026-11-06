/**
  代码题出题与自证链：可执行内容由模型交出，沙箱不看仓库。
  自证两跑：solution 全过，given 至少一条测试失败。
  测试结论只认一行 `TESTS <通过数> <失败数>`。
*/
import type { ExerciseLanguage, ImplementationUnit } from "@codebase-tutor/domain";

import { defineAnalysisStep } from "../analysis-step.js";
import type { LlmProvider, LlmUsage } from "../application/port/llm-provider.js";
import { LlmAbortedError, isLlmAborted } from "../application/port/llm-provider.js";
import { completeWithReadTool, toolLoopAuditsOf, withSkillsBrief } from "../source/tool-loop.js";
import type { SkillReadRecord } from "../source/tools/types.js";
import { addUsage } from "../adapter/outbound/llm/usage.js";
import type { FileReadRecord } from "../source/read-file.js";
import { forwardToolProgress, type ExerciseFaces, type ExerciseProgressSink } from "./turn-faces.js";
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
  /** 判分用、不下发给学习者的文件。 */
  hidden: CodeFile[];
  entry: string;
  /** 缺陷的一句话说明，不进题面。 */
  defect: string;
  /** 参考模式：出题时主要参考了仓库里的哪几处代码（可空；why 只进 journal）。 */
  anchors?: { path: string; line: number; endLine?: number; why?: string }[];
}

/** 拒题的档位，按失败发生在哪一段分。 */
export type DeclineStage = "provider_error" | "proposal_shape" | "sandbox_unavailable" | "harness_validation";

export interface HarnessRun {
  label: "solution" | "given";
  verdict?: { passed: number; failed: number };
  exitCode: number | null;
  timedOut: boolean;
  /** 沙箱本身跑完了（编译成功、没超时）。 */
  ran: boolean;
  /** 失败时的输出尾部，只给修复回合看，不进界面。 */
  output?: string;
}

export type CodeGeneration =
  | {
      ok: false; stage: DeclineStage; reason: string; runs: HarnessRun[]; usage?: LlmUsage; skillReads: SkillReadRecord[]; fileReads?: FileReadRecord[];
      /** 分段产出已经把题面定好了、只是自证没过时带出来：兜底路径沿用这份题面，不必从头再想一遍。 */
      plan?: { title: string; prompt: string; defect: string };
    }
  | { ok: true; proposal: CodeProposal; runs: HarnessRun[]; usage?: LlmUsage; skillReads: SkillReadRecord[]; fileReads?: FileReadRecord[] };

const MAX_TITLE = 40;
/** 题面长度以提示词里的目标值为准；这里只做超长的硬截断兜底。 */
const PROMPT_TARGET = 800;
const MAX_PROMPT = 1_600;
const MAX_FILE_BYTES = 24_000;
const MAX_FILES_PER_SLOT = 3;

/** 各语言各自的测试报结论格式，由引擎定死。 */
export const TEST_CONTRACT: Record<ExerciseLanguage, string> = {
  typescript: "测试文件（例如 `tests.ts`，入口就是它）自己依次调用各条断言，每条**通过就 pass+1、抛异常就 fail+1 并把原因打到 stderr**；结尾必须打印一行 `TESTS <pass> <fail>`，且 fail>0 时设 `process.exitCode = 1`。跨文件 import **必须写真实扩展名 `.ts`**（沙箱里的 node 不做 `.js`→`.ts` 的重写）。",
  python: '测试文件（例如 `tests.py`，入口就是它）自己依次跑各条断言，每条**用 try/except 包住：过了 pass+1，抛了 fail+1**；结尾 `print(f"TESTS {pass} {fail}")`，fail>0 时 `sys.exit(1)`。只用标准库。',
  java: '入口是一个带 `public static void main` 的类（例如 `Tests`，文件名必须与类名同名且不带包目录）。每条断言用 try/catch 包住计数，结尾 `System.out.println("TESTS " + pass + " " + fail);` 并在 fail>0 时 `System.exit(1)`。只用 JDK。',
  go: '测试文件（例如 `tests.go`，入口就是它）与实现文件同属 `package main` 且都放在根目录（不要建子目录）；**实现文件不得再定义 `func main`，main 只写在测试文件里**。每条断言用 if 分支计数（通过 pass++，失败 fail++ 并把原因打到 stderr），结尾 `fmt.Printf("TESTS %d %d\\n", pass, fail)`，fail>0 时 `os.Exit(1)`。只用标准库。'
};

export function systemPrompt(kind: "patch_edit" | "author_function", language: ExerciseLanguage): string {
  return [
    `你是代码练习的出题人。要出一道**学习者真在编辑器里写代码、由沙箱真跑测试判分**的题：${kind === "patch_edit" ? "给一段有真实缺陷的实现，让他改到测试全过" : "给签名与示例，让他从零写出实现"}。`,
    "",
    "铁律：",
    "- 沙箱里**没有任何第三方依赖**：只用该语言标准库；被测代码需要的仓库内符号，由你写成最小替身（stub）放进 `hidden`。",
    "- 判分只由测试是否全过决定，所以测试必须**逐条断言、逐条计数**，最后印一行结论。",
    `- 本语言的测试形状：${TEST_CONTRACT[language]}`,
    "- 测试要打在行为上（给定输入 → 期望输出/副作用），不要打在实现细节上（不要断言源码文本、不要断言调用次数这类脆弱项）。",
    kind === "patch_edit"
      ? "- 缺陷必须是**行为级**的真实错误（边界、比较符、单位、分支漏一条），一处即可；禁止用语法错误、拼错的标识符、删掉整个函数来「制造缺陷」——那会让学习者在改编译器而不是改逻辑。"
      : "- 骨架里只留签名与 `TODO`，不留任何可用实现；题面要给足输入输出形状与至少两个示例。",
    "- 题面不得出现测试断言的原文，也不得点出缺陷所在的那一行。",
    "题面用 Markdown 按这三节写：`## 问题描述`、`## 示例`、`## 注意事项`；示例写 1–2 个「调用 → 期望返回」，注意事项只写可核对的约束。",
    "",
    "严格输出 JSON（不要任何其他文字）：",
    `{"ok":true,"language":"${language}","title":"≤${MAX_TITLE}字","prompt":"≤${PROMPT_TARGET}字题面","defect":"<缺陷/要求的一句话说明，仅留档>",`,
    `"given":[{"path":"target.ts","contents":"<下发给学习者的整份文件源码>"}],`,
    `"solution":[{"path":"target.ts","contents":"<应当全过的那一份>"}],`,
    `"hidden":[{"path":"tests.ts","contents":"<测试>"},{"path":"stub.ts","contents":"<替身，可无>"}],"entry":"tests.ts"}`,
    "或拒绝：{\"ok\":false,\"reason\":\"<面向学习者的一句话：这个单元为什么出不了代码题>\"}",
    "",
    "约束：`given` 与 `solution` 的 **path 集合必须完全一致**；`hidden` 不得与它们同名；`entry` 必须是 `hidden` 里那个测试文件（java 填类名，不带 .java）。每档至多 " + MAX_FILES_PER_SLOT + " 个文件，单文件 ≤ " + MAX_FILE_BYTES + " 字节。"
  ].join("\n");
}

/** 参考模式：源码只作参考，题目自足；语言由模型声明。 */
export function referenceSystemPrompt(kind: "patch_edit" | "author_function"): string {
  return [
    `你是代码练习的出题人。这一次由你定题：围绕给定主题出一道具自足的代码题——${kind === "patch_edit" ? "一段带真实缺陷的实现，学习者改到测试全过" : "给签名与示例，学习者从零写出实现"}。`,
    "",
    "仓库代码只作参考：可以从候选摘录里取材（例如用同一套领域概念、同一种数据结构），但**题目必须自足**——给定件与测试不 import 仓库文件、不依赖仓库运行、不假设仓库里存在任何符号。",
    "- 动手写题之前先确认本仓库有没有可参考的落脚：读一下本主题的技能文件，再用 2–4 个英文/代码关键词（别拿中文主题原样搜）调用 `search_code`，命中的文件用 `read_file` 看一眼。`reference` 为空只说明引擎没预选到，不代表本仓库没有；自己检索也没有命中时，再按主题写自足的题，不要编造仓库文件。",
    "",
    "题面用 Markdown 按这三节写：`## 问题描述`、`## 示例`、`## 注意事项`。描述写背景 + 要改/写哪个函数 + 判定看什么行为；示例写 1–2 个「调用 → 期望返回」（类题用操作序列），不要复刻隐藏断言；注意事项只写可核对的约束（语言/标准库、能否改签名、边界条件），不写性能要求，也不点出缺陷所在的那一行。",
    "- 不要写「相关文件 / 参考代码」小节，也不要在题面里粘贴参考文件路径：参考文件由界面按 anchors 展示。",
    "",
    "铁律：",
    "- 沙箱里没有任何第三方依赖：只用该语言标准库；被测代码需要的辅助件由你写进 hidden。",
    "- 判分只由测试是否全过决定，所以测试必须逐条断言、逐条计数，最后印一行结论。",
    "- 三语言各自的测试形状（按你选的语言照做）：",
    ...(Object.keys(TEST_CONTRACT) as ExerciseLanguage[]).map((language) => `  ${language}：${TEST_CONTRACT[language]}`),
    "- 测试要打在行为上（给定输入 → 期望输出/副作用），不要打在实现细节上。",
    kind === "patch_edit"
      ? "- 缺陷必须是行为级的真实错误（边界、比较符、单位、分支漏一条），一处即可；禁止用语法错误、拼错的标识符、删掉整个函数来「制造缺陷」。"
      : "- 骨架里只留签名与 TODO，不留任何可用实现；题面要给足输入输出形状与至少两个示例。",
    "- 题面不得出现测试断言的原文，也不得点出缺陷所在的那一行。",
    "",
    "严格输出 JSON（不要任何其他文字）：",
    `{"ok":true,"language":"${(Object.keys(TEST_CONTRACT) as ExerciseLanguage[]).join("|")}","title":"≤${MAX_TITLE}字","prompt":"≤${PROMPT_TARGET}字题面","defect":"<缺陷/要求的一句话说明，仅留档>",`,
    `"given":[{"path":"target.ts","contents":"<下发给学习者的整份文件源码>"}],`,
    `"solution":[{"path":"target.ts","contents":"<应当全过的那一份>"}],`,
    `"hidden":[{"path":"tests.ts","contents":"<测试>"},{"path":"stub.ts","contents":"<替身，可无>"}],"entry":"tests.ts",`,
    `"anchors":[{"path":"<参考摘录或读过文件的路径>","line":起始行,"endLine":结束行,"why":"<取用了它的什么，≤30 字>"}]}`,
    "或拒绝：{\"ok\":false,\"reason\":\"<面向学习者的一句话：这个主题为什么出不了代码题>\"}",
    "",
    "约束：`given` 与 `solution` 的 path 集合必须完全一致；`hidden` 不得与它们同名；`entry` 必须是 `hidden` 里那个测试文件（java 填类名，不带 .java）。每档至多 " + MAX_FILES_PER_SLOT + " 个文件，单文件 ≤ " + MAX_FILE_BYTES + " 字节。",
    "`anchors` 最多 3 条：只要从某个参考文件（摘录里给的，或这一趟 `read_file` 读过的）取了概念、数据结构或行为，就至少点名一条；只填真正取材过的，行号指向被取用的那一段。每条都要写 `why`：一句话说明取用了它的什么（锁顺序、退避公式、字段形状）；写不出 why 就不要点这条。确实一处都没参考才填空数组。",
    "文件路径必须用所选语言的扩展名：typescript 用 `.ts`、python 用 `.py`、java 用 `.java`、go 用 `.go`，且 go 的所有文件都要在同一个 `package main` 里。"
  ].join("\n");
}

/** 代码题这一步的口径登记。 */
defineAnalysisStep({
  layer: "exercise-code-generate",
  contractVersion: EXERCISE_STEP.contractVersion,
  prompts: [() => [
    ...(["patch_edit", "author_function"] as const).flatMap((kind) => (Object.keys(TEST_CONTRACT) as ExerciseLanguage[]).map((language) => systemPrompt(kind, language))),
    ...(["patch_edit", "author_function"] as const).map(referenceSystemPrompt)
  ].join("\n")]
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
  if (!["typescript", "python", "java", "go"].includes(language)) return { issue: `语言不在沙箱支持范围内：${language || "（空）"}` };
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
  let entry = String(parsed.entry ?? "").trim();
  const test = hidden.find((file) => file.path === entry || file.path.replace(/\.(ts|py|java|go)$/, "") === entry);
  if (!test) return { issue: `入口 ${entry || "（空）"} 不在 hidden 的测试文件里` };
  // Java 的入口是类名，改文件名会与类名脱钩；其余语言的入口必须是 hidden 里那份文件的实际名字。
  if (language !== "java") {
    if (given.some((slot) => slot.path === test.path)) test.path = `tests.${language === "typescript" ? "ts" : language === "python" ? "py" : "go"}`;
    entry = test.path;
  }
  const clash = hidden.find((file) => given.some((slot) => slot.path === file.path));
  if (clash) return { issue: `hidden 与 given 有同名文件（${clash.path}）：下发件会被测试盖掉` };
  const anchors = Array.isArray(parsed.anchors)
    ? (parsed.anchors as unknown[]).flatMap((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        const path = typeof record.path === "string" ? record.path.trim() : "";
        const line = Math.floor(Number(record.line));
        if (!path || !Number.isFinite(line) || line < 1) return [];
        const endLine = Math.floor(Number(record.endLine));
        const why = typeof record.why === "string" ? record.why.trim().slice(0, 60) : "";
        return [{ path, line, ...(Number.isFinite(endLine) && endLine > line ? { endLine } : {}), ...(why ? { why } : {}) }];
      }).slice(0, 3)
    : [];
  return { proposal: { kind, title, prompt, language, given, solution, hidden, entry, defect, ...(anchors.length ? { anchors } : {}) } };
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
  // 沙箱必须点名拒读仓根
  const run = await runSandbox({ language: proposal.language, entry: proposal.entry, files: overlay(proposal.hidden, variant), repositoryPath });
  const output = [run.stderr, run.stdout].filter(Boolean).join("\n").trim().slice(-4_000);
  return { label, verdict: verdictOf(run), exitCode: run.steps.at(-1)?.exitCode ?? null, timedOut: run.timedOut, ran: run.ok, ...(output ? { output } : {}) };
}

/** 两跑自证，沙箱不可用时上抛。 */
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

export interface ProposalResponse {
  text: string;
  usage?: LlmUsage;
  skillReads: SkillReadRecord[];
  fileReads: FileReadRecord[];
}

/** 自证失败后的修复口径：只修实现与测试的不一致，不许靠删断言过关。 */
const REPAIR_INSTRUCTION = [
  "上一份出题在沙箱自证里没有通过。请修正实现或测试中的不一致，重新输出一份完整 JSON（不要只输出改动片段）。",
  "参考解必须让全部测试通过，下发件必须至少有一条测试失败；不得删除、跳过或放宽断言来迁就参考解。"
].join("\n");

export async function requestProposal(input: { provider: LlmProvider; system: string; user: string; temperature: number; faces?: ExerciseFaces; onProgress?: ExerciseProgressSink }): Promise<ProposalResponse> {
  const loop = await completeWithReadTool({
    ...(input.faces ?? {}),
    provider: input.provider,
    scope: input.faces?.scope ?? "practice",
    system: input.system,
    user: input.user,
    temperature: input.temperature,
    onProgress: forwardToolProgress(input.onProgress),
    scene: "practice.generate-code"
  });
  return { text: loop.completion.text, usage: loop.usage, skillReads: loop.skillReads, fileReads: loop.fileReads };
}

function providerFailure(error: unknown, first?: { usage?: LlmUsage; skillReads: SkillReadRecord[]; fileReads?: FileReadRecord[] }): CodeGeneration {
  const audits = toolLoopAuditsOf(error);
  return {
    ok: false,
    stage: "provider_error",
    reason: `出题时模型调用失败：${(error as Error).message}`,
    runs: [],
    ...(first?.usage ? { usage: first.usage } : {}),
    skillReads: [...(first?.skillReads ?? []), ...(audits?.skillReads ?? [])],
    ...(first?.fileReads ? { fileReads: first.fileReads } : {})
  };
}

/** 把上一份 JSON、失败原因与测试输出交给模型，并保留原始出题输入。 */
function repairUser(original: string, previous: string, failure: Extract<CodeGeneration, { ok: false }>): string {
  const output = failure.runs.find((run) => run.label === "solution")?.output ?? failure.runs[0]?.output ?? "";
  return [
    original,
    "",
    REPAIR_INSTRUCTION,
    "",
    JSON.stringify({
      previous: previous.length > 40_000 ? `${previous.slice(0, 40_000)}\n…（上一份已截断）` : previous,
      failure: failure.reason ?? "自证未通过",
      ...(output ? { testOutput: output } : {})
    })
  ].join("\n");
}

/** 修复策略：默认对自证失败与形状错误各重试一次；实验可再放宽次数。 */
export interface RepairPolicy {
  /** 首轮之后最多重试几次。 */
  maxRetries: number;
  /** 形状错误是否也重试。 */
  retryShape: boolean;
}

const DEFAULT_REPAIR: RepairPolicy = { maxRetries: 1, retryShape: true };

/** 合并多次尝试的用量与审计；失败理由带上实际修复次数。 */
function combineAttempts(attempts: CodeGeneration[]): CodeGeneration {
  const last = attempts.at(-1)!;
  const usage = attempts.reduce<LlmUsage | undefined>((sum, attempt) => addUsage(sum, attempt.usage), undefined);
  const merged = {
    usage,
    skillReads: attempts.flatMap((attempt) => attempt.skillReads),
    fileReads: attempts.flatMap((attempt) => attempt.fileReads ?? []),
    runs: attempts.flatMap((attempt) => attempt.runs)
  };
  if (last.ok) return { ...last, ...merged };
  const repairs = attempts.length - 1;
  return { ...last, ...merged, reason: repairs > 0 ? `${last.reason}（修复 ${repairs} 次后仍未通过）` : last.reason };
}

/** 首轮 + 修复：默认只在自证失败时重发；实验策略可同时重试形状错误。 */
async function generateWithRepair(input: {
  provider: LlmProvider;
  system: string;
  user: string;
  temperature: number;
  faces?: ExerciseFaces;
  onProgress?: ExerciseProgressSink;
  finish: (response: ProposalResponse) => Promise<CodeGeneration>;
  repair?: RepairPolicy;
}): Promise<CodeGeneration> {
  const policy = input.repair ?? DEFAULT_REPAIR;
  const attempts: CodeGeneration[] = [];
  let previous = "";
  try {
    let response = await requestProposal(input);
    previous = response.text;
    let result = await input.finish(response);
    attempts.push(result);
    while (!result.ok && attempts.length <= policy.maxRetries) {
      const retryable = result.stage === "harness_validation" || (policy.retryShape && result.stage === "proposal_shape");
      if (!retryable) break;
      const repaired = await requestProposal({ ...input, user: repairUser(input.user, previous, result) });
      previous = repaired.text;
      result = await input.finish(repaired);
      attempts.push(result);
      if (input.faces?.signal?.aborted) throw new LlmAbortedError();
    }
    return combineAttempts(attempts);
  } catch (error) {
    if (isLlmAborted(error, input.faces?.signal)) throw error;
    const failure = providerFailure(error);
    return attempts.length ? combineAttempts([...attempts, failure]) : failure;
  }
}

/** 引擎侧对 patch_edit 的额外要求：`solution` 必须逐字含仓里那段真实现。 */
function solutionMatchesSource(proposal: CodeProposal, body: string): boolean {
  const needle = body.trim().replace(/\s+/g, " ");
  if (!needle) return false;
  return proposal.solution.some((file) => file.contents.replace(/\s+/g, " ").includes(needle));
}

export async function generateCodeExercise(input: { repositoryPath: string; unit: ImplementationUnit; kind: "patch_edit" | "author_function"; provider: LlmProvider; faces?: ExerciseFaces; onProgress?: ExerciseProgressSink; repair?: RepairPolicy }): Promise<CodeGeneration> {
  const source = unitSource(input.repositoryPath, input.unit);
  if (!source) return { ok: false, stage: "proposal_shape", reason: "读不出这个单元的源码正文。", runs: [], skillReads: [] };
  const language = input.unit.symbol.language === "typescript" ? "typescript" : input.unit.symbol.language === "python" ? "python" : input.unit.symbol.language === "java" ? "java" : input.unit.symbol.language === "go" ? "go" : undefined;
  if (!language) return { ok: false, stage: "proposal_shape", reason: `${input.unit.symbol.language} 的代码题还不支持。`, runs: [], skillReads: [] };

  recordEgress({ repositoryPath: input.repositoryPath, scene: "practice.generate-code", sources: source.sources.map((entry) => ({ kind: "exercise-excerpt" as const, ...entry })) });
  // 与问答回合同一条循环：出题这一趟也能自己读文件、检索、查静态产物
  const faces = input.faces ?? {};
  input.onProgress?.({ stage: "proposing" });
  return await generateWithRepair({
    provider: input.provider,
    system: withSkillsBrief(systemPrompt(input.kind, language), faces.skills),
    user: JSON.stringify({
      kind: input.kind,
      language,
      target: { path: input.unit.symbol.path, symbol: input.unit.symbol.name, line: input.unit.symbol.line, parameters: input.unit.symbol.parameters },
      imports: source.imports,
      source: source.body.slice(0, MAX_FILE_BYTES)
    }),
    temperature: 0.4,
    ...(input.faces ? { faces: input.faces } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.repair ? { repair: input.repair } : {}),
    finish: (response) => finishProposal(response, { kind: input.kind, repositoryPath: input.repositoryPath, language, solutionBody: source.body, refusal: "模型认为这个单元出不了代码题。", onProgress: input.onProgress, ...(input.faces?.signal ? { signal: input.faces.signal } : {}) })
  });
}

/** 参考模式：源码只作参考，模型自己定题；语言也由模型声明。 */
export async function generateCodeExerciseFromReference(input: {
  repositoryPath: string;
  tag: string;
  kind: "patch_edit" | "author_function";
  /** 参考素材：候选文件与摘录（只作参考，不要求逐字使用）。 */
  reference: string;
  provider: LlmProvider;
  faces?: ExerciseFaces;
  onProgress?: ExerciseProgressSink;
  repair?: RepairPolicy;
  /** 上一趟（分段）已经定好的题面：沿用，别重新选题。 */
  priorPlan?: { title: string; prompt: string; defect: string };
}): Promise<CodeGeneration> {
  const faces = input.faces ?? {};
  input.onProgress?.({ stage: "proposing" });
  return await generateWithRepair({
    provider: input.provider,
    system: withSkillsBrief(referenceSystemPrompt(input.kind), faces.skills),
    user: JSON.stringify({
      kind: input.kind, theme: input.tag, reference: input.reference,
      ...(input.priorPlan ? { priorPlan: input.priorPlan, note: "priorPlan 是上一趟已经定好并写好的题面：沿用它的标题与三节结构，把精力放在实现与测试上，不要重新选题。" } : {})
    }),
    temperature: 0.4,
    ...(input.faces ? { faces: input.faces } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.repair ? { repair: input.repair } : {}),
    finish: (response) => finishProposal(response, { kind: input.kind, repositoryPath: input.repositoryPath, refusal: "模型认为这个主题出不了代码题。", onProgress: input.onProgress, ...(input.faces?.signal ? { signal: input.faces.signal } : {}) })
  });
}

/** 同一趟调用之后的共同收尾：解析形状、按模式校验、沙箱两跑自证。 */
export async function finishProposal(
  response: { text: string; usage?: LlmUsage; skillReads: SkillReadRecord[]; fileReads: FileReadRecord[] },
  context: {
    kind: "patch_edit" | "author_function";
    repositoryPath: string;
    /** 单元模式：语言由单元定；参考模式不给，语言由模型声明。 */
    language?: ExerciseLanguage;
    /** 单元模式：改代码题的参考解必须逐字含这段源码。 */
    solutionBody?: string;
    refusal: string;
    onProgress?: ExerciseProgressSink;
    /** 用户取消时不再开新的沙箱运行。 */
    signal?: AbortSignal;
  }
): Promise<CodeGeneration> {
  const audits = { usage: response.usage, skillReads: response.skillReads, fileReads: response.fileReads };
  const parsed = parseJsonObject(response.text);
  if (!parsed) return { ok: false, stage: "proposal_shape", reason: "出题返回的不是可解析的 JSON。", runs: [], ...audits };
  if (parsed.ok === false) return { ok: false, stage: "proposal_shape", reason: String(parsed.reason ?? context.refusal).trim() || "模型拒绝出题。", runs: [], ...audits };

  const normalized = normalizeProposal({ ...parsed, kind: context.kind, ...(context.language ? { language: context.language } : {}) });
  if (!normalized.proposal) return { ok: false, stage: "proposal_shape", reason: normalized.issue ?? "出题结果形状不合法。", runs: [], ...audits };
  const proposal = normalized.proposal;
  if (context.language && proposal.language !== context.language) {
    return { ok: false, stage: "proposal_shape", reason: `模型报的语言（${proposal.language}）与目标单元（${context.language}）不一致。`, runs: [], ...audits };
  }
  if (proposal.kind === "patch_edit" && context.solutionBody && !solutionMatchesSource(proposal, context.solutionBody)) {
    return { ok: false, stage: "proposal_shape", reason: "参考实现与仓库里那段代码对不上。", runs: [], ...audits };
  }

  let validation: { ok: boolean; reason?: string; runs: HarnessRun[] };
  try {
    if (context.signal?.aborted) throw new LlmAbortedError();
    context.onProgress?.({ stage: "validating" });
    validation = await validateHarness(proposal, context.repositoryPath);
  } catch (error) {
    if (error instanceof SandboxUnavailableError) return { ok: false, stage: "sandbox_unavailable", reason: error.message, runs: [], ...audits };
    throw error;
  }
  if (!validation.ok) return { ok: false, stage: "harness_validation", reason: validation.reason ?? "自证未通过。", runs: validation.runs, ...audits };
  return { ok: true, proposal, runs: validation.runs, ...audits };
}

/** 按需讲评的一趟调用，先重跑沙箱拿失败原因。 */
export async function explainCodeAttempt(input: {
  repositoryPath: string;
  title: string;
  prompt: string;
  harness: { language: ExerciseLanguage; entry: string; hidden: CodeFile[]; defect: string };
  learnerFiles: CodeFile[];
  provider: LlmProvider;
  faces?: ExerciseFaces;
}): Promise<{ explanation: string; usage?: LlmUsage; verdict: { passed: number; failed: number } | undefined; fileReads: FileReadRecord[] }> {
  const files = [...input.harness.hidden.map((file) => ({ ...file })), ...input.learnerFiles.map((file) => ({ ...file }))];
  const run = await runSandbox({ language: input.harness.language, entry: input.harness.entry, files, repositoryPath: input.repositoryPath });
  const verdict = verdictOf(run);
  const failing = (run.stderr || "").trim().split("\n").filter(Boolean).slice(0, 12).join("\n").slice(0, 2_000);
  const sources = input.learnerFiles.map((file) => {
    // 每个文件各自计数
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
  const loop = await completeWithReadTool({ ...input.faces, provider: input.provider, scope: input.faces?.scope ?? "practice", system, user, temperature: 0.3, scene: "practice.explain" });
  return { explanation: loop.completion.text.trim().slice(0, 400), usage: loop.usage, verdict, fileReads: loop.fileReads };
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
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
