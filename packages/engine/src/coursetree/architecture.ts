import type { ArchitectureEdge, ArchitectureExternal, ArchitectureLayer, ArchitectureOverrides, ArchitecturePlan, CourseNode, CourseTree, RepositoryAnalysis, RepositoryIndex, RepositoryOverlays } from "@codebase-tutor/shared";
import { groupExternals, isBoundaryMember } from "../depgraph/external-catalog.js";
import { graphFromData, isServedEntrypoint } from "../depgraph/graph.js";
import { classifyFileRoles, fileStructureOf } from "../depgraph/roles.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import type { TutorDatabase } from "../store/database.js";
import { applyRepositoryOverlays } from "../store/overlays.js";
import { annotateModuleTiers } from "./projection.js";
import { layerCacheKey } from "../lib.js";

/**
  架构视图的分层产物（每仓一次，可缓存）。

  这份模块的存在理由是把两类东西**分开算**，一分开就不能再混：
  - **判断题**：分几层、层叫什么、每个模块归哪层 → 交给模型（light 档），错了有人工修正通道；
  - **事实题**：跨层箭头、边界之外有哪些服务/存储 → 只由静态 import 与外部包名词典算，
    模型输出里出现这一类字段一律丢弃。图上每一条箭头都必须能被「哪几个文件的 import」复算出来，
    否则这个产品就在画虚构的东西。

  缓存与降级口径照 `flows/flow.ts`、`coursetree/entry-suggest.ts` 那一套：
  键 = 本层实际输入（模块清单 + 聚合边 + 人工覆盖层），命中不报 usage；
  失败回落静态分层**不落盘**（一次网络抖动不能被永久钉成「这仓只有三层」）。
*/

/** 模块上限：超过就把清单截到这么多并如实说明（一个 200 模块的仓不该指望模型一次读完）。 */
const MAX_MODULES = 80;
/** 进 payload 的聚合边上限（只给模型看方向感，真正的箭头仍是全量算的）。 */
const MAX_PAYLOAD_EDGES = 40;
/** 边界栏最多画这么多行，其余折成「还有 N 类未列出」。 */
const MAX_BOUNDARY_ROWS = 24;

/** 这一层输入的口径版本：提示词、层数约束或 payload 形状变了就翻它（同 `ENTRY_INPUT_VERSION` 的纪律）。 */
const ARCH_INPUT_VERSION = "arch-v1";

interface ModuleFact {
  id: string;
  title: string;
  summary: string;
  /** 结构角色判的档（主干/设施/外围），静态分层直接用它。 */
  tier: "core" | "facility" | "periphery";
  files: number;
  hasServedEntry: boolean;
  /** git 热点里这个仓给这个模块的最高提交数（模型排层时是「哪里在动」的信号）。 */
  hotCommits: number;
}

export interface ArchitectureInput {
  repositoryId: string;
  repositoryPath: string;
  /** 必须是**已现算过 tier** 的那棵树（`annotateModuleTiers` 之后），否则模块没有档可依。 */
  course: CourseTree;
  analysis: RepositoryAnalysis;
  index: RepositoryIndex;
  /** 没配模型 / 预算触顶时传 undefined：直接静态分层并说明原因，不假装是模型判的。 */
  provider?: LlmProvider;
  database?: TutorDatabase;
  overrides?: ArchitectureOverrides;
  /** regenerate 路由用：跳过缓存与「命中即返回」，真问一次。 */
  force?: boolean;
  /**
    读侧（`GET /architecture`）传 false：**没有缓存行就回静态三层，绝不自己发请求**。
    这是「不静默触发花钱动作」在架构视图上的落点——打开画布是个读取动作，
    「这个仓还没判过层」不能顺手变成一笔没人确认的调用；要判，界面上有明确的「重新分层」那一下。
    */
  allowCall?: boolean;
}

export interface ArchitectureResult extends ArchitecturePlan {
  /** 只有真发了请求才带这一格；命中缓存不报用量（与流程层同一口径，同一笔钱不被计两次）。 */
  usage?: LlmUsage;
  /** 被截掉的模块数（>MAX_MODULES 时界面要能说清「这不是全部」）。 */
  omittedModules: number;
  /** 边界栏没画出来的行数（含未识别与语言自带）。 */
  collapsedExternals: number;
}

