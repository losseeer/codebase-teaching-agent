import type { ArchitectureBlockBrief, ArchitectureBlockRole, ArchitectureEdge, ArchitectureExternal, ArchitectureLayer, ArchitectureOverrideLoss, ArchitectureOverrides, ArchitecturePlan, CourseNode, CourseTier, CourseTree, RepositoryAnalysis, RepositoryIndex, RepositoryOverlays } from "@codebase-tutor/shared";
import { groupExternals, isBoundaryMember } from "../depgraph/external-catalog.js";
import { graphFromData, isServedEntrypoint } from "../depgraph/graph.js";
import { classifyFileRoles, fileStructureOf } from "../depgraph/roles.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import type { TutorDatabase } from "../store/database.js";
import { applyRepositoryOverlays } from "../store/overlays.js";
import { annotateModuleTiers } from "./projection.js";
import { defineAnalysisStep } from "../analysis-step.js";

/**
  架构视图的分层产物（每仓一次，可缓存）。

  这个模块的存在理由是把两类东西分开算，一分开就不能再混：
  - 判断题：分几层、层叫什么、每个模块归哪层 → 交给模型（light 档），错了有人工修正通道；
  - 事实题：跨层箭头、边界之外有哪些服务/存储 → 只由静态 import 与外部包名词典算，
    模型输出里出现这一类字段一律丢弃。图上每一条箭头都必须能被「哪几个文件的 import」复算出来。

  缓存与降级口径照 `flows/flow.ts`、`coursetree/entry-suggest.ts` 那一套：
  键 = 本层实际输入（节点清单 + 聚合边），人工覆盖层只进请求不进键，命中不报 usage；
  判不出来就报不可用并不落盘（一次网络抖动不能被永久钉成「这仓判过了」）。
*/

/** 模块上限：超过就把清单截到这么多并如实说明（一个 200 模块的仓不该指望模型一次读完）。 */
const MAX_MODULES = 80;
/** 进 payload 的聚合边上限（只给模型看方向感，真正的箭头仍是全量算的）。 */
const MAX_PAYLOAD_EDGES = 40;
/** 边界栏最多画这么多行，其余折成「还有 N 类未列出」。 */
const MAX_BOUNDARY_ROWS = 24;
/** 模块压缩流水线的三条阈值：架构图里没用的模块直接删除，能合的就合，剩下的才折叠。 */
const MERGE_MAX_FILES = 2;
const MERGE_MIN_MEMBERS = 2;
const MERGE_MAX_MEMBERS = 4;
/** 父目录至少这么深才允许合并：本仓 `packages` 下十个包根并成一块是灾难，`.../src/depgraph` 的兄弟目录并起来才叫中间模块。 */
const MERGE_MIN_PARENT_DEPTH = 2;

/**
  判层这一步发给模型的固定文案。层名要通用职责名：稳定、跨仓可比，
  教学信息交给每层那句 duty 与层内节点清单去承载。
  覆盖层按层名匹配，名字越花、重判后对不上的概率越高，用户改过的修正会无声落空。
*/
const ARCHITECTURE_SYSTEM_PROMPT = [
  "你是代码教学产品的架构分层器。给定一个仓库的架构节点清单：每个节点带结构角色（entry=含对外服务入口、core=入口可达的主链路、shared=被多处引用的底座、support=其余）、",
  "可见文件数、由几个模块合成（parts）、是否含对外服务入口与 git 热度，再带节点之间的 import 往来计数。",
  "把它们分进 3~5 个**职责层次**（典型形态：接入 / 编排 / 核心能力 / 数据访问），自上而下排列。",
  "只判这三件事：分几层、每层叫什么、每个节点归哪层。每个节点必须且只能出现一次，id 原样返回。",
  "层名用软件工程里读得懂的职责名（接入 / 应用编排 / 核心能力 / 数据访问 / 支撑设施这一档），每层再给一句这个仓库自己的职责说明，不超过 40 字。",
  "箭头、文件路径、外部依赖由程序自己算：**不许输出这些字段**，输出了会被丢弃。",
  "严格输出 JSON：{\"layers\":[{\"name\":\"层名\",\"duty\":\"一句话职责\",\"modules\":[\"节点 id\"]}]}，不要输出其他文字。"
].join("");

/**
  这一层输入的口径版本：层数约束或 payload 形状变了就翻它。
  提示词文案改了会由守卫测试拦下（见 `analysis-step.ts`），届时二选一：翻版本让旧判层作废，
  或显式重写锁（`pnpm analysis:lock`）表示「这次改动不值得重判一遍」——不许无声通过。
  版本翻掉后画布显示「分层不可用」，要恢复模型分层得点一次「重新生成分层」。
*/
const ARCHITECTURE_STEP = defineAnalysisStep({ layer: "architecture", contractVersion: "arch-v2", prompts: [ARCHITECTURE_SYSTEM_PROMPT] });

