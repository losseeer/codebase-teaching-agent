import type { CourseNode, CourseTree, Diagram, DiagramBody, DiagramEdit, DiagramEditRequest, DiagramEdge, DiagramGroup, DiagramNode, JournalEventType, RepositoryAnalysis } from "@codebase-tutor/shared";
import { architectureBlocks, moduleFiles, moduleNodes } from "../coursetree/architecture.js";
import { applyStructure, buildDiagram, DIAGRAM_EDGE_LIMIT, DIAGRAM_NAME_LIMIT, DIAGRAM_NODE_LIMIT, insertDrawnDiagram, listDiagrams, normalizeDiagramName, readDiagram, uniqueDiagramName, versionStamp } from "../store/diagrams.js";
import type { TutorDatabase } from "../store/database.js";
import type { FactsPairChecker } from "./facts-verify.js";

/**
  画布上「结构」的**唯一写入口**。用户只能拖位置（走 `store/diagrams.ts` 的 `saveGeometry`），
  加删节点、连线、分组、改名都只能从这里进——界面上不留第二个写入口，
  两边各写一套校验与审计，用户的修正就会只活在某一边（这条在覆盖层上已经栽过一次，见 §70）。

  三件事在这一层同时守住，缺一层都会漏：

  1. **`kind:"module"` 的节点必须指得着真东西**：`ref` 要么在课程树的模块地图里，要么是引擎现在聚出来的方块
     （`arch:...`）。核不上就**整次拒写**并回一句「该改谁」——画一个查无此人的节点，读者会去代码里找它。
  2. **边的可信度只降不升**：模型可以报 `static` / `code`，引擎拿 import、调用、类型派发三张表去核，
     核不到就降档，并把「为什么不算」写进 `downgraded`（界面上进悬停）。模型永远不能把自己的推断升成事实
     ——与流程层 `parseFlow` 的边级校验同一个口径（§67）。
  3. **每次结构改动自动存一版**；恢复旧版也是往前追加一版（`store/diagrams.ts`）。
*/

/** 一次改动回给模型的话：说的是**落了什么**，不是它想干什么（与 `set_architecture` 同一条纪律）。 */
export interface DiagramWriteOutcome {
  ok: boolean;
  text: string;
  diagram?: Diagram;
}

export interface DiagramWriteContext {
  database: TutorDatabase;
  repositoryId: string;
  course: CourseTree;
  analysis: RepositoryAnalysis;
  journal: { append: (type: JournalEventType, payload: Record<string, string | number | boolean | null>) => void };
  onApplied?: (event: { repositoryId: string; diagramId: string; action: string }) => void;
  /**
    第四张结构表（产物层里的类型关系与运行时绑定）。缺省时核边只看 import / 调用 / 类型派发三张表，
    行为与从前逐字一致；给了它，「控制器注入服务接口」这类**代码里没有那一行调用**的真关系才不会被降成猜测。
  */
  facts?: FactsPairChecker;
}

/** 可信度排序：核出来更低就降过去，绝不上抬。 */
const ORIGIN_RANK: Record<DiagramEdge["origin"], number> = { inferred: 0, code: 1, static: 2 };

/** 节点可指的东西：模块 id 或引擎现在聚出的方块 id。两张表都从课程树 + 依赖图现算，零 token。 */
interface RefIndex {
  modules: Map<string, CourseNode>;
  blocks: Map<string, { title: string; members: string[] }>;
}

function refIndexOf(course: CourseTree, analysis: RepositoryAnalysis): RefIndex {
  const modules = new Map(moduleNodes(course).map((node) => [node.id, node]));
  const blocks = new Map(architectureBlocks(course, analysis).blocks.map((block) => [block.id, { title: block.title, members: block.members }]));
  return { modules, blocks };
}

/** 一个节点覆盖哪些文件：模块节点=它自己的可见文件，方块节点=成员并集，便签=没有。 */
function filesOfNode(node: DiagramNode, index: RefIndex): string[] {
  if (node.kind !== "module" || !node.ref) return [];
  const block = index.blocks.get(node.ref);
  if (block) return [...new Set(block.members.flatMap((member) => (index.modules.has(member) ? moduleFiles(index.modules.get(member)!) : [])))];
  const module = index.modules.get(node.ref);
  return module ? moduleFiles(module) : [];
}

