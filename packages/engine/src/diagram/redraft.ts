import type { ArchitectureBlockBrief, ArchitectureBlockRole, ArchitectureDiagramDraft, ArchitectureEdge, ArchitectureLayer, DiagramLayerDraft } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { addUsage } from "../llm/usage.js";
import type { SearchCorpus } from "../source/search-code.js";
import type { FileReadRecord } from "../source/read-file.js";
import { completeWithReadTool } from "../source/tool-loop.js";
import { applyOverrides, archContext, layerEdges, type ArchitectureInput, type ArchitectureUnits } from "../coursetree/architecture.js";

/**
  「重画一张图」这一趟（状态机见 shared 里 DiagramStatus 的注释）。这一文件只做架构形态；
  流程那条复用 `flows/flow.ts` 已有的 `normalizeStage`（路径必须在可用集合里、行号按文件长度 clip），不在这里重写。

  两趟调用，中间隔一道确定性核验：
  1. **取证**：只给 read_file / search_code，只许交「带 path:line 的事实」，不许出层名。
     回来的每条证据先查「这个路径真在索引里」——**编出来的路径在这里就被丢掉并计数**，不进第二趟。
  2. **出图**：事实清单 + 画布上现有的格子，只回答「分几层、每层叫什么、哪格归哪层」。

  为什么不合成一趟：合一趟就是「先给结论再补理由」，取证会被自己的结论带着读文件；
  分两趟，中间那道核验才有独立对象。

  钱：这一趟是本产品最贵的单次动作（粗估 ¥0.1~0.3），**引擎绝不自发**。`propose` 只落一行 pending，
  真发请求由用户点画布上那条横幅触发——与「判一次分层」那颗按钮同一条纪律：花钱的动作由人发起。
*/

/** 取证段最多交几条事实：再多只是清单变长，读不出更多结构。 */
const MAX_FINDINGS = 14;
/** 取证段的预算：6 轮工具、最多真读 16 个文件——够摸一遍模块与边界，又不至于把整仓搬进上下文。 */
const EXPLORE_ROUNDS = 6;
const EXPLORE_READS = 16;

/** 角色这句人话只用于「反证怎么说」与「格子清单怎么列」；档位本身是引擎算的，模型一格都不参与。 */
const ROLE_LABEL: Record<ArchitectureBlockRole | "side", string> = {
  entry: "含对外服务入口",
  core: "入口可达的主链路",
  shared: "被多处引用的底座",
  support: "其余支撑",
  side: "没人引用、入口也走不到"
};
export type CanvasRole = ArchitectureBlockRole | "side";

export interface DiagramFinding {
  unit: string;
  claim: string;
  /** `path:line`；路径不在索引里就整条丢掉，不带进第二趟 */
  evidence: string;
}

export interface RedraftOutcome {
  ok: boolean;
  reason?: string;
  draft?: ArchitectureDiagramDraft;
  usage?: LlmUsage;
  /** 取证段交回但被丢的条数（证据路径不存在）：预览横幅要报得出这个数。 */
  droppedFindings: number;
  findings: DiagramFinding[];
  /** 这一趟真读过的文件（路由拿去落 `file_read` 审计，与对话那条同一口径）。 */
  fileReads: FileReadRecord[];
  rounds: number;
}