/** 模块 → 它可见的文件（本节点锚点 + 子孙锚点，去重）：与分级层、GUI 模块清单同一条口径。 */
function moduleFiles(node: CourseNode): string[] {
  const paths: string[] = [];
  const collect = (current: CourseNode): void => {
    current.anchors.forEach((anchor) => paths.push(anchor.path));
    current.children.forEach(collect);
  };
  collect(node);
  return [...new Set(paths)];
}

function moduleNodes(course: CourseTree): CourseNode[] {
  const branch = course.root.children.find((node) => node.id === "modules");
  return branch?.children.filter((node) => node.kind === "module") ?? [];
}

/**
  文件级 import 边 → 模块级聚合边。**边只能从这里来**：模型不参与这一步，
  人工改层也不改边——改的是模块归哪层，箭头自然按新归属重算（这就是「拖动换层不烧钱」的根据）。
  一个文件可能同时出现在多个模块的可见清单里（共享文件是树的结构事实），
  那条边会给每个模块对各算一条：宁可在依据里重复，也不悄悄丢一条真存在的往来。
*/
export function aggregateModuleEdges(filesByModule: Map<string, string[]>, imports: Record<string, string[]>): { pairs: Map<string, { from: string; to: string; weight: number; samples: string[] }>; totalEdges: number } {
  const ownerOf = new Map<string, string[]>();
  for (const [moduleId, files] of filesByModule) for (const file of files) ownerOf.set(file, [...(ownerOf.get(file) ?? []), moduleId]);
  const pairs = new Map<string, { from: string; to: string; weight: number; samples: string[] }>();
  let totalEdges = 0;
  for (const [fromPath, targets] of Object.entries(imports)) {
    const fromModules = ownerOf.get(fromPath);
    if (!fromModules?.length) continue;
    for (const target of targets) {
      totalEdges += 1;
      const toModules = ownerOf.get(target);
      if (!toModules?.length) continue;
      for (const from of fromModules) {
        for (const to of toModules) {
          if (from === to) continue;
          const key = `${from}>${to}`;
          const current = pairs.get(key) ?? { from, to, weight: 0, samples: [] };
          current.weight += 1;
          if (current.samples.length < 3) current.samples.push(`${fromPath} → ${target}`);
          pairs.set(key, current);
        }
      }
    }
  }
  return { pairs, totalEdges };
}

/** 模型/静态两条路共用的收尾：按归层结果算箭头。 */
function layerEdges(layers: ArchitectureLayer[], filesByModule: Map<string, string[]>, imports: Record<string, string[]>): ArchitectureEdge[] {
  const layerOfModule = new Map<string, string>();
  for (const layer of layers) for (const moduleId of layer.moduleIds) layerOfModule.set(moduleId, layer.id);
  const { pairs } = aggregateModuleEdges(filesByModule, imports);
  const byLayer = new Map<string, ArchitectureEdge>();
  for (const edge of pairs.values()) {
    const fromLayer = layerOfModule.get(edge.from);
    const toLayer = layerOfModule.get(edge.to);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;
    const key = `${fromLayer}>${toLayer}`;
    const current = byLayer.get(key) ?? { fromLayer, toLayer, weight: 0, samplePaths: [] };
    current.weight += edge.weight;
    for (const sample of edge.samples) if (current.samplePaths.length < 4 && !current.samplePaths.includes(sample)) current.samplePaths.push(sample);
    byLayer.set(key, current);
  }
  return [...byLayer.values()].sort((left, right) => right.weight - left.weight || left.fromLayer.localeCompare(right.fromLayer));
}