/** 这一对文件之间，结构表里最高能核到哪一档（含依据那一句）。 */
function verifyPair(fromFiles: string[], toFiles: string[], analysis: RepositoryAnalysis): { origin: "static" | "code"; detail: string } | undefined {
  const imports = analysis.graph.imports ?? {};
  const from = new Set(fromFiles);
  const to = new Set(toFiles);
  for (const path of fromFiles) for (const target of imports[path] ?? []) if (to.has(target)) return { origin: "static", detail: `${path} → ${target}` };
  for (const edge of analysis.graph.calls ?? []) if (from.has(edge.callerPath) && to.has(edge.calleePath)) return { origin: "code", detail: `${edge.callerPath}:${edge.line} 调 ${edge.calleePath}` };
  for (const edge of analysis.graph.dispatch ?? []) if (from.has(edge.subtypePath) && to.has(edge.supertypePath)) return { origin: "code", detail: `${edge.subtypePath}:${edge.line} ${edge.kind} ${edge.supertypePath}` };
  return undefined;
}

/** 只查「反方向有没有」：用来把「方向对不上」这句说实话，而不是含糊成「核不到」。 */
function reverseImport(fromFiles: string[], toFiles: string[], analysis: RepositoryAnalysis): string | undefined {
  const imports = analysis.graph.imports ?? {};
  const from = new Set(fromFiles);
  for (const path of toFiles) for (const target of imports[path] ?? []) if (from.has(target)) return `${path} → ${target}`;
  return undefined;
}

/**
  把模型报的那条边按引擎核出来的档位改一遍，**只会往下改**。
  便签参与的边一律 `inferred`：便签不是代码，四张结构表里都没有它，硬标 static 就是撒谎。
*/
function settleEdge(edge: DiagramEdge, nodesById: Map<string, DiagramNode>, index: RefIndex, context: DiagramWriteContext): { edge: DiagramEdge; downgraded: boolean } {
  const { analysis } = context;
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  const fromFiles = from ? filesOfNode(from, index) : [];
  const toFiles = to ? filesOfNode(to, index) : [];
  const claim = ORIGIN_RANK[edge.origin] ?? 0;
  if (!fromFiles.length || !toFiles.length) {
    const reason = "有一端不是模块节点（便签，或引用已经不在树上的格），没有可比对的结构表";
    return { edge: { ...edge, origin: "inferred", evidence: edge.evidence ?? reason, ...(edge.origin === "inferred" ? {} : { downgraded: `模型报的是 ${edge.origin}，${reason}` }) }, downgraded: edge.origin !== "inferred" };
  }
  const graph = verifyPair(fromFiles, toFiles, analysis);
  const fact = context.facts?.(fromFiles, toFiles);
  // 取核得最高那一档作依据；两张都没有才算 inferred。这里只挑高档用于「不降它」，不上抬模型自己报低的那一档
  const verified = graph && fact ? (ORIGIN_RANK[graph.origin] >= ORIGIN_RANK[fact.origin] ? graph : fact) : graph ?? fact;
  const rank = verified ? ORIGIN_RANK[verified.origin] : 0;
  if (rank >= claim) {
    // 核得到且不比它报的低：按它报的那一档留（模型报 code 而其实是 static 也不上抬——上抬等于替它吹）
    return { edge: { ...edge, evidence: verified?.detail ?? edge.evidence }, downgraded: false };
  }
  const reason = verified ? `只核得到 ${verified.origin}（${verified.detail}）` : `import、调用、类型派发与产物里的类型关系、运行时绑定都核不到这一对${reverseImport(fromFiles, toFiles, analysis) ? `，只有反向那条（${reverseImport(fromFiles, toFiles, analysis)}）` : ""}`;
  return { edge: { ...edge, origin: verified ? verified.origin : "inferred", evidence: verified?.detail ?? edge.evidence ?? reason, downgraded: `模型报的是 ${edge.origin}，${reason}` }, downgraded: true };
}

const clampCoord = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
const clampText = (value: string | undefined, limit: number): string | undefined => (value === undefined ? undefined : value.trim().slice(0, limit));