/** 画布上现在真实会画出来的格子。核验只认这份：模型不许造新格。 */
export interface CanvasUnits {
  blocks: ArchitectureBlockBrief[];
  units: ArchitectureUnits;
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function verifyArchitectureDraft(raw: unknown, canvas: CanvasUnits): { ok: boolean; reason?: string; draft?: ArchitectureDiagramDraft } {
  const layersRaw = (raw as { layers?: unknown }).layers;
  if (!Array.isArray(layersRaw) || layersRaw.length < 2) return { ok: false, reason: "layers 至少要有两层：只分一块不叫分层" };
  if (layersRaw.length > 7) return { ok: false, reason: `分了 ${layersRaw.length} 层，超过 7 层上限——那是清单不是分层` };
  const drawn = new Map(canvas.blocks.map((block) => [block.id, block]));
  const known = (id: string): boolean => drawn.has(id) || canvas.units.members.has(id);
  /** 一格摊到成员：合并块是整个块，被拆出来单讲的原子模块就是它自己。 */
  const membersOf = (id: string): string[] => drawn.get(id)?.members ?? canvas.units.blocks.get(id) ?? [id];
  const assigned = new Map<string, string>();
  const layers: DiagramLayerDraft[] = [];
  for (const item of layersRaw) {
    const entry = item as Record<string, unknown>;
    const name = clip(entry.name, 24);
    const duty = clip(entry.duty, 40);
    const nodes = (Array.isArray(entry.nodes) ? entry.nodes : Array.isArray(entry.modules) ? entry.modules : []).map(String);
    if (!name) return { ok: false, reason: "有一层没有名字" };
    if (!nodes.length) return { ok: false, reason: `层「${name}」一格都没有：空的层不画` };
    for (const id of nodes) {
      if (!known(id)) return { ok: false, reason: `「${id.slice(0, 60)}」不是画布上现有的格：只能重排这些格子，不许造新格` };
      if (assigned.has(id)) return { ok: false, reason: `格子「${id.slice(0, 60)}」同时进「${assigned.get(id)}」和「${name}」两层` };
      assigned.set(id, name);
    }
    layers.push({ name, duty: duty || "（没给职责一句话）", nodes });
  }
  const omittedRaw = (raw as { omitted?: unknown }).omitted;
  const omitted = (Array.isArray(omittedRaw) ? omittedRaw : []).map((item) => {
    const entry = item as Record<string, unknown>;
    return { node: clip(entry.node ?? entry.module, 120), reason: clip(entry.reason ?? entry.why, 60) };
  }).filter((item) => item.node);
  for (const item of omitted) {
    if (!known(item.node)) return { ok: false, reason: `omitted 里的「${item.node.slice(0, 60)}」不是画布上现有的格` };
    if (!item.reason) return { ok: false, reason: `omitted 里的「${item.node.slice(0, 60)}」没给理由：不画它得说为什么不画` };
    if (assigned.has(item.node)) return { ok: false, reason: `「${item.node.slice(0, 60)}」既归进「${assigned.get(item.node)}」又被列进 omitted` };
  }
  // 覆盖判据按**成员**算：模型可以把一个大块的成员分着放（拆块由聚合一处决定），只要每个成员都安置了就行
  const covered = new Set<string>();
  for (const ids of [...layers.map((layer) => layer.nodes), omitted.map((item) => item.node)]) for (const id of ids) for (const member of membersOf(id)) covered.add(member);
  const missing = canvas.blocks.filter((block) => !block.members.every((member) => covered.has(member)));
  if (missing.length) return { ok: false, reason: `有 ${missing.length} 个格子没安置（如「${missing[0].title.slice(0, 24)}」）：要么归层，要么进 omitted 并给理由——静默丢格会把图上的格数改成骗人的` };

  return { ok: true, draft: { kind: "architecture", layers, omitted, conflicts: conflictsOf(layers, canvas), readPaths: [] } };
}

/**
  反证只做一件事：把候选摊回**实际会画出来的格子**（复用人工修正那同一套聚合，不另写一份），
  再拿每格的结构角色与「同层多数格子的角色」对照，相反的挑出来。
  落库、不拦——但这条标签会随修正一起进下一次判层的输入，免得一条没根据的归层被下一轮当成事实。
*/
function conflictsOf(layers: DiagramLayerDraft[], canvas: CanvasUnits): ArchitectureDiagramDraft["conflicts"] {
  const asLayers: ArchitectureLayer[] = layers.map((layer, index) => ({ id: `layer-${index + 1}`, name: layer.name, duty: layer.duty, moduleIds: layer.nodes }));
  // 传一份**空覆盖层**（不是 undefined）就走聚合那一段：成员同层保留块 id，被拆开就换成成员 id
  const rendered = applyOverrides(asLayers, { moduleLayer: {} }, canvas.units).layers;
  const roleByMember = new Map<string, CanvasRole>();
  for (const block of canvas.blocks) for (const member of block.members) roleByMember.set(member, block.role);
  const conflicts: ArchitectureDiagramDraft["conflicts"] = [];
  for (const layer of rendered) {
    if (layer.moduleIds.length < 2) continue;
    const cells = layer.moduleIds.map((id) => ({ id, role: roleByMember.get((canvas.units.blocks.get(id) ?? [id])[0]!) ?? ("side" as CanvasRole) }));
    const tally = new Map<CanvasRole, number>();
    for (const cell of cells) tally.set(cell.role, (tally.get(cell.role) ?? 0) + 1);
    const [dominant, count] = [...tally.entries()].sort((left, right) => right[1] - left[1])[0]!;
    // 「多数」要真成立：同层至少两格是同一档，否则没有反例可说
    if (count < 2) continue;
    for (const cell of cells) {
      if (cell.role === dominant) continue;
      conflicts.push({ node: cell.id, layer: layer.name, evidence: `这一格${ROLE_LABEL[cell.role]}，而同层 ${cells.length} 格里 ${count} 格是${ROLE_LABEL[dominant]}` });
    }
  }
  return conflicts;
}

/** 取证段与出图段共用的底稿：目的 + 现有层名 + 现有格子（id 是唯一可引用的句柄）。 */
function canvasBrief(canvas: CanvasUnits, currentLayers: string[], purpose: string): string {
  const cells = canvas.blocks
    .map((block) => `- id=${block.id}｜${block.title}｜角色：${ROLE_LABEL[block.role]}｜${block.members.length} 个模块`)
    .join("\n");
  return [
    `重画这张图要回答的问题：${purpose}`,
    `现在这张图的层：${currentLayers.join(" / ") || "（还没有）"}`,
    `画布上现有的格子（只能重排它们，别的最多 7 层之外就不叫分层图）：\n${cells}`
  ].join("\n");
}

export async function runArchitectureRedraft(input: {
  architectureInput: ArchitectureInput;
  provider: LlmProvider;
  purpose: string;
  /** 现在那张图的层名（进底稿给模型当参照）；由调用方从读侧拿，别在这里再算一遍缓存键。 */
  currentLayers: string[];
  search?: SearchCorpus;
  signal?: AbortSignal;
}): Promise<RedraftOutcome> {
  const { architectureInput: architecture, provider, purpose } = input;
  const context = archContext(architecture, provider.modelVersion);
  const canvas: CanvasUnits = { blocks: context.briefs, units: context.units };
  const empty: RedraftOutcome = { ok: false, droppedFindings: 0, findings: [], fileReads: [], rounds: 0 };
  if (!canvas.blocks.length) return { ...empty, reason: "这个仓现在没有可重排的格子（模块地图是空的）" };
  const brief = canvasBrief(canvas, input.currentLayers, purpose);
  const indexedPaths = new Set(architecture.index.files.map((file) => file.path));

  const explore = await completeWithReadTool({
    provider,
    repoPath: architecture.repositoryPath,
    system: [
      "你是代码考古的取证员。任务只有一个：**读这个仓、交事实，不出架构结论**——层名、归类、谁高谁低都不许出现。",
      "手上只有 read_file 与 search_code：命名看不出来的目录就去读，不要猜。",
      "要弄清的是：每块目录里到底装什么、谁把活儿交给谁、对外的入口在哪、哪些只是配置或工具、以及系统的边界（哪些是它自己写的、哪些只是用它）。",
      `严格输出 JSON：{"findings":[{"unit":"目录或模块名","claim":"一句事实","evidence":"仓库内路径:行号"}],"boundaries":"系统边界一句话","notes":"读不明白的地方"}`,
      `findings 最多 ${MAX_FINDINGS} 条，每条的 evidence 必须是你真读过的路径；没读过的路径写了也会被丢掉并计数。`,
      "不要输出这个 JSON 以外的任何文字。"
    ].join("\n"),
    user: brief,
    maxTokens: 1_400,
    temperature: 0.2,
    maxRounds: EXPLORE_ROUNDS,
    maxCalls: EXPLORE_READS,
    scene: "map.redraft",
    ...(input.search ? { search: input.search } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  const explored = parseJsonObject(explore.completion.text);
  const findings: DiagramFinding[] = [];
  let droppedFindings = 0;
  for (const item of Array.isArray(explored?.findings) ? explored.findings : []) {
    const entry = item as Record<string, unknown>;
    const evidence = clip(entry.evidence, 160);
    const path = evidence.split(":")[0] ?? "";
    if (!path || !indexedPaths.has(path)) {
      droppedFindings += 1;
      continue;
    }
    findings.push({ unit: clip(entry.unit, 60), claim: clip(entry.claim, 120), evidence });
    if (findings.length >= MAX_FINDINGS) break;
  }

  const drafted = await provider.complete({
    system: [
      "你是架构分层器。给定一个仓的**事实清单**（上一趟真读出来的）与画布上现有的格子，把它们分进 2~7 个职责层次，自上而下。",
      "只回答三件事：分几层、每层叫什么、哪一格归哪层。格子 id 原样使用，一个格子只能出现一次。",
      "**不画的格子必须进 omitted 并给一句理由**（「测试夹具」「纯文档」「不参与这条主线」这类）；不许静默丢格子。",
      "层名用软件工程里读得懂的职责名，每层再给一句这个仓库自己的职责说明，不超过 40 字。",
      "箭头、文件路径、外部依赖由程序自己算：**不许输出这些字段**，输出了会被丢弃。",
      "严格输出 JSON：{\"layers\":[{\"name\":\"层名\",\"duty\":\"一句话职责\",\"nodes\":[\"格子 id\"]}],\"omitted\":[{\"node\":\"格子 id\",\"reason\":\"为什么不画\"}]}"
    ].join("\n"),
    user: `${brief}\n\n事实清单（上一趟读出来的，只作参考；路径与行号已经过索引核对）：\n${JSON.stringify({ findings, boundaries: clip(explored?.boundaries, 160), notes: clip(explored?.notes, 160) })}`,
    maxTokens: 1_400,
    temperature: 0.2,
    scene: "map.redraft",
    ...(input.signal ? { signal: input.signal } : {})
  });
  const usage = addUsage(explore.usage, drafted.usage);
  const fileReads = explore.fileReads;
  const verified = verifyArchitectureDraft(parseJsonObject(drafted.text) ?? {}, canvas);
  if (!verified.ok || !verified.draft) {
    return { ok: false, reason: verified.reason ?? "模型没给出可解析的 JSON", usage, droppedFindings, findings, fileReads, rounds: explore.rounds };
  }
  return {
    ok: true,
    draft: { ...verified.draft, readPaths: [...new Set(fileReads.map((read) => read.path))] },
    usage,
    droppedFindings,
    findings,
    fileReads,
    rounds: explore.rounds
  };
}

/**
  把已批准的那张替换图投影回画布：**先重新过一遍确定性核验**（课程树可能重生成过、模块可能被删了），
  过了才给出「实际画出来的层」与按新归属算的边；没过就只交回一句 stale——画布回落缺省那一张，
  而这一行不删（用户批准过，等他把模块改回来还能续上）。

  边只能从 `filesByUnit` 与 import 出来，用的就是缺省那条同一个 `layerEdges`：
  替换图不开第二条算边的路，模型画的那份里从来没有、也不该有箭头。
*/
export function projectApprovedDraft(input: ArchitectureInput, modelVersion: string, draft: ArchitectureDiagramDraft): { layers: ArchitectureLayer[]; edges: ArchitectureEdge[]; conflicts: ArchitectureDiagramDraft["conflicts"] } | { stale: string } {
  const context = archContext(input, modelVersion);
  const canvas: CanvasUnits = { blocks: context.briefs, units: context.units };
  const verified = verifyArchitectureDraft({ layers: draft.layers, omitted: draft.omitted }, canvas);
  if (!verified.ok || !verified.draft) return { stale: verified.reason ?? "这张替换图引用的格子已经不在现在的树上了" };
  const asLayers: ArchitectureLayer[] = verified.draft.layers.map((layer, index) => ({ id: `layer-${index + 1}`, name: layer.name, duty: layer.duty, moduleIds: layer.nodes }));
  const rendered = applyOverrides(asLayers, { moduleLayer: {} }, canvas.units).layers;
  return { layers: rendered, edges: layerEdges(rendered, context.filesByUnit, input.analysis.graph.imports), conflicts: verified.draft.conflicts };
}
