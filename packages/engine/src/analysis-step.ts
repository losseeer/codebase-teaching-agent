import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "./identity.js";

/**
  一个 LLM 分析步骤的「口径」= 进 L2 缓存键的版本号 + 喂给模型的全部固定文案，二者绑在这里一起登记。
  缓存键不含提示词文本，改文案不翻版本号时旧答案会永久命中，所以登记的提示词逐条算指纹，
  落 `analysis-step.lock.json`；文案变了而版本号没翻，`analysis-step.test.ts` 会红，
  必须显式跑 `pnpm analysis:lock` 才写得进新锁。

  不在键里直接哈希提示词文本：那会让一次无关的措辞润色静默触发全仓付费重生成——
  作废旧产物必须是人的一次显式决定，不由编辑动作自动触发。
*/

/** 提示词可以按参数生成（代码题按题型与语言分档），登记成 thunk 让指纹仍能确定复算。 */
export type AnalysisStepPrompt = string | (() => string);

export interface AnalysisStepDefinition {
  /** 缓存键前缀。重名直接抛：同一层两把键，读侧会随机命中其中一把。 */
  readonly layer: string;
  readonly contractVersion: string;
  /** 该步骤发给模型的全部固定文案。用户消息那半边不用登记——它进 payload，也进键。 */
  readonly prompts: readonly AnalysisStepPrompt[];
}

export interface AnalysisStep {
  readonly layer: string;
  readonly contractVersion: string;
  /** 该步骤全部提示词的指纹，与锁文件同一算法。 */
  readonly promptDigest: string;
  /**
    构造这一层的 L2 缓存键。版本号由步骤给出、调用点拿不到它——
    「记得传版本号」这件事因此从代码约定变成构造方式。
    */
  cacheKey(input: { repositoryId: string; modelVersion: string; payload: unknown; scope?: string }): string;
}

/** 锁文件的一行：层、当时的版本号、当时的提示词指纹。 */
export interface AnalysisStepFingerprint {
  layer: string;
  contractVersion: string;
  promptDigest: string;
}

const steps = new Map<string, AnalysisStep>();

/**
  LLM 产物缓存键的统一构造：`层:仓库id[:范围]:输入哈希`，输入哈希 = 口径版本 + 模型版本 + 本层实际输入。
  对「本层实际输入」取哈希，「输入逐字相同 ⇒ 同一问同一答」直接成立，不用论证全仓失效粒度。
  本函数不导出：构造键的唯一入口是 `AnalysisStep.cacheKey()`，而步骤登记时必须交出提示词——
  新加一层忘登记口径不可能悄悄发生。

  两条使用约束：
  - `repositoryId` 必须在键里：不同仓库可能算出相同输入，而缓存值装的是仓库内的节点 id 与相对路径；
  - `payload` 必须 JSON 安全（Map/Set 会被 `JSON.stringify` 写成 `{}`，不同输入哈希成同一个值）。

  `contractVersion` 专管「输入没变但算法变了」（裁剪阈值、排序规则改了 payload 可以一字不变）；
  提示词文案那一半由指纹守卫代劳。
  */
function layerCacheKey(input: {
  layer: string;
  repositoryId: string;
  contractVersion: string;
  modelVersion: string;
  payload: unknown;
  scope?: string;
}): string {
  const digest = hash(`${input.contractVersion}:${input.modelVersion}:${JSON.stringify(input.payload)}`).slice(0, 16);
  return `${input.layer}:${input.repositoryId}${input.scope ? `:${input.scope}` : ""}:${digest}`;
}

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
    promptDigest: promptDigestOf(definition.prompts),
    cacheKey: (input) => layerCacheKey({ ...input, layer: definition.layer, contractVersion: definition.contractVersion })
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