/** 静态兜底：直接用 tier 三档当三层。名字与分级层的显示名一致，切换来源时读者不至于看到两套词。 */
function staticLayers(modules: ModuleFact[]): ArchitectureLayer[] {
  const buckets: { id: string; name: string; duty: string; tier: ModuleFact["tier"] }[] = [
    { id: "layer-1", name: "主干", duty: "对外提供服务与执行主链路的模块", tier: "core" },
    { id: "layer-2", name: "设施", duty: "支撑主干的配置、存储与运行环境", tier: "facility" },
    { id: "layer-3", name: "外围", duty: "末端工具、脚本与测试", tier: "periphery" }
  ];
  return buckets
    .map((bucket) => ({ id: bucket.id, name: bucket.name, duty: bucket.duty, moduleIds: modules.filter((module) => module.tier === bucket.tier).map((module) => module.id) }))
    .filter((layer) => layer.moduleIds.length > 0);
}

/** 模型给的层名可能重复：同名合一行，别画两条并列的「接入层」。 */
function mergeSameName(layers: ArchitectureLayer[]): ArchitectureLayer[] {
  const byName = new Map<string, ArchitectureLayer>();
  for (const layer of layers) {
    const existing = byName.get(layer.name);
    if (!existing) { byName.set(layer.name, { ...layer, moduleIds: [...layer.moduleIds] }); continue; }
    existing.moduleIds.push(...layer.moduleIds.filter((id) => !existing.moduleIds.includes(id)));
    if (!existing.duty && layer.duty) existing.duty = layer.duty;
  }
  return [...byName.values()].map((layer, index) => ({ ...layer, id: `layer-${index + 1}` }));
}

/**
  校验模型输出。**只要有一处不成立就整份作废**（回落静态分层）：
  - 层里出现清单外的模块 id = 模型在造模块（这是红线，不是小瑕疵）；
  - 有模块没归任何层 = 图上一块空白，读者会以为那部分不属于这个系统；
  - 同一模块被塞进两层 = 归属自相矛盾；
  - 出现 `edges` / `files` / `path` 这类字段 = 模型想改事实题。这一条**不整份作废**：
    层归属本身仍可信，按纪律丢掉那些字段、不缓存、在下一次重问时再试（照 `flow.ts` 里「确定性结论才落盘」的分寸）。
*/
function parseLayers(text: string, modules: ModuleFact[]): { layers?: ArchitectureLayer[]; droppedFacts: boolean; reason?: string } {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return { droppedFacts: false, reason: "模型没给出 JSON 对象" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return { droppedFacts: false, reason: "模型的 JSON 解析不出来" };
  }
  const raw = (parsed as { layers?: unknown }).layers;
  if (!Array.isArray(raw) || !raw.length) return { droppedFacts: false, reason: "layers 不是非空数组" };
  /**
    顶层就摆了 `edges` / `files` / `externals` 这类事实字段。它们本来也进不了层（层只认 name/duty/modules），
    但**不能无声吞掉**：模型在试图发明箭头这件事必须留下读数，否则下一次它这么干没人知道。
  */
  const topFacts = ["edges", "files", "paths", "imports", "externals"].filter((key) => (parsed as Record<string, unknown>)[key] !== undefined);
  const droppedAtTop = topFacts.length > 0;
  const known = new Set(modules.map((module) => module.id));
  const assigned = new Map<string, string>();
  const layers: ArchitectureLayer[] = [];
  let droppedFacts = droppedAtTop;
  for (const item of raw) {
    if (!item || typeof item !== "object") return { droppedFacts, reason: "有一层不是对象" };
    const entry = item as Record<string, unknown>;
    // 事实题字段一律不要：出现就丢掉这一格，整份层归属仍可保留
    for (const forbidden of ["edges", "files", "paths", "imports", "externals"]) if (entry[forbidden] !== undefined) { droppedFacts = true; delete entry[forbidden]; }
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 24) : "";
    const duty = typeof entry.duty === "string" ? entry.duty.trim().slice(0, 40) : "";
    const moduleIds = Array.isArray(entry.modules) ? entry.modules.map(String) : Array.isArray(entry.moduleIds) ? entry.moduleIds.map(String) : [];
    if (!name) return { droppedFacts, reason: "有一层没有名字" };
    for (const id of moduleIds) {
      if (!known.has(id)) return { droppedFacts, reason: `模型把不存在的模块「${id.slice(0, 40)}」画进了图` };
      if (assigned.has(id)) return { droppedFacts, reason: `模块「${id.slice(0, 40)}」被同时归进两层` };
      assigned.set(id, name);
    }
    layers.push({ id: `layer-${layers.length + 1}`, name, duty: duty || "（模型没给职责一句话）", moduleIds });
  }
  const missing = modules.filter((module) => !assigned.has(module.id));
  if (missing.length) return { droppedFacts, reason: `有 ${missing.length} 个模块没被归层（如「${missing[0].title.slice(0, 20)}」）` };
  if (layers.length > 8) return { droppedFacts, reason: `模型分了 ${layers.length} 层，超过 8 层上限` };
  return { layers: mergeSameName(layers), droppedFacts };
}