/** 整张图的结构校验：id 唯一、边两端存在、分组存在、几何收口、边按证据定档。返回字符串 = 拒写并说清哪一格。 */
function settleBody(body: DiagramBody, index: RefIndex, context: DiagramWriteContext): { body: DiagramBody; downgraded: number } | string {
  const { analysis } = context;
  if (body.nodes.length > DIAGRAM_NODE_LIMIT) return `这张图有 ${body.nodes.length} 个节点，超过 ${DIAGRAM_NODE_LIMIT} 个：画布不是用来装全仓的，拆成几张图（图库就是为这个存在的）`;
  if (body.edges.length > DIAGRAM_EDGE_LIMIT) return `边超过 ${DIAGRAM_EDGE_LIMIT} 条：这张图已经读不出东西了，只画主要关系`;
  const seen = new Set<string>();
  const nodes: DiagramNode[] = [];
  for (const node of body.nodes) {
    const label = clampText(node.label, 60) ?? "";
    if (!node.id || !label) return "每个节点都要有 id 和一个说得出口的名字";
    if (seen.has(node.id)) return `节点 id 重复：${node.id}`;
    seen.add(node.id);
    if (node.kind === "module") {
      if (!node.ref) return `节点「${label}」没写 ref：模块节点必须指到课程树里的模块 id 或引擎现在聚出的方块 id`;
      if (!index.modules.has(node.ref) && !index.blocks.has(node.ref)) return `「${label}」指的 ${node.ref.slice(0, DIAGRAM_NAME_LIMIT)} 既不在模块地图里，也不是现在图上的方块。要加新东西先让课程树长出来，别在图上凭空造`;
    } else if (node.kind !== "note") {
      return `节点类型只有 module 与 note 两种，收到「${String(node.kind)}」`;
    }
    const sub = clampText(node.sub, 20);
    nodes.push({
      ...node,
      label,
      x: clampCoord(node.x),
      y: clampCoord(node.y),
      ...(sub ? { sub } : {}),
      ...(node.group && body.groups.some((group) => group.id === node.group) ? { group: node.group } : { group: undefined }),
      ...(node.kind === "note" ? { ref: undefined, text: clampText(node.text, 500) ?? "" } : { text: undefined })
    });
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edgeIds = new Set<string>();
  const edges: DiagramEdge[] = [];
  let downgraded = 0;
  for (const edge of body.edges) {
    if (!edge.id) return "每条边都要有 id：版本历史与「删掉那条边」都靠它";
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) return `边 ${edge.id} 的一端不在图上（${edge.from} → ${edge.to}）：先加节点，再加边`;
    if (edge.from === edge.to) return `边 ${edge.id} 指向自己：自环在这张图上读不出意思`;
    if (edgeIds.has(edge.id)) return `边 id 重复：${edge.id}`;
    edgeIds.add(edge.id);
    if (!(edge.origin in ORIGIN_RANK)) return `边的可信度只有 static / code / inferred 三档，收到「${String(edge.origin)}」`;
    const settled = settleEdge({ ...edge, label: clampText(edge.label, 30) }, nodesById, index, context);
    if (settled.downgraded) downgraded += 1;
    edges.push(settled.edge);
  }
  const groups = body.groups.filter((group) => group.id && clampText(group.label, 40));
  if (groups.length !== body.groups.length) return "分组框要同时有 id 和名字";
  return { body: { groups: groups.map((group) => ({ ...group, label: clampText(group.label, 40)!, x: clampCoord(group.x), y: clampCoord(group.y), w: Math.max(40, Math.round(group.w)), h: Math.max(40, Math.round(group.h)) })), nodes, edges }, downgraded };
}

/** 目标图怎么认：给了 id 或唯一名字就用它；只有一张且没指名就用那一张；否则**拒**（绝不猜一张来改）。 */
function resolveTarget(context: DiagramWriteContext, requested: string | undefined): { diagram: Diagram } | { error: string } {
  const wanted = (requested ?? "").trim();
  const all = listDiagrams(context.database, context.repositoryId);
  if (!wanted) {
    if (!all.length) return { error: "这个仓还没有图：先画一张（draw），或在左侧图库点「+」建一张空白图" };
    if (all.length === 1) return { diagram: readDiagram(context.database, context.repositoryId, all[0]!.id)! };
    return { error: `画布上没有明确打开的图，而这个仓有 ${all.length} 张：${all.map((item) => item.name).join(" / ")}。说清要改哪一张` };
  }
  const byId = readDiagram(context.database, context.repositoryId, wanted);
  if (byId) return { diagram: byId };
  const named = all.filter((item) => item.name === wanted);
  if (named.length === 1) return { diagram: readDiagram(context.database, context.repositoryId, named[0]!.id)! };
  if (named.length > 1) return { error: `有 ${named.length} 张图都叫「${wanted}」，先给它换个名字再改` };
  return { error: `没有「${wanted.slice(0, DIAGRAM_NAME_LIMIT)}」这张图。现在是：${all.map((item) => item.name).join(" / ") || "（一张都没有）"}` };
}

const refuse = (reason: string): DiagramWriteOutcome => ({ ok: false, text: `没改：${reason}。结构改动只有 draw / add_node / remove_node / add_edge / remove_edge / add_group / remove_group / relabel / move 这九种，每一格都要指得着图上的东西。` });