interface ModuleFact {
  id: string;
  title: string;
  summary: string;
  /** 结构角色判的档（主链路/基础设施/外围）：只作为证据送进模型，界面上不拿它伪装成分层。 */
  tier: CourseTier;
  files: number;
  hasServedEntry: boolean;
  /** git 热点里这个仓给这个模块的最高提交数（模型排层时是「哪里在动」的信号）。 */
  hotCommits: number;
  /** 图上这个节点承担的角色（确定性算出，模型只看不用）。 */
  role: ArchitectureBlockRole;
  /** 组合节点里几个原子模块；原子块是 1。让模型知道这个节点是一组东西而不是一个目录。 */
  parts: number;
}

export interface ArchitectureInput {
  repositoryId: string;
  repositoryPath: string;
  /** 必须是已实时计算过 tier 的那棵树（`annotateModuleTiers` 之后），否则模块没有档可依。 */
  course: CourseTree;
  analysis: RepositoryAnalysis;
  index: RepositoryIndex;
  /** 没配模型 / 预算已达上限时传 undefined：分层直接判不可用，不编一份看着像答案的节点。 */
  provider?: LlmProvider;
  database?: TutorDatabase;
  overrides?: ArchitectureOverrides;
  /** regenerate 路由用：跳过缓存与「命中即返回」，真问一次。 */
  force?: boolean;
  /**
    读侧（`GET /architecture`）传 false：没有缓存行就回「分层不可用」，绝不自己发请求。
    打开画布是个读取动作，「这个仓还没判过层」不能顺带变成一笔没人确认的调用；
    要判，界面上有明确的「重新生成分层」那一下。
  */
  allowCall?: boolean;
}

export interface ArchitectureResult extends ArchitecturePlan {
  /** 只有真发了请求才带这个节点；命中缓存不报用量（与流程层同一口径，同一笔钱不被计两次）。 */
  usage?: LlmUsage;
  /** 被截掉的模块数（>MAX_MODULES 时界面要能说清「这不是全部」）。 */
  omittedModules: number;
  /** 边界栏没画出来的行数（含未识别与语言自带）。 */
  collapsedExternals: number;
  // `lostOverrides` 声明在 shared 的 ArchitecturePlan 上：它是读时实时计算的失效读数，不写进缓存
}

/**
  模块 → 它可见的文件（本节点锚点 + 子孙锚点，去重）：与分级层、GUI 模块清单同一条口径。
  导出给画图工作区复用（`diagram/set-diagram.ts` 核一条边的依据用的就是这张表）——
  「这个模块包含哪些文件」只能有一套算法，否则图上两个节点说的是两回事。
*/
export function moduleFiles(node: CourseNode): string[] {
  const paths: string[] = [];
  const collect = (current: CourseNode): void => {
    current.anchors.forEach((anchor) => paths.push(anchor.path));
    current.children.forEach(collect);
  };
  collect(node);
  return [...new Set(paths)];
}

/** 课程树「模块地图」那一支的全部模块节点（与画布上 `kind:"module"` 的节点同一份 id 池）。 */
export function moduleNodes(course: CourseTree): CourseNode[] {
  const branch = course.root.children.find((node) => node.id === "modules");
  return branch?.children.filter((node) => node.kind === "module") ?? [];
}

/**
  文件级 import 边 → 模块级聚合边。边只能从这里来：模型不参与这一步，
  人工改层也不改边——改的是节点归哪层，箭头自然按新归属重算（所以挪一下不产生重判费用）。
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

/** 归层结果定了之后才算箭头：模型不许发明边，边只能从这张表出来（画布虽不画，产物与审计仍要用）。 */
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
  校验模型输出。只要有一处不成立就整份作废（判不可用，不落盘）：
  - 层里出现清单外的模块 id = 模型在造模块（这是红线，不是小瑕疵）；
  - 有模块没归任何层 = 图上一块空白，读者会以为那部分不属于这个系统；
  - 同一模块被写入两层 = 归属自相矛盾；
  - 出现 `edges` / `files` / `path` 这类字段 = 模型想改事实题。这一条不整份作废：
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
    但不能无声丢弃：模型在试图发明箭头这件事必须留下读数，否则下一次它这么干没人知道。
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
    // 事实题字段一律不要：出现就丢掉这个节点，整份层归属仍可保留
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