/** 把人工覆盖层落到模型结果上：先改名、再按名字换层。两处都要幂等——同一份覆盖被读很多次不能越改越歪。 */
function applyOverrides(layers: ArchitectureLayer[], overrides: ArchitectureOverrides | undefined): { layers: ArchitectureLayer[]; overriddenLayers: string[] } {
  // 空层不占一栏（模型偶尔给一个「存储层」却一个模块都没归进来）——**没覆盖层时也要滤**，
  // 否则同一次判层会因为「有没有人工改过」画出不同数量的层，读者会以为层是被人删掉的
  if (!overrides) return { layers: layers.filter((layer) => layer.moduleIds.length > 0), overriddenLayers: [] };
  const renames = overrides.layerRenames ?? {};
  const renamed = layers.map((layer) => (renames[layer.name] ? { ...layer, name: renames[layer.name], overridden: true } : layer));
  const overriddenLayers = renamed.filter((layer) => layer.overridden).map((layer) => layer.id);
  const byName = new Map<string, ArchitectureLayer>();
  for (const layer of renamed) byName.set(layer.name, layer);
  const moved = overrides.moduleLayer ?? {};
  for (const [moduleId, targetName] of Object.entries(moved)) {
    const target = byName.get(targetName);
    // 目标层不存在（重生成后模型没再给这个名字）就**不动**它：宁可留在模型判的层里，也不要凭空造一层或丢模块
    if (!target) continue;
    for (const layer of renamed) if (layer !== target && layer.moduleIds.includes(moduleId)) layer.moduleIds = layer.moduleIds.filter((id) => id !== moduleId);
    if (!target.moduleIds.includes(moduleId)) target.moduleIds.push(moduleId);
    if (!overriddenLayers.includes(target.id)) overriddenLayers.push(target.id);
  }
  return { layers: renamed.filter((layer) => layer.moduleIds.length > 0), overriddenLayers };
}

/** 边界之外那一栏：只放词典认出来的（存储/缓存/队列/模型/接口/框架/测试），`other` 与语言自带折成读数。 */
function boundaryRows(externals: Record<string, string[]> | undefined): { rows: ArchitectureExternal[]; collapsed: number } {
  // 旧产物根本没采过这一格：这不是「这个仓不碰外部东西」，是「这份产物还没采」——由调用方在 reason 里说清
  const groups = groupExternals(externals ?? {});
  const rows = groups.filter((group) => isBoundaryMember(group.category)).map((group) => ({
    display: group.display,
    category: group.category,
    usedBy: group.files.length,
    identities: group.identities.slice(0, 4)
  }));
  return { rows: rows.slice(0, MAX_BOUNDARY_ROWS), collapsed: groups.length - Math.min(rows.length, MAX_BOUNDARY_ROWS) };
}

/** 静态兜底的说明句：三档名字与分级层一致，切换来源时读者不至于看到两套词。 */
function tierReason(externalsMissing: boolean): string {
  return `按结构角色分的三层（主干/设施/外围），不是模型判的职责层次${externalsMissing ? "；这份产物还没采外部包名，边界外那一栏是空的" : ""}`;
}