const downgradeNote = (count: number): string => (count ? `其中 ${count} 条边核不到依据、已降档（边上写着为什么）。` : "");

/** 版本历史里那一行人话：动作 + 目标名，读的人不用猜。 */
function versionNoteOf(edit: DiagramEdit, nameOf: (id: string) => string): string {
  switch (edit.action) {
    case "draw": return "agent 初版";
    case "add_node": return `加 ${edit.node.label}`;
    case "remove_node": return `删除 ${nameOf(edit.target)}`;
    case "add_edge": return `连线 ${nameOf(edit.edge.from)} → ${nameOf(edit.edge.to)}`;
    case "remove_edge": return `删边 ${edit.target}`;
    case "add_group": return `分组 ${edit.group.label}`;
    case "remove_group": return `删分组 ${nameOf(edit.target)}`;
    case "relabel": return `改名 ${nameOf(edit.target)}`;
    case "move": return `挪动 ${nameOf(edit.target)}`;
  }
}

/** 一次动作改的是图上哪一格（回话里要念出它的名字，不能只报 id）。 */
function editTargetId(edit: DiagramEdit): string {
  if ("target" in edit) return edit.target;
  if ("node" in edit) return edit.node.id;
  if ("edge" in edit) return edit.edge.id;
  if ("group" in edit) return edit.group.id;
  return "";
}

/** 一次动作的中文说法，回给模型用。 */
const ACTION_LABEL: Record<DiagramEdit["action"], string> = {
  draw: "画好", add_node: "加了节点", remove_node: "删了节点", add_edge: "连了边", remove_edge: "删了边",
  add_group: "加了分组", remove_group: "删了分组", relabel: "改了名", move: "挪了位置"
};

