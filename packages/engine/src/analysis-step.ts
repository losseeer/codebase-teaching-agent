import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "./lib.js";

/**
  一个 LLM 分析步骤的「口径」= 缓存键里的版本号 + 喂给模型的固定文案。这两样在这份文件里绑成一个对象，
  存在的理由是一条已经记在多处注释里的失效路径：

  缓存键里只有版本号、**没有提示词文本**（`lib.ts` 的 `layerCacheKey`，那是有意的取舍）。
  于是「改了文案、忘了翻版本号」时 payload 逐字不变 ⇒ 旧答案永久命中；而每次命中都会给闲置 TTL 续期
  （`flows/flow.ts` 的 `touchLayerCache`、`store/database.ts` 的 `putLayerCache` 修剪线），
  常用的仓连「放 7 天自然过期」这条兜底都拿不到。过去这条纪律只写在注释里靠人记得（见 `entry-suggest.ts`
  的 `candidate-v5` 那一条：措辞一改，同一份候选从 5 条变 0 条，只能靠版本号翻键）。

  现在改成机器核对：登记过的提示词逐条算指纹，落一份 `analysis-step.lock.json`；
  文案变了而版本号没翻 ⇒ `analysis-step.test.ts` 红，必须显式跑 `pnpm analysis:lock` 才写得进新锁。

  为什么不在键里直接哈希提示词文本（那样最省事、结构上不可能漏）：一次无关的措辞润色会静默重烧全仓，
  而重烧是要花真钱的（一条流程 ≈¥0.17、全仓摘要 ≈¥0.06，见 §32 的单价读数）。
  失效开关必须是人的一次显式决定，不能由编辑动作自动触发——与 `summarizer.ts` 不把隐去写进切片同一套取舍。
*/

/** 提示词可以按参数生成（代码题按题型与语言分档），登记成 thunk 让指纹仍能确定复算。 */
export type AnalysisStepPrompt = string | (() => string);

export interface AnalysisStepDefinition {
  /** 缓存键前缀。重名直接抛：两处给同一层算键意味着两把键，读侧会随机命中其中一把。 */
  readonly layer: string;
  readonly contractVersion: string;
  /** 该步骤发给模型的**全部**固定文案。用户消息那半边不用登记——它进 payload，也进键。 */
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
  **不导出**：构造键的唯一入口是 `AnalysisStep.cacheKey()`，而步骤登记时必须交出提示词——
  「新加一层忘了登记口径」因此不可能悄悄发生。

  为什么键里放**本层实际看到的输入**，而不是全仓 `versionStamp`：全仓哈希让任一字节变化作废整层缓存；
  换成细到「受影响子图」又得证明哪些变更会翻键——不完备就等于把旧结果锁死。而对模型实际看到的
  东西取哈希后，「输入逐字相同 ⇒ 提示词逐字相同 ⇒ 同一问同一答」是直接成立的，不需要额外论证完备性。

  两条使用约束：
  - `repositoryId` 必须在键里：不同仓库可能算出相同输入（同样的空清单、同样的样板路径），
    而缓存值装的是仓库内的节点 id 与相对路径，撞键会把 A 仓的结论挂到 B 仓上；
  - `payload` 必须是 JSON 安全的（Map/Set 会被 `JSON.stringify` 写成 `{}`，等于把不同输入哈希成同一个值）。
    需要时先序列化，例如 `Object.fromEntries(map.entries())`。

  `contractVersion` 专管「输入没变但算法变了」：裁剪阈值、排序规则改了，payload 可以一字不变，
  这类失效只有版本号管得了（提示词文案那一半由下面的指纹守卫代劳，L1 摘要键里的 `slice-v1` 是同一个道理）。
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