/** 边界之外那一栏：只放词典认出来的（存储/缓存/队列/模型/接口/框架/测试），`other` 与语言自带折成读数。 */
function boundaryRows(externals: Record<string, string[]> | undefined): { rows: ArchitectureExternal[]; collapsed: number } {
  // 旧产物根本没采过这个节点：这不是「这个仓不碰外部东西」，是「这份产物还没采」——由调用方在 reason 里说清
  const groups = groupExternals(externals ?? {});
  const rows = groups.filter((group) => isBoundaryMember(group.category)).map((group) => ({
    display: group.display,
    category: group.category,
    usedBy: group.files.length,
    identities: group.identities.slice(0, 4)
  }));
  return { rows: rows.slice(0, MAX_BOUNDARY_ROWS), collapsed: groups.length - Math.min(rows.length, MAX_BOUNDARY_ROWS) };
}

/** 模块在架构图里的角色：`side` 只在判据内部出现，它不进图、也不进 shared 的节点形状。 */
type ModuleRole = ArchitectureBlockRole | "side";

export interface ArchitectureBlock {
  /** 原子块就是模块 id；组合节点是 `arch:<目录>:<角色>`——它不在课程树里，点开要靠 members 回到原子模块。 */
  id: string;
  title: string;
  summary: string;
  tier: CourseTier;
  files: string[];
  members: string[];
  role: ArchitectureBlockRole;
}

/**
  组合节点的标题：成员名整段拼到 24 字为止，装不下的用「等」收尾。
  不用父目录末段（末段常常只是包根名，读者看不出里面是什么），也不截半句话——
  一个节点的名字读到一半断了，比它长一点更糟。
*/
function joinedTitle(members: CourseNode[]): string {
  const parts: string[] = [];
  for (const node of members) {
    if (parts.length && parts.join("、").length + node.title.length + 1 > 24) break;
    parts.push(node.title);
  }
  return parts.length === members.length ? parts.join("、") : `${parts.join("、")} 等`;
}