/** 这一层的全部确定性输入：模块清单、聚合边、外部栏、缓存键。判断题与 peek 共用它（两套键构造迟早漂移）。 */
function archContext(input: ArchitectureInput, modelVersion: string) {
  const { repositoryId, course, analysis, index, overrides } = input;
  const servedEntryPaths = new Set((analysis.graph.entrypoints ?? []).filter(isServedEntrypoint).map((anchor) => anchor.path));
  const hotChanges = new Map(index.hotspots.map((hotspot) => [hotspot.path, hotspot.changes]));
  const modules = moduleNodes(course);
  const filesByModule = new Map(modules.map((node) => [node.id, moduleFiles(node)]));
  const facts: ModuleFact[] = modules.map((node) => {
    const files = filesByModule.get(node.id) ?? [];
    return {
      id: node.id,
      title: node.title,
      summary: node.summary.slice(0, 80),
      tier: node.tier ?? "periphery",
      files: files.length,
      hasServedEntry: files.some((path) => servedEntryPaths.has(path)),
      hotCommits: Math.max(0, ...files.map((path) => hotChanges.get(path) ?? 0))
    };
  });
  const truncated = facts.slice(0, MAX_MODULES);
  const omittedModules = Math.max(0, facts.length - truncated.length);
  const { pairs } = aggregateModuleEdges(filesByModule, analysis.graph.imports);
  const moduleEdges = [...pairs.values()]
    .sort((left, right) => right.weight - left.weight || left.from.localeCompare(right.from))
    .slice(0, MAX_PAYLOAD_EDGES)
    .map((edge) => ({ from: edge.from, to: edge.to, weight: edge.weight }));
  const boundary = boundaryRows(analysis.graph.externals);
  const externalsMissing = analysis.graph.externals === undefined;
  /**
    人工修正（改层名 / 挪模块）**不进键**，只进请求。
    为什么单独钉这件事：拖动是这个视图的主交互，而修正本来就是读的时候现叠上去的一层——
    让它翻键等于把「拖一下」变成一次重判请求，模型看不见用户的意见反而要多花钱（改档之后原判还在，叠一遍就出结果）。
    判层的**证据**（模块 id、名字、摘要、结构角色、规模、入口、热度、模块间往来）照样进键：
    模块增删、摘要重烧这些真变化必须重问，人工改名归到证据那一档（改一次翻一次键，但读侧不发请求，要花必须点「重新分层」）。
    */
  const keyPayload = {
    modules: truncated.map((fact) => ({ id: fact.id, title: fact.title, summary: fact.summary, tier: fact.tier, files: fact.files, entry: fact.hasServedEntry, hot: fact.hotCommits })),
    edges: moduleEdges,
    ...(omittedModules ? { omittedModules } : {})
  };
  const payload = {
    modules: keyPayload.modules,
    edges: moduleEdges,
    ...(overrides ? { userOverrides: overrides } : {}),
    ...(omittedModules ? { omittedModules } : {})
  };
  const key = layerCacheKey({ layer: "architecture", repositoryId, contractVersion: ARCH_INPUT_VERSION, modelVersion, payload: keyPayload });
  return { truncated, facts, filesByModule, moduleEdges, boundary, externalsMissing, omittedModules, payload, key };
}

/**
  模块地图那条出口的共同形态：**先现算 tier，再叠人工覆盖层**。`/course` 与架构四个入口都走这里，
  所以「界面看到的分组」和「架构图上谁在哪层」不会各算一套。
  幂等靠 id：覆盖层按模块 id 改名/隐藏/改档，叠两次还是同一份。
  */
export function moduleCourseOf(course: CourseTree, analysis: RepositoryAnalysis, index: RepositoryIndex, overlays: RepositoryOverlays): CourseTree {
  const roles = classifyFileRoles(fileStructureOf(index.files, graphFromData(analysis.graph)));
  return applyRepositoryOverlays(annotateModuleTiers(course, roles, analysis.graph.entrypoints), overlays);
}

/**
  架构这条链上四个入口（读、重新分层、覆盖层校验、Agent 写工具）共用的一份输入。
  为什么收成一处：`/overlays/apply` 以前自己拼了一遍、少叠 `annotateModuleTiers` ⇒ payload 里每个模块的 tier 都成 periphery ⇒
  算出的缓存键和读侧不是同一个 ⇒ peek 找不到判好的那份 ⇒ 校验层名时只认得「外围」，真仓上每一次拖动都被 422 拒掉
  （2026-10-16 浏览器实测 dianping）。这类漂移不靠「记得照抄」防，靠只有一处能构造。
  */