/**
  落一次结构改动。`via` 目前只有 `agent`（用户的改名/删除/恢复走各自的路由，它们不动结构），
  留着这一格是为了让审计里「谁改的」永远说得清。
*/
export function applyDiagramEdit(context: DiagramWriteContext, request: DiagramEditRequest, via: "agent" | "user" = "agent"): DiagramWriteOutcome {
  const edit = request.edit;
  const index = refIndexOf(context.course, context.analysis);

  if (edit.action === "draw") {
    const settled = settleBody(edit.body, index, context);
    if (typeof settled === "string") return refuse(settled);
    const wanted = normalizeDiagramName(edit.name) || "未命名图";
    const diagram = buildDiagram(context.repositoryId, { name: uniqueDiagramName(context.database, context.repositoryId, wanted), source: via === "agent" ? "agent" : "me", body: settled.body });
    const saved = insertDrawnDiagram(context.database, diagram);
    context.journal.append("diagram_created", { diagram: saved.id, name: saved.name, source: saved.source, nodes: saved.body.nodes.length, edges: saved.body.edges.length, downgraded: settled.downgraded, via });
    context.onApplied?.({ repositoryId: context.repositoryId, diagramId: saved.id, action: "draw" });
    return { ok: true, text: `画好了「${saved.name}」：${saved.body.nodes.length} 个节点、${saved.body.edges.length} 条边，已存进图库并留了第一版。${downgradeNote(settled.downgraded)}`, diagram: saved };
  }

  const target = resolveTarget(context, request.diagram);
  if ("error" in target) return refuse(target.error);
  const diagram = target.diagram;
  const body: DiagramBody = { groups: [...diagram.body.groups], nodes: [...diagram.body.nodes], edges: [...diagram.body.edges] };
  /**
    图元的名字：**先在改完的结构里查，查不到再回到改之前那一份**。
    删掉的东西在改完的结构里已经没有位置了，而版本历史那句「删除 X」要的恰恰是 X 原来叫什么——
    只写得下 id 的历史读不出东西（`store/diagrams.ts` 给 `note` 那句话定的就是这件事）。
  */
  const labelIn = (items: { id: string; label: string }[], value: string): string | undefined => items.find((item) => item.id === value)?.label;
  const nameOf = (id: string): string => labelIn(body.nodes, id) ?? labelIn(body.groups, id) ?? labelIn(diagram.body.nodes, id) ?? labelIn(diagram.body.groups, id) ?? id;
  const settledBefore = body.nodes.length;

  if (edit.action === "add_node") {
    if (body.nodes.some((node) => node.id === edit.node.id)) return refuse(`图上已经有 ${edit.node.id} 这个节点`);
    body.nodes.push({ ...edit.node, label: clampText(edit.node.label, 60) ?? "" });
  } else if (edit.action === "remove_node") {
    const node = body.nodes.find((item) => item.id === edit.target);
    if (!node) return refuse(`图上没有 ${edit.target} 这个节点`);
    const edges = body.edges.length;
    body.nodes = body.nodes.filter((item) => item.id !== edit.target);
    body.edges = body.edges.filter((edge) => edge.from !== edit.target && edge.to !== edit.target);
    return finish(edit, `已删除「${node.label}」，连带去掉 ${edges - body.edges.length} 条边，恢复点在版本历史里。`);
  } else if (edit.action === "add_edge") {
    if (body.edges.some((edge) => edge.id === edit.edge.id)) return refuse(`图上已经有 ${edit.edge.id} 这条边`);
    body.edges.push(edit.edge);
  } else if (edit.action === "remove_edge") {
    if (!body.edges.some((edge) => edge.id === edit.target)) return refuse(`图上没有 ${edit.target} 这条边`);
    body.edges = body.edges.filter((edge) => edge.id !== edit.target);
  } else if (edit.action === "add_group") {
    if (body.groups.some((group) => group.id === edit.group.id)) return refuse(`图上已经有 ${edit.group.id} 这个分组`);
    body.groups.push(edit.group);
  } else if (edit.action === "remove_group") {
    if (!body.groups.some((group) => group.id === edit.target)) return refuse(`图上没有 ${edit.target} 这个分组`);
    body.groups = body.groups.filter((group) => group.id !== edit.target);
    // 框没了，节点上还写着它的 id：一并清掉，否则界面上会出现一个指向空气的分组
    body.nodes = body.nodes.map((node) => (node.group === edit.target ? { ...node, group: undefined } : node));
  } else if (edit.action === "relabel") {
    const label = clampText(edit.label, 60);
    const sub = clampText(edit.sub, 20);
    const text = clampText(edit.text, 500);
    if (body.nodes.some((node) => node.id === edit.target)) body.nodes = body.nodes.map((node) => (node.id === edit.target ? { ...node, ...(label ? { label } : {}), ...(sub !== undefined ? { sub } : {}), ...(text !== undefined ? { text } : {}) } : node));
    else if (body.groups.some((group) => group.id === edit.target)) body.groups = body.groups.map((group) => (group.id === edit.target ? { ...group, ...(label ? { label } : {}) } : group));
    else return refuse(`图上没有 ${edit.target} 这个节点或分组`);
  } else if (edit.action === "move") {
    const node = body.nodes.find((item) => item.id === edit.target);
    if (!node) return refuse(`图上没有 ${edit.target} 这个节点`);
    body.nodes = body.nodes.map((item) => (item.id === edit.target ? { ...item, x: clampCoord(edit.x), y: clampCoord(edit.y) } : item));
  } else {
    return refuse("这个动作不在支持列表里");
  }

  return finish(edit, "");

  /** 校验 + 落盘 + 记账 + 广播，一次做完（每个分支都从这儿出去，免得哪条漏了审计）。 */
  function finish(done: DiagramEdit, override: string): DiagramWriteOutcome {
    const settled = settleBody(body, index, context);
    if (typeof settled === "string") return refuse(settled);
    const saved = applyStructure(context.database, diagram, settled.body, versionNoteOf(done, nameOf));
    context.journal.append(done.action === "draw" ? "diagram_created" : "diagram_edited", {
      diagram: saved.id, action: done.action, target: "target" in done ? done.target : "node" in done ? done.node.id : "edge" in done ? done.edge.id : "group" in done ? done.group.id : "",
      nodes: saved.body.nodes.length, edges: saved.body.edges.length, dropped_nodes: Math.max(0, settledBefore - saved.body.nodes.length), downgraded: settled.downgraded, via
    });
    context.onApplied?.({ repositoryId: context.repositoryId, diagramId: saved.id, action: done.action });
    const targetName = nameOf(editTargetId(done));
    const tail = done.action === "move"
      ? `位置不承载对错——这一格你自己拖就行，拖动不存版本。`
      : `${ACTION_LABEL[done.action]}「${targetName}」：现在这张图 ${saved.body.nodes.length} 个节点、${saved.body.edges.length} 条边。`;
    return { ok: true, text: `${override}${override ? " " : ""}${done.action === "remove_node" ? "" : tail}${downgradeNote(settled.downgraded)}`, diagram: saved };
  }
}