/**
  架构图的模块集合 = 原子模块经「隐藏孤立节点 → 同父合并」压缩后的块集合。
  放在判层之前而不是画完再藏：孤立节点连进载荷都是多付 token，而组合节点的粒度必须先让模型看见，
  否则模型判的是一堆碎片、读者看到的是少数几个块，两套口径迟早打架。

  可达性沿 import ∪ 调用 ∪ 接口实现三条边算。最后那条不能省：Spring 的控制器只 import 接口，
  `service/impl` 与 `mapper` 在纯 import 图上永远不可达，只按 import 判就会把全仓最核心的实现当孤立节点删掉。

  这份集合不许读人工覆盖层：读了就等于「挪一下模块」会改变节点清单，进而翻掉缓存键——
  覆盖层不进键是这一层不花钱的前提（见 `archContext`）。修正怎么落见 `applyOverrides`。
*/
export function architectureBlocks(course: CourseTree, analysis: RepositoryAnalysis): { blocks: ArchitectureBlock[]; sideModules: number } {
  const modules = moduleNodes(course);
  const filesOf = new Map(modules.map((node) => [node.id, moduleFiles(node)]));
  const servedEntryPaths = new Set((analysis.graph.entrypoints ?? []).filter(isServedEntrypoint).map((anchor) => anchor.path));
  /**
    可达性的种子用全部入口候选，不只词典认出来的服务入口：TS 侧的规则只产出「conventional entrypoint」
    （`server.ts` / `main.tsx` 这一档），只拿 served 当种子会把整个仓判成走不到、把最该看的那个节点当孤立节点删掉。
    `entry` 这一档角色仍只认 served——「含对外服务入口」这句话不能因为一个 index 文件就说出口。
   */
  const entrySeeds = new Set((analysis.graph.entrypoints ?? []).map((anchor) => anchor.path));
  const ownerOf = new Map<string, string>();
  for (const node of modules) for (const file of filesOf.get(node.id) ?? []) if (!ownerOf.has(file)) ownerOf.set(file, node.id);
  const out = new Map<string, Set<string>>();
  const inCount = new Map<string, Set<string>>();
  const link = (from: string | undefined, to: string | undefined): void => {
    if (!from || !to || from === to) return;
    if (!out.has(from)) out.set(from, new Set());
    if (!inCount.has(to)) inCount.set(to, new Set());
    out.get(from)!.add(to);
    inCount.get(to)!.add(from);
  };
  for (const [fromPath, targets] of Object.entries(analysis.graph.imports ?? {})) {
    const from = ownerOf.get(fromPath);
    if (!from) continue;
    for (const target of targets) link(from, ownerOf.get(target));
  }
  for (const call of analysis.graph.calls ?? []) link(ownerOf.get(call.callerPath), ownerOf.get(call.calleePath));
  // 接口 → 实现：运行时才接上的那条边，判「谁是主干」全靠它
  for (const edge of analysis.graph.dispatch ?? []) if (edge.kind === "implements") link(ownerOf.get(edge.supertypePath), ownerOf.get(edge.subtypePath));
  const seeds = modules.filter((node) => (filesOf.get(node.id) ?? []).some((path) => entrySeeds.has(path))).map((node) => node.id);
  const reach = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    for (const next of out.get(queue.shift()!) ?? []) if (!reach.has(next)) { reach.add(next); queue.push(next); }
  }
  /** 判据按顺序命中：入口 → 孤立节点（无入边且入口走不到）→ 底座（被 ≥4 处引用而自己最多引 3 处）→ 主干 → 支撑。 */
  const roleOf = (node: CourseNode): ModuleRole => {
    const files = filesOf.get(node.id) ?? [];
    if (files.some((path) => servedEntryPaths.has(path))) return "entry";
    if (!(inCount.get(node.id)?.size) && !reach.has(node.id)) return "side";
    if ((inCount.get(node.id)?.size ?? 0) >= 4 && (out.get(node.id)?.size ?? 0) <= 3) return "shared";
    return reach.has(node.id) ? "core" : "support";
  };
  const parentOf = (node: CourseNode): string => node.id.replace(/^module:/, "").split("/").slice(0, -1).join("/");
  const make = (id: string, members: CourseNode[], role: ArchitectureBlockRole): ArchitectureBlock => ({
    id,
    title: members.length === 1 ? members[0].title : joinedTitle(members),
    summary: members.map((node) => node.summary).join("；").slice(0, 80),
    tier: (["core", "facility", "periphery"] as CourseTier[]).find((tier) => members.some((node) => (node.tier ?? "periphery") === tier)) ?? "periphery",
    files: [...new Set(members.flatMap((node) => filesOf.get(node.id) ?? []))],
    members: members.map((node) => node.id),
    role
  });
  const kept = modules.filter((node) => roleOf(node) !== "side");
  const groups = new Map<string, CourseNode[]>();
  for (const node of kept) {
    const parent = parentOf(node);
    if (parent.split("/").filter(Boolean).length < MERGE_MIN_PARENT_DEPTH || (filesOf.get(node.id) ?? []).length > MERGE_MAX_FILES) continue;
    const key = `${parent}|${roleOf(node)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(node);
  }
  /** 够格的组才真的合并：成员数不在 2~4 之间就不合（1 个是原地踏步，5 个以上会造出一个比原子模块还难读的巨型块）。 */
  const eligible = new Map<string, { key: string; members: CourseNode[] }>();
  for (const [key, members] of groups) {
    if (members.length < MERGE_MIN_MEMBERS || members.length > MERGE_MAX_MEMBERS) continue;
    for (const node of members) eligible.set(node.id, { key, members });
  }
  // 按树里的原顺序出块（组合节点落在它第一个成员的位置）：MAX_MODULES 截断时这才是「前 80 个」而不是「先所有组合节点」
  const blocks: ArchitectureBlock[] = [];
  const emitted = new Set<string>();
  for (const node of kept) {
    const group = eligible.get(node.id);
    if (!group) {
      blocks.push(make(node.id, [node], roleOf(node) as ArchitectureBlockRole));
      continue;
    }
    if (emitted.has(group.key)) continue;
    emitted.add(group.key);
    const [parent, role] = group.key.split("|");
    // id 带角色：同一父目录下不同角色的两组若都够合并条件，不带角色就会撞出两个同名块
    blocks.push(make(`arch:${parent}:${role}`, group.members, role as ArchitectureBlockRole));
  }
  return { blocks, sideModules: modules.length - kept.length };
}

/** 节点与成员的对照表：`applyOverrides` 拆块、`layerEdges` 算往来都靠它，界面拿到的是同一份 id。 */
export interface ArchitectureUnits {
  /** 节点 id → 成员模块 id（原子块就是只有自己一个）。 */
  blocks: Map<string, string[]>;
  /** 课程树里全部原子模块 id（含被藏起来的孤立节点）：用来分辨「这个修正指的模块只是被藏了」与「它已经不在这棵树里」。 */
  members: Set<string>;
}

/**
  把人工修正落到判层结果上，顺带处理组合节点被拆开这种情况。
  覆盖层存的可能是节点 id（整块走），也可能是块里的某个原子模块 id（只走自己），
  所以先在成员层面定归属再重新聚块：挪走一个成员不该让兄弟跟着动，也不该让同一个文件在图上出现两次。

  聚回来的规则只有一条：一个块的成员全都在同一层时它才继续是一块，否则拆成单个节点。
  宁可在图上多几个小块，也不造一个「id 指向的成员和画出来的不是一回事」的假块。
  被藏起来的孤立节点只要有人工修正点名，就作为单独节点回到图上——这是「agent 说这个不该藏」唯一的出口。

  `lost` 是这次没能落地的修正：覆盖层按层名字符串匹配，重判之后模型换了叫法
  （五层判成四层、"数据访问"并进"支撑"），目标名就找不到；id 不在树上也是找不到。
  找不到仍然不动它（宁可留在模型判的层里，也不凭空造一层），但必须记下来——
  否则用户改过几次、下次重判全落空而界面上看不出来。
*/
export function applyOverrides(layers: ArchitectureLayer[], overrides: ArchitectureOverrides | undefined, units: ArchitectureUnits): { layers: ArchitectureLayer[]; overriddenUnits: string[]; lost: ArchitectureOverrideLoss[] } {
  const clone = layers.map((layer) => ({ ...layer, moduleIds: [...layer.moduleIds] }));
  // 空层不占一栏（模型偶尔给一个「存储层」却一个模块都没归进来）——没有覆盖层时也要滤，
  // 否则同一次判层会因为「有没有人工改过」画出不同数量的层，读者会以为层是被人删掉的
  if (!overrides) return { layers: clone.filter((layer) => layer.moduleIds.length > 0), overriddenUnits: [], lost: [] };
  const renames = overrides.layerRenames ?? {};
  const lost: ArchitectureOverrideLoss[] = [];
  for (const from of Object.keys(renames)) if (!layers.some((layer) => layer.name === from)) lost.push({ kind: "rename_layer", from });
  const renamed = clone.map((layer) => (renames[layer.name] ? { ...layer, name: renames[layer.name], overridden: true } : layer));
  const hostOf = new Map<string, string>();
  for (const [id, members] of units.blocks) for (const member of members) hostOf.set(member, id);
  /** 块 id 先摊到成员上：这样「整个节点挪走」与「只挪一个成员」是同一套写法。 */
  const layerOfMember = new Map<string, string>();
  for (const layer of renamed) for (const id of layer.moduleIds) for (const member of units.blocks.get(id) ?? [id]) layerOfMember.set(member, layer.name);
  const names = new Set(renamed.map((layer) => layer.name));
  /** 人工点名挪过的成员：只有这些节点该带「动过」的标记，收留它们的那一层不算被改过。 */
  const movedMembers = new Set<string>();
  for (const [id, target] of Object.entries(overrides.moduleLayer ?? {})) {
    const members = units.blocks.get(id) ?? [id];
    if (!names.has(target) || !members.some((member) => units.members.has(member))) { lost.push({ kind: "move_module", module: id, layer: target }); continue; }
    for (const member of members) { layerOfMember.set(member, target); movedMembers.add(member); }
  }
  const hostByName = new Map<string, ArchitectureLayer>();
  for (const layer of renamed) if (!hostByName.has(layer.name)) hostByName.set(layer.name, layer);
  const unitsByLayer = new Map<string, string[]>();
  const overriddenUnits: string[] = [];
  for (const [member, name] of layerOfMember) {
    const host = hostOf.get(member);
    const siblings = host ? units.blocks.get(host)! : [member];
    // 整块同层 → 还是那块；被拆开 → 成员各自成块（id 就是模块 id，界面按课程树取名字）
    const unit = siblings.length > 1 && siblings.every((sibling) => layerOfMember.get(sibling) === name) ? host! : member;
    const list = unitsByLayer.get(name) ?? [];
    if (!list.includes(unit)) list.push(unit);
    unitsByLayer.set(name, list);
    if (movedMembers.has(member) && !overriddenUnits.includes(unit)) overriddenUnits.push(unit);
  }
  const layersOut = [...hostByName.values()].map((layer) => ({ ...layer, moduleIds: unitsByLayer.get(layer.name) ?? [] }));
  return { layers: layersOut.filter((layer) => layer.moduleIds.length > 0), overriddenUnits, lost };
}


/** 这一层的全部确定性输入：节点清单、聚合边、外部栏、缓存键。判断题与 peek 共用它（两套键构造迟早漂移）。 */
export interface ArchitectureContext {
  truncated: ModuleFact[];
  filesByUnit: Map<string, string[]>;
  briefs: ArchitectureBlockBrief[];
  sideModules: number;
  boundary: { rows: ArchitectureExternal[]; collapsed: number };
  externalsMissing: boolean;
  omittedModules: number;
  payload: unknown;
  key: string;
  units: ArchitectureUnits;
}

function archContext(input: ArchitectureInput, modelVersion: string) {
  const { repositoryId, course, analysis, index, overrides } = input;
  const servedEntryPaths = new Set((analysis.graph.entrypoints ?? []).filter(isServedEntrypoint).map((anchor) => anchor.path));
  const hotChanges = new Map(index.hotspots.map((hotspot) => [hotspot.path, hotspot.changes]));
  const modules = moduleNodes(course);
  const { blocks, sideModules } = architectureBlocks(course, analysis);
  const facts: ModuleFact[] = blocks.map((block) => ({
    id: block.id,
    title: block.title,
    summary: block.summary,
    tier: block.tier,
    files: block.files.length,
    hasServedEntry: block.files.some((path) => servedEntryPaths.has(path)),
    hotCommits: Math.max(0, ...block.files.map((path) => hotChanges.get(path) ?? 0)),
    role: block.role,
    parts: block.members.length
  }));
  const truncated = facts.slice(0, MAX_MODULES);
  const omittedModules = Math.max(0, facts.length - truncated.length);
  /** 给模型的往来计数只按节点算：一个文件的原子模块 id 也在下面那张表里，两张一起送进 payload 会把同一条边数两遍。 */
  const filesByBlock = new Map(blocks.map((block) => [block.id, block.files]));
  const { pairs } = aggregateModuleEdges(filesByBlock, analysis.graph.imports);
  const moduleEdges = [...pairs.values()]
    .sort((left, right) => right.weight - left.weight || left.from.localeCompare(right.from))
    .slice(0, MAX_PAYLOAD_EDGES)
    .map((edge) => ({ from: edge.from, to: edge.to, weight: edge.weight }));
  /**
    画图上箭头的表多一层原子模块 id：人工修正能把组合节点里的一个成员单独挪走，那时层里出现的是模块 id，
    只有节点 id 的表就查不到它的文件。代价是同一条文件级边可能在块与成员两边各算一次——
    只在「块被拆开」那一档让权重偏高，而箭头早已不上画布（依据仍在产物里可查）。
    */
  const filesByUnit = new Map<string, string[]>(modules.map((node) => [node.id, moduleFiles(node)]));
  for (const block of blocks) filesByUnit.set(block.id, block.files);
  const boundary = boundaryRows(analysis.graph.externals);
  const externalsMissing = analysis.graph.externals === undefined;
  /**
    人工修正（改层名 / 挪模块）不进键，只进请求。
    修正本来就是读的时候实时叠加上去的一层：让它翻键等于把「挪一下」变成一次重判请求，
    模型看不见用户的意见反而要多花钱（改档之后原判还在，叠一遍就出结果）。
    判层的证据（节点 id、名字、摘要、结构角色与档位、规模、入口、热度、节点间往来）照样进键：
    节点增删、摘要重算这些真变化必须重问；人工改名归到证据那一档（改一次翻一次键，
    但读侧不发请求，要花必须点「重新生成分层」）。
   */
  const keyPayload = {
    modules: truncated.map((fact) => ({ id: fact.id, title: fact.title, summary: fact.summary, tier: fact.tier, role: fact.role, files: fact.files, parts: fact.parts, entry: fact.hasServedEntry, hot: fact.hotCommits })),
    edges: moduleEdges,
    ...(omittedModules ? { omittedModules } : {})
  };
  const payload = {
    modules: keyPayload.modules,
    edges: moduleEdges,
    ...(overrides ? { userOverrides: overrides } : {}),
    ...(omittedModules ? { omittedModules } : {})
  };
  const key = ARCHITECTURE_STEP.cacheKey({ repositoryId, modelVersion, payload: keyPayload });
  const units: ArchitectureUnits = {
    blocks: new Map(blocks.map((block) => [block.id, block.members])),
    members: new Set(modules.map((node) => node.id))
  };
  const briefs: ArchitectureBlockBrief[] = blocks.map((block) => ({ id: block.id, title: block.title, members: block.members, role: block.role }));
  return { truncated, filesByUnit, moduleEdges, units, briefs, sideModules, boundary, externalsMissing, omittedModules, payload, key };
}

/**
  模块地图那条出口的共同形态：先实时计算 tier，再叠人工覆盖层。`/course` 与架构四个入口都走这里，
  所以「界面看到的分组」和「架构图上谁在哪层」不会各算一套。
  幂等靠 id：覆盖层按模块 id 改名/隐藏/改档，叠两次还是同一份。
*/
export function moduleCourseOf(course: CourseTree, analysis: RepositoryAnalysis, index: RepositoryIndex, overlays: RepositoryOverlays): CourseTree {
  const roles = classifyFileRoles(fileStructureOf(index.files, graphFromData(analysis.graph)));
  return applyRepositoryOverlays(annotateModuleTiers(course, roles, analysis.graph.entrypoints), overlays);
}

/**
  架构这条链上四个入口（读、重新生成分层、覆盖层校验、Agent 写工具）共用的一份输入。
  只能有一处构造：少叠 `annotateModuleTiers` 会让每个模块的 tier 都成 periphery，算出的缓存键和读侧不是同一个，
  校验层名时只认得「外围」，真仓上每一次拖动都会被 422 拒掉。
*/
export function architectureInputOf(input: { repositoryId: string; repositoryPath: string; course: CourseTree; analysis: RepositoryAnalysis; index: RepositoryIndex; database?: TutorDatabase; overlays: RepositoryOverlays }): ArchitectureInput {
  const { repositoryId, repositoryPath, analysis, index, database, overlays } = input;
  return { repositoryId, repositoryPath, analysis, index, database, course: moduleCourseOf(input.course, analysis, index, overlays), overrides: overlays.architecture };
}

/**
  只查缓存、绝不发请求的读侧。副作用工具要先知道「图上现在有哪几层」才能校验层名，
  而为了校验去重判一发模型是不可接受的（用户问一句「把 X 挪到 Y 层」，代价不该是一笔重判的钱）。
  没缓存行就回空层名：调用方按「现在没有分层可改」处理，并如实告诉模型。

  `layout` 与 `lost` 是给 agent 那份「架构现场」用的：现在每层里画了哪些节点、哪几条人工修正这次没接上。
  与界面横幅同源（都是 `applyOverrides` 一次算出来的），免得对话里说「这条修正还在」而图上没有。
*/
export function peekCachedArchitecture(input: ArchitectureInput & { provider: LlmProvider }): {
  plan?: ArchitecturePlan;
  layers: string[];
  blocks: ArchitectureBlockBrief[];
  layout: { name: string; duty: string; moduleIds: string[] }[];
  lost: ArchitectureOverrideLoss[];
} {
  const context = archContext(input, input.provider.modelVersion);
  const stored = input.database?.getLayerCache<ArchitecturePlan>(context.key);
  const plan = stored?.value?.layers?.length ? stored.value : undefined;
  // 没有判好的那份就回空层名：这里不能塞 tier 三档，否则 agent 能「把模块挪进外围」并收到一句成功，
  // 而它挪动的其实是结构角色分组，不是分层判断。
  if (!plan) return { layers: [], blocks: context.briefs, layout: [], lost: [] };
  const layered = applyOverrides(plan.layers, input.overrides, context.units);
  return {
    plan,
    layers: layered.layers.map((layer) => layer.name),
    blocks: context.briefs,
    layout: layered.layers.map((layer) => ({ name: layer.name, duty: layer.duty, moduleIds: layer.moduleIds })),
    lost: layered.lost
  };
}

export async function generateArchitectureCached(input: ArchitectureInput): Promise<ArchitectureResult> {
  const { repositoryId, analysis, provider, database, overrides } = input;
  /**
    分层不可用时的那一份（不落盘）：`layers` 给空数组、原因说清是哪一种，事实那几个节点（节点、外部栏）照算照给。
    不退成 tier 三档：主链路/基础设施/外围是结构角色，把它画成「职责分层」等于递给大家一张假架构图——
    读者会照着它讲「这个系统的分层」，而那句话没有依据。不可用就直说不可用，并留一个明码标价的出口。
   */
  const unavailable = (context: ArchitectureContext, kind: NonNullable<ArchitecturePlan["unavailableReason"]>, reason: string): ArchitectureResult => ({
    repositoryId,
    layers: [],
    edges: [],
    externals: context.boundary.rows,
    source: "unavailable",
    unavailableReason: kind,
    reason,
    overriddenUnits: [],
    generatedAt: new Date().toISOString(),
    basedOnVersionStamp: analysis.versionStamp,
    blocks: context.briefs,
    sideModules: context.sideModules,
    omittedModules: context.omittedModules,
    collapsedExternals: context.boundary.collapsed,
    ...(context.externalsMissing ? { externalsNote: "这份产物还没采外部包名（重新分析后才会有）" } : {})
  });
  if (!provider) {
    return unavailable(archContext(input, "none"), "no_model", "未配置模型：分层判断得由模型给职责层名与归属。节点清单、跨层往来与边界之外那一栏仍是算出来的，问 agent 答得到。");
  }
  const context = archContext(input, provider.modelVersion);
  const { truncated, filesByUnit, briefs, sideModules, boundary, externalsMissing, omittedModules, payload, key, units } = context;
  if (!input.force) {
    const stored = database?.getLayerCache<ArchitecturePlan>(key);
    // 只认模型判过的那份：缓存里 `source:"static"` 的行装的是 tier 三档，读回来就又变成假架构图
    if (stored && stored.value.layers?.length && stored.value.source === "llm") {
      const layered = applyOverrides(stored.value.layers, overrides, units);
      /**
        `lostOverrides` 必须每次覆写，不能只在非空时才带上：这个节点是「原判 + 当前覆盖层」的实时计算读数，
        而 `...stored.value` 里可能住着上一次判层时烤进来的那条——用户把落空的修正撤掉之后横幅还在，
        就是缓存行还替它说话。空数组要如实写成 undefined，别让旧值漏出来。
      */
      return { ...stored.value, repositoryId, layers: layered.layers, edges: layerEdges(layered.layers, filesByUnit, analysis.graph.imports), overriddenUnits: layered.overriddenUnits, lostOverrides: layered.lost.length ? layered.lost : undefined, blocks: briefs, sideModules, externals: boundary.rows, collapsedExternals: boundary.collapsed, omittedModules, usage: undefined };
    }
  }
  /** 读侧（`allowCall: false`）没缓存行就到此为止：不发请求、不落盘，画布交给不可用卡片。 */
  if (input.allowCall === false) {
    return unavailable(context, "not_judged", "还没判过层：打开画布是读取动作，不会替用户点这一发。要判，点「重新生成分层」。");
  }
  try {
    const response = await provider.complete({
      system: ARCHITECTURE_SYSTEM_PROMPT,
      user: JSON.stringify(payload),
      maxTokens: 1_200,
      temperature: 0.2,
      scene: "map.architecture"
    });
    const parsed = parseLayers(response.text, truncated);
    if (!parsed.layers) {
      // 判不出来就报不可用并说清是哪一条不合格；不落盘——同一份输入下次还要再问
      return { ...unavailable(context, "rejected", `分层判断没采信：${parsed.reason ?? "输出不合法"}。这次没落盘，再点一次「重新生成分层」会重问。`), usage: response.usage };
    }
    const layered = applyOverrides(parsed.layers, overrides, units);
    /**
      落盘的是模型的原判（没叠人工修正）：修正每次读的时候实时叠加一次。
      键里不含修正，所以同一份原判会被反复读到——把修正烤进缓存等于下一次读叠第二遍，
      那时「接入→入口层」这类改名已经不成立，界面上的层会开始对不上号。
    */
    const plan: ArchitecturePlan = {
      repositoryId,
      layers: parsed.layers,
      edges: layerEdges(parsed.layers, filesByUnit, analysis.graph.imports),
      externals: boundary.rows,
      source: "llm",
      ...(parsed.droppedFacts ? { reason: "模型额外给了边或文件字段，已丢弃（层归属仍按它判的结果）" } : {}),
      // 产物没采过外部包名：那一栏是空的，但不等于「这个系统不碰任何外部服务」，得说出来
      ...(externalsMissing && !boundary.rows.length ? { externalsNote: "这份产物还没采外部包名（重新分析后才会有）" } : {}),
      // 落盘这份是模型原判，人工挪过的节点与「哪几条修正这次没接上」都属于读时实时计算，不进缓存
      overriddenUnits: [],
      generatedAt: new Date().toISOString(),
      basedOnVersionStamp: analysis.versionStamp
    };
    // 模型自己说「边/文件字段被我丢掉了」的那一次不落盘：payload 与产出不同构，留着下次重问才收敛
    if (!parsed.droppedFacts) database?.putLayerCache(key, plan);
    return { ...plan, layers: layered.layers, edges: layerEdges(layered.layers, filesByUnit, analysis.graph.imports), overriddenUnits: layered.overriddenUnits, ...(layered.lost.length ? { lostOverrides: layered.lost } : {}), blocks: briefs, sideModules, omittedModules, collapsedExternals: boundary.collapsed, usage: response.usage };
  } catch (error) {
    return unavailable(context, "call_failed", `分层调用没成功：${error instanceof Error ? error.message.slice(0, 80) : "未知错误"}。没落盘，可以再点一次「重新生成分层」。`);
  }
}
