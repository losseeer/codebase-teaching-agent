import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "./ids.js";

/**
  一个 LLM 分析步骤的登记 = 这一层的口径版本号 + 喂给模型的全部固定文案，二者绑在一起登记。
  登记的用途是指纹守卫：提示词逐条算指纹落 `analysis-step.lock.json`，文案变了而没显式
  `pnpm analysis:lock` 就红——作废旧产物必须是人的决定，不由编辑动作自动触发。
  各层实际怎么算自己的缓存键，由那一层自己决定（`summarizer` 按切片、`exercises` 按目标单元），
  这里不代持构造：曾经有过的统一键构造器随它的两个消费方一起退了。
*/

/** 提示词可以按参数生成（代码题按题型与语言分档），登记成 thunk 让指纹仍能确定复算。 */
export type AnalysisStepPrompt = string | (() => string);

export interface AnalysisStepDefinition {
  /** 层名，也是锁文件里的主键。重名直接抛：同名两层会互相顶掉指纹。 */
  readonly layer: string;
  readonly contractVersion: string;
  /** 该步骤发给模型的全部固定文案。 */
  readonly prompts: readonly AnalysisStepPrompt[];
}

export interface AnalysisStep {
  readonly layer: string;
  readonly contractVersion: string;
  /** 该步骤全部提示词的指纹，与锁文件同一算法。 */
  readonly promptDigest: string;
}

/** 锁文件的一行：层、当时的版本号、当时的提示词指纹。 */
export interface AnalysisStepFingerprint {
  layer: string;
  contractVersion: string;
  promptDigest: string;
}

const steps = new Map<string, AnalysisStep>();

/** 指纹算法：逐条解析 thunk 后用 NUL 行分隔（文案里不会出现 U+0000，拼接不会吞掉边界）。 */
export function promptDigestOf(prompts: readonly AnalysisStepPrompt[]): string {
  const text = prompts.map((prompt) => (typeof prompt === "string" ? prompt : prompt())).join("\n\u0000");
  return hash(text).slice(0, 16);
}

export function defineAnalysisStep(definition: AnalysisStepDefinition): AnalysisStep {
  if (steps.has(definition.layer)) throw new Error(`分析步骤重复登记：${definition.layer}`);
  const step: AnalysisStep = {
    layer: definition.layer,
    contractVersion: definition.contractVersion,
    promptDigest: promptDigestOf(definition.prompts)
  };
  steps.set(step.layer, step);
  return step;
}

/** 已登记的步骤，按层排序（锁文件与 diff 都必须与登记顺序无关）。 */
export function analysisSteps(): readonly AnalysisStep[] {
  return [...steps.values()].sort((a, b) => a.layer.localeCompare(b.layer));
}

export function stepFingerprints(): AnalysisStepFingerprint[] {
  return analysisSteps().map((step) => ({ layer: step.layer, contractVersion: step.contractVersion, promptDigest: step.promptDigest }));
}

/** 锁文件跟着这份源码走：它是要进版本控制的比对基准，不是运行时产物。 */
export const ANALYSIS_STEP_LOCK_FILE = join(dirname(fileURLToPath(import.meta.url)), "analysis-step.lock.json");

export function readLockedFingerprints(): AnalysisStepFingerprint[] {
  const parsed = JSON.parse(readFileSync(ANALYSIS_STEP_LOCK_FILE, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${ANALYSIS_STEP_LOCK_FILE} 应当是数组`);
  return (parsed as AnalysisStepFingerprint[]).slice().sort((a, b) => a.layer.localeCompare(b.layer));
}

/** 重写锁文件并返回写进去的步骤数（脚本 `pnpm analysis:lock` 用）。 */
export function writeLockedFingerprints(): number {
  const fingerprints = stepFingerprints();
  writeFileSync(ANALYSIS_STEP_LOCK_FILE, `${JSON.stringify(fingerprints, null, 2)}\n`, "utf8");
  return fingerprints.length;
}