/**
  ==== `set_diagram` 的参数层（写入口的前门）====

  模型发回来的是一段 **JSON 字符串**，而且写法不固定：契约里 `edit` 嵌一层，实测常有把它摊平到顶层的。
  两种写法都收（同一处校验，不让模型因为形状不对白跑一轮），但**字段一格都不多认**：
  白名单之外的键不看，只在回话里点名（照 `coursetree/override-writer.ts` 的 `parseOverrideArguments` 那条纪律——
  「不报错也不采纳」比「原样塞进产物」好，后者会把模型随手编的字段变成图上的一项读数）。

  ⚠️ 两处刻意不留口子：
  - 边上的 `downgraded` 不在白名单里。降档说明只能由引擎写，模型自己填一句等于替自己圆「这条边成立」；
  - `origin` 三档必须写出来且只认这三档。报低了引擎不会替它抬（见 `settleEdge`），所以虚报在这儿没有收益。
*/

/** 九种动作各自的字段清单：这里能表达的形状就只有这九种。 */
const EDIT_FIELDS: Record<DiagramEdit["action"], readonly string[]> = {
  draw: ["action", "name", "body"],
  add_node: ["action", "node"],
  remove_node: ["action", "target"],
  add_edge: ["action", "edge"],
  remove_edge: ["action", "target"],
  add_group: ["action", "group"],
  remove_group: ["action", "target"],
  relabel: ["action", "target", "label", "sub", "text"],
  move: ["action", "target", "x", "y"]
};

const NODE_FIELDS = ["id", "kind", "label", "sub", "x", "y", "group", "ref", "text"];
const EDGE_FIELDS = ["id", "from", "to", "origin", "label", "evidence"];
const GROUP_FIELDS = ["id", "label", "x", "y", "w", "h"];
const BODY_FIELDS = ["groups", "nodes", "edges"];

/** 必填的短文本：非字符串一律按没给（不给就拒，别替模型编一个 id 或名字）。 */
const textOf = (value: unknown, limit: number): string => (typeof value === "string" ? value.trim().slice(0, limit) : "");
/** 可选文本：分得清「没给这个键」与「给了空串」——relabel 拿空串清正文，这两件事不能混。 */
const optionalText = (value: unknown, limit: number): string | undefined => (typeof value === "string" ? value.trim().slice(0, limit) : undefined);
/** 坐标与尺寸：非有限值收成 0，越界的由 `settleBody` 再夹一次。 */
const coordOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** 把容器里没列进白名单的键登记进 `ignored`，回话里点名（带容器名才读得懂是哪一格多余的）。 */
function noteExtras(entry: Record<string, unknown>, allowed: readonly string[], where: string, ignored: string[]): void {
  for (const key of Object.keys(entry)) if (!allowed.includes(key)) ignored.push(`${where}.${key}`);
}

function nodeFrom(raw: unknown, ignored: string[]): DiagramNode | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "node 要是一个对象：{ id, kind, label, x, y }，module 再带 ref，note 再带 text";
  const entry = raw as Record<string, unknown>;
  noteExtras(entry, NODE_FIELDS, "node", ignored);
  const id = textOf(entry.id, 60);
  const label = textOf(entry.label, 60);
  if (!id || !label) return "node 要有 id 和一个说得出口的名字：版本历史与「删掉这个节点」都靠 id 认，名字是读者唯一看得见的一格";
  if (entry.kind !== "module" && entry.kind !== "note") return "node 的 kind 必须写出来，只有 module 与 note 两种";
  const sub = optionalText(entry.sub, 20);
  const group = optionalText(entry.group, 60);
  const base: DiagramNode = { id, kind: entry.kind, label, x: coordOf(entry.x), y: coordOf(entry.y) };
  if (entry.kind === "module") {
    // 这里只判「写没写」，**指得着指不着由 `settleBody` 按课程树与方块清单判**：两张表只有一份判据
    const ref = textOf(entry.ref, 120);
    if (!ref) return "kind=module 的节点要写 ref：课程树里的模块 id，或上下文那份画布现场上的 arch: 方块 id";
    return { ...base, ...(sub ? { sub } : {}), ...(group ? { group } : {}), ref };
  }
  const text = optionalText(entry.text, 500);
  return { ...base, ...(sub ? { sub } : {}), ...(group ? { group } : {}), text: text ?? "" };
}

function edgeFrom(raw: unknown, ignored: string[]): DiagramEdge | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "edge 要是一个对象：{ id, from, to, origin }，可选 label 与 evidence";
  const entry = raw as Record<string, unknown>;
  noteExtras(entry, EDGE_FIELDS, "edge", ignored);
  const id = textOf(entry.id, 60);
  const from = textOf(entry.from, 60);
  const to = textOf(entry.to, 60);
  if (!id || !from || !to) return "edge 要有 id、from、to：id 是「删掉那条边」的句柄，两端必须是图上已有的节点 id";
  const origin = textOf(entry.origin, 12);
  if (origin !== "static" && origin !== "code" && origin !== "inferred") return "edge 的 origin 只有 static / code / inferred 三档，且要写出来：报低一档引擎不抬你，报高一档它会降你";
  const label = optionalText(entry.label, 30);
  const evidence = optionalText(entry.evidence, 160);
  return { id, from, to, origin, ...(label ? { label } : {}), ...(evidence ? { evidence } : {}) };
}