export function architectureInputOf(input: { repositoryId: string; repositoryPath: string; course: CourseTree; analysis: RepositoryAnalysis; index: RepositoryIndex; database?: TutorDatabase; overlays: RepositoryOverlays }): ArchitectureInput {
  const { repositoryId, repositoryPath, analysis, index, database, overlays } = input;
  return { repositoryId, repositoryPath, analysis, index, database, course: moduleCourseOf(input.course, analysis, index, overlays), overrides: overlays.architecture };
}

/**
  只查缓存、**绝不发请求**的读侧。副作用工具要先知道「图上现在有哪几层」才能校验层名，
  而为了校验去烧一发模型是不可接受的（用户问一句「把 X 挪到 Y 层」，代价不该是一笔重判的钱）。
  没缓存行就回 undefined：调用方按「现在只有静态三层可改」处理，并如实告诉模型。
*/
export function peekCachedArchitecture(input: ArchitectureInput & { provider: LlmProvider }): { plan?: ArchitecturePlan; layers: string[] } {
  const context = archContext(input, input.provider.modelVersion);
  const stored = input.database?.getLayerCache<ArchitecturePlan>(context.key);
  const plan = stored?.value?.layers?.length ? stored.value : undefined;
  const layered = plan ? applyOverrides(plan.layers, input.overrides) : { layers: staticLayers(context.truncated), overriddenLayers: [] };
  return { ...(plan ? { plan } : {}), layers: layered.layers.map((layer) => layer.name) };
}