function groupFrom(raw: unknown, ignored: string[]): DiagramGroup | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "group 要是一个对象：{ id, label, x, y, w, h }";
  const entry = raw as Record<string, unknown>;
  noteExtras(entry, GROUP_FIELDS, "group", ignored);
  const id = textOf(entry.id, 60);
  const label = textOf(entry.label, 40);
  if (!id || !label) return "分组框要有 id 和名字：节点靠 id 声明自己在哪个框里，名字是读者唯一看得见的一格";
  return { id, label, x: coordOf(entry.x), y: coordOf(entry.y), w: coordOf(entry.w), h: coordOf(entry.h) };
}

/** `draw` 的整张结构：三个数组都按缺省当空表处理（只画节点不带边是常见情形），但每一格都过一遍上面的字段挑选。 */
function bodyFrom(raw: unknown, ignored: string[]): DiagramBody | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "draw 要给 body：{ groups, nodes, edges }，一次把整张图画完";
  const entry = raw as Record<string, unknown>;
  noteExtras(entry, BODY_FIELDS, "body", ignored);
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const nodes: DiagramNode[] = [];
  for (const item of list(entry.nodes)) {
    const node = nodeFrom(item, ignored);
    if (typeof node === "string") return node;
    nodes.push(node);
  }
  const edges: DiagramEdge[] = [];
  for (const item of list(entry.edges)) {
    const edge = edgeFrom(item, ignored);
    if (typeof edge === "string") return edge;
    edges.push(edge);
  }
  const groups: DiagramGroup[] = [];
  for (const item of list(entry.groups)) {
    const group = groupFrom(item, ignored);
    if (typeof group === "string") return group;
    groups.push(group);
  }
  return { groups, nodes, edges };
}

/**
  翻一次工具参数。回 `error` 就是**这一步没做**（调用方据此不落盘），句子要说清缺哪一格——
  这句话会作为 `role:"tool"` 回喂给模型，它下一轮就按这个改。
*/
export function parseDiagramEditArguments(raw: string): { request?: DiagramEditRequest; ignored: string[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return { ignored: [], error: "参数不是合法 JSON：应当是一个对象，形如 {\"edit\":{\"action\":\"add_edge\",…}}" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ignored: [], error: "参数不是一个对象" };
  const top = parsed as Record<string, unknown>;
  const nested = top.edit && typeof top.edit === "object" && !Array.isArray(top.edit) ? (top.edit as Record<string, unknown>) : undefined;
  const source = nested ?? (typeof top.action === "string" ? top : undefined);
  if (!source) return { ignored: Object.keys(top).filter((key) => key !== "diagram" && key !== "edit"), error: "缺 edit：这一格写 action 与它自己的字段，要改哪张图写在 diagram 里" };
  const action = textOf(source.action, 24);
  const fields = EDIT_FIELDS[action as DiagramEdit["action"]];
  const ignored: string[] = [];
  if (!fields) return { ignored, error: `未知 action「${action.slice(0, 40)}」：只有 draw / add_node / remove_node / add_edge / remove_edge / add_group / remove_group / relabel / move 这九种` };
  // 摊平写法下顶层那些既不是 diagram、也不属于本动作的键同样算多余字段（收下来不看，但要告诉模型看了什么）
  for (const key of Object.keys(top)) {
    if (key === "diagram") continue;
    if (source === top ? !fields.includes(key) : key !== "edit") ignored.push(key);
  }
  for (const key of Object.keys(source)) if (!fields.includes(key)) ignored.push(key);
  const requested = optionalText(top.diagram, 120);
  const target = textOf(source.target, 60);
  const missing = (hint: string): { ignored: string[]; error: string } => ({ ignored, error: `${action} 要给出 ${hint}` });

  let edit: DiagramEdit;
  if (action === "draw") {
    const body = bodyFrom(source.body, ignored);
    if (typeof body === "string") return { ignored, error: body };
    const name = optionalText(source.name, DIAGRAM_NAME_LIMIT);
    edit = { action: "draw", ...(name ? { name } : {}), body };
  } else if (action === "add_node") {
    const node = nodeFrom(source.node, ignored);
    if (typeof node === "string") return { ignored, error: node };
    edit = { action: "add_node", node };
  } else if (action === "add_edge") {
    const edge = edgeFrom(source.edge, ignored);
    if (typeof edge === "string") return { ignored, error: edge };
    edit = { action: "add_edge", edge };
  } else if (action === "add_group") {
    const group = groupFrom(source.group, ignored);
    if (typeof group === "string") return { ignored, error: group };
    edit = { action: "add_group", group };
  } else if (action === "remove_node" || action === "remove_edge" || action === "remove_group") {
    if (!target) return missing(`target（图上那个${action === "remove_node" ? "节点" : action === "remove_edge" ? "边" : "分组"}的 id）`);
    edit = { action, target };
  } else if (action === "relabel") {
    const label = optionalText(source.label, 60);
    const sub = optionalText(source.sub, 20);
    const text = optionalText(source.text, 500);
    if (!target) return missing("target（要改名的节点或分组 id）");
    if (label === undefined && sub === undefined && text === undefined) return { ignored, error: "relabel 至少给 label / sub / text 一个：三个都不给就等于什么都没改，却要存一版" };
    edit = { action: "relabel", target, ...(label ? { label } : {}), ...(sub !== undefined ? { sub } : {}), ...(text !== undefined ? { text } : {}) };
  } else {
    if (!target) return missing("target（要挪的那个节点 id）");
    if (typeof source.x !== "number" || typeof source.y !== "number") return { ignored, error: "move 要给 x 与 y 两个数字：这一格是引擎替用户挪东西，坐标含糊不能写盘" };
    edit = { action: "move", target, x: source.x, y: source.y };
  }
  return { request: { ...(requested ? { diagram: requested } : {}), edit }, ignored: [...new Set(ignored)] };
}

/**
  读侧的诚实检查：图上的模块节点还指得着课程树吗？
  课程树会重生成、模块会改名，而图是历史产物——引用断了要说出来，不能画一个查无此人的方块。
*/
export function diagramWarnings(context: DiagramWriteContext, diagram: Diagram): { node: string; reason: string }[] {
  const index = refIndexOf(context.course, context.analysis);
  const out: { node: string; reason: string }[] = [];
  for (const node of diagram.body.nodes) {
    if (node.kind !== "module" || !node.ref) continue;
    if (!index.modules.has(node.ref) && !index.blocks.has(node.ref)) out.push({ node: node.id, reason: `${node.ref.slice(0, DIAGRAM_NAME_LIMIT)} 已经不在现在的课程树或方块清单里（改名、删模块或重分析过）` });
  }
  return out;
}

/**
  给模型的「画布现场」：有哪几张图、正打开的那张有哪些图元。
  ⚠️ 有副作用的工具必须先看得见现状（§71 的教训）——没有这一段，模型只能猜 id、猜「那条边」是哪条。
*/
export function diagramInventoryFor(context: DiagramWriteContext, openDiagramId?: string): string {
  const all = listDiagrams(context.database, context.repositoryId);
  if (!all.length) return "画布现场：这个仓还没有图。要画就用 draw 一次画完整张（节点、边、分组都给全），别一格一格试。";
  const lines = all.map((item) => `- ${item.name}（${item.id}，${item.source === "agent" ? "agent 画的" : "用户建的"}，${item.nodes} 节点 / ${item.edges} 边 / ${item.versions} 版，最后改动 ${versionStamp(item.updatedAt)}）${item.id === openDiagramId ? " ← 画布上正打开的这张" : ""}`);
  const open = openDiagramId ? readDiagram(context.database, context.repositoryId, openDiagramId) : undefined;
  const detail = open
    ? `正打开的「${open.name}」图元清单：\n`
      + (open.body.nodes.length ? open.body.nodes.map((node) => `  · ${node.id} = ${node.label}${node.sub ? `（${node.sub}）` : ""}${node.kind === "module" ? ` 指 ${node.ref}` : " 便签"}`).join("\n") : "  ·（还没有节点）")
      + "\n"
      + (open.body.edges.length ? open.body.edges.map((edge) => `  · ${edge.id}: ${edge.from} → ${edge.to} [${edge.origin}]${edge.label ? ` ${edge.label}` : ""}${edge.downgraded ? `（降档：${edge.downgraded}）` : ""}`).join("\n") : "  ·（还没有边）")
    : "";
  return `画布现场：\n${lines.join("\n")}\n${detail}\n改哪张就在 diagram 里给它的 id 或名字；结构改动只有 set_diagram 这一条路，位置用户自己拖，不用你代劳。`;
}