export async function generateArchitectureCached(input: ArchitectureInput): Promise<ArchitectureResult> {
  const { repositoryId, analysis, provider, database, overrides } = input;
  if (!provider) {
    const context = archContext(input, "none");
    const layered = applyOverrides(staticLayers(context.truncated), overrides);
    return {
      repositoryId, layers: layered.layers, edges: layerEdges(layered.layers, context.filesByModule, analysis.graph.imports),
      externals: context.boundary.rows, source: "static",
      reason: `未配置模型：${tierReason(context.externalsMissing)}`,
      overriddenLayers: layered.overriddenLayers, generatedAt: new Date().toISOString(), basedOnVersionStamp: analysis.versionStamp,
      omittedModules: context.omittedModules, collapsedExternals: context.boundary.collapsed,
      ...(context.externalsMissing ? { externalsNote: "这份产物还没采外部包名（重新分析后才会有）" } : {})
    };
  }
  const { truncated, filesByModule, boundary, externalsMissing, omittedModules, payload, key } = archContext(input, provider.modelVersion);
  /** 静态兜底的一份产物（不落盘）：与成功路径同一个形状，只差 source/reason 两格。 */
  const buildStatic = (layers: ArchitectureLayer[], reason: string): ArchitectureResult => ({
    repositoryId,
    layers,
    edges: layerEdges(layers, filesByModule, analysis.graph.imports),
    externals: boundary.rows,
    source: "static",
    reason,
    overriddenLayers: [],
    generatedAt: new Date().toISOString(),
    basedOnVersionStamp: analysis.versionStamp,
    omittedModules,
    collapsedExternals: boundary.collapsed,
    ...(externalsMissing ? { externalsNote: "这份产物还没采外部包名（重新分析后才会有）" } : {})
  });
  if (!input.force) {
    const stored = database?.getLayerCache<ArchitecturePlan>(key);
    if (stored && stored.value.layers?.length && (stored.value.source === "llm" || stored.value.source === "static")) {
      const layered = applyOverrides(stored.value.layers, overrides);
      return { ...stored.value, repositoryId, layers: layered.layers, edges: layerEdges(layered.layers, filesByModule, analysis.graph.imports), overriddenLayers: layered.overriddenLayers, externals: boundary.rows, collapsedExternals: boundary.collapsed, omittedModules, usage: undefined };
    }
  }
  /** 读侧（`allowCall: false`）没缓存行就到此为止：给静态三层，不发请求、不落盘。 */
  if (input.allowCall === false) {
    const untouched = applyOverrides(staticLayers(truncated), overrides);
    return { ...buildStatic(untouched.layers, `还没判过层：打开画布不会调用模型，点「重新分层」才花这一发。${tierReason(externalsMissing)}`), overriddenLayers: untouched.overriddenLayers };
  }
  try {
    const response = await provider.complete({
      system: [
        "你是代码教学产品的架构分层器。给定一个仓库的模块清单（含每个模块的结构角色、可见文件数、是否含对外服务入口、git 热度）",
        "与模块之间的 import 往来计数，把它们分进 3~5 个**职责层次**（典型形态：接入 / 编排 / 核心能力 / 数据访问），自上而下排列。",
        "只判这三件事：分几层、每层叫什么、每个模块归哪层。每个模块必须且只能出现一次。",
        "层名用这个仓库自己的语言（业务名词优先，别一律写成「应用层/领域层」这种模板话）；每层给一句话职责，不超过 40 字。",
        "箭头、文件路径、外部依赖由程序自己算：**不许输出这些字段**，输出了会被丢弃。",
        "严格输出 JSON：{\"layers\":[{\"name\":\"层名\",\"duty\":\"一句话职责\",\"modules\":[\"模块 id 原样返回\"]}]}，不要输出其他文字。"
      ].join(""),
      user: JSON.stringify(payload),
      maxTokens: 1_200,
      temperature: 0.2,
      scene: "map.architecture"
    });
    const parsed = parseLayers(response.text, truncated);
    if (!parsed.layers) {
      // 判不出来就回落静态三层并说清原因；**不落盘**——同一份输入下次还要再问
      const fallback = applyOverrides(staticLayers(truncated), overrides);
      return { ...buildStatic(fallback.layers, `分层判断没采信（${parsed.reason ?? "输出不合法"}），退回${tierReason(externalsMissing)}`), overriddenLayers: fallback.overriddenLayers, usage: response.usage };
    }
    const layered = applyOverrides(parsed.layers, overrides);
    /**
      落盘的是模型的**原判**（没叠人工修正）：修正每次读的时候现叠一次。
      键里不含修正，所以同一份原判会被反复读到——把修正烤进缓存等于下一次读叠第二遍，
      那时「接入→入口层」这类改名已经不成立，界面上的层会开始对不上号。
      */
    const plan: ArchitecturePlan = {
      repositoryId,
      layers: parsed.layers,
      edges: layerEdges(parsed.layers, filesByModule, analysis.graph.imports),
      externals: boundary.rows,
      source: "llm",
      ...(parsed.droppedFacts ? { reason: "模型额外给了边或文件字段，已丢弃（层归属仍按它判的结果）" } : {}),
      // 旧产物没采过外部包名：那一栏是空的，但**不等于**「这个系统不碰任何外部服务」，得说出来
      ...(externalsMissing && !boundary.rows.length ? { externalsNote: "这份产物还没采外部包名（重新分析后才会有）" } : {}),
      overriddenLayers: layered.overriddenLayers,
      generatedAt: new Date().toISOString(),
      basedOnVersionStamp: analysis.versionStamp
    };
    // 模型自己说「边/文件字段被我丢掉了」的那一次不落盘：payload 与产出不同构，留着下次重问才收敛
    if (!parsed.droppedFacts) database?.putLayerCache(key, plan);
    return { ...plan, layers: layered.layers, edges: layerEdges(layered.layers, filesByModule, analysis.graph.imports), omittedModules, collapsedExternals: boundary.collapsed, usage: response.usage };
  } catch (error) {
    const fallback = applyOverrides(staticLayers(truncated), overrides);
    return { ...buildStatic(fallback.layers, `分层调用没成功（${error instanceof Error ? error.message.slice(0, 80) : "未知错误"}），退回${tierReason(externalsMissing)}`), overriddenLayers: fallback.overriddenLayers };
  }
}

