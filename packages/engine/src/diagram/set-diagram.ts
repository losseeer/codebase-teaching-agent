import type {
  Diagram,
  DiagramBody,
  DiagramEdit,
  DiagramEditRequest,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  JournalEventType,
  RepositoryAnalysis,
  RepositoryIndex,
  SymbolInfo
} from "@codebase-tutor/domain";

import { applyStructure, buildDiagram, DIAGRAM_EDGE_LIMIT, DIAGRAM_NAME_LIMIT, DIAGRAM_NODE_LIMIT, insertDrawnDiagram, listDiagrams, normalizeDiagramName, readDiagram, uniqueDiagramName, versionStamp } from "../persistence/diagrams.js";
import type { TutorDatabase } from "../persistence/database.js";
import type { LlmTool } from "../llm/provider.js";
import type { FactsPairChecker } from "./facts-verify.js";

/**
  画布上「结构」的唯一写入口。用户只能拖位置（走 `persistence/diagrams.ts` 的 `saveGeometry`），
  加删节点、连线、分组、改名都只能从这里进——界面上不留第二个写入口，
  两边各写一套校验与审计，用户的修正就会只活在某一边。

  三件事在这一层同时守住，缺一层都会漏：

  1. `kind:"module"` 的节点必须指得着真东西：`ref` 是文件、目录、符号或带文件清单的分组，
     由索引与依赖图核对。核不上就整次拒写并回一句「该改谁」——画一个查无此人的节点，读者会去代码里找它。
  2. 边的可信度只降不升：模型可以报 `static` / `code`，引擎拿 import、调用、类型派发三张表去核，
     核不到就降档，并把「为什么不算」写进 `downgraded`（界面上进悬停）。模型永远不能把自己的推断升成事实
     ——与边级证据校验同一个口径。
  3. 每次结构改动自动存一版；回滚同样是往前追加一版（`persistence/diagrams.ts`）。
*/

/** 一次改动回给模型的话：说的是落了什么，不是它想干什么。 */
export interface DiagramWriteOutcome {
  ok: boolean;
  text: string;
  diagram?: Diagram;
}

export interface DiagramWriteContext {
  database: TutorDatabase;
  repositoryId: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
  journal: { append: (type: JournalEventType, payload: Record<string, string | number | boolean | null>) => void };
  onApplied?: (event: { repositoryId: string; diagramId: string; action: string }) => void;
  /**
    第四张结构表（产物层里的类型关系与运行时绑定）。缺省时核边只看 import / 调用 / 类型派发三张表；
    给了它，「控制器注入服务接口」这类代码里没有那一行调用的真关系才不会被降成猜测。
  */
  facts?: FactsPairChecker;
}

/** 可信度排序：核出来更低就降到那一档，绝不上抬。 */
const ORIGIN_RANK: Record<DiagramEdge["origin"], number> = { inferred: 0, code: 1, static: 2 };

/** 节点可指的东西：索引里的文件/目录、依赖图里的符号，或带显式文件清单的分组。 */
interface RefIndex {
  files: Set<string>;
  symbols: SymbolInfo[];
}

function refIndexOf(index: RepositoryIndex, analysis: RepositoryAnalysis): RefIndex {
  return { files: new Set(index.files.map((file) => file.path)), symbols: analysis.graph.symbols };
}

function normalizeRefPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

/** 解析 ref：返回它关联的文件；`group:` 不在这里展开，由节点自带的 `files` 决定。 */
function resolveRef(ref: string, index: RefIndex): { files: string[] } | { error: string } {
  const value = ref.trim();
  if (!value) return { error: "ref 是空的" };
  if (value.startsWith("module:") || value.startsWith("arch:")) {
    return { error: `${value.slice(0, 80)} 是旧课程树/分层的引用，已退役；改成 file:/dir:/symbol:/group:` };
  }
  if (value.startsWith("group:")) return { files: [] };
  if (value.startsWith("file:")) {
    const path = normalizeRefPath(value.slice("file:".length));
    return index.files.has(path) ? { files: [path] } : { error: `文件 ${path.slice(0, 80)} 不在本仓索引里` };
  }
  if (value.startsWith("dir:")) {
    const path = normalizeRefPath(value.slice("dir:".length));
    const prefix = path && path !== "." ? `${path}/` : "";
    const files = [...index.files].filter((file) => (prefix ? file.startsWith(prefix) : true));
    return files.length ? { files } : { error: `目录 ${path.slice(0, 80)} 下没有已索引的文件` };
  }
  if (value.startsWith("symbol:")) {
    const body = value.slice("symbol:".length);
    const hash = body.lastIndexOf("#");
    if (hash <= 0) return { error: "symbol 引用要写成 symbol:<仓内路径>#<符号名>" };
    const path = normalizeRefPath(body.slice(0, hash));
    const name = body.slice(hash + 1).trim();
    const found = index.symbols.some((symbol) => symbol.path === path && symbol.name === name);
    return found ? { files: [path] } : { error: `符号 ${path.slice(0, 60)}#${name.slice(0, 40)} 不在依赖图里` };
  }
  // 裸路径按文件处理，方便模型直接写索引里看到过的路径
  const path = normalizeRefPath(value);
  return index.files.has(path) ? { files: [path] } : { error: `${value.slice(0, 80)} 既不是 file:/dir:/symbol:/group:，也不在本仓索引里` };
}

/** 一个节点覆盖哪些文件：显式 `files` 优先，其次按 ref 解析；便签没有。 */
function filesOfNode(node: DiagramNode, index: RefIndex): string[] {
  if (node.kind !== "module") return [];
  if (node.files?.length) return node.files.filter((path) => index.files.has(path));
  if (!node.ref) return [];
  const resolved = resolveRef(node.ref, index);
  return "files" in resolved ? resolved.files : [];
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
  把模型报的那条边按引擎核出来的档位改一遍，只会往下改。
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
    let files: string[] | undefined;
    if (node.kind === "module") {
      if (!node.ref) return `节点「${label}」没写 ref：模块节点必须指到 file:/dir:/symbol:/group: 之一`;
      if (!node.ref.startsWith("group:")) {
        const resolved = resolveRef(node.ref, index);
        if ("error" in resolved) return `「${label}」指的 ${node.ref.slice(0, DIAGRAM_NAME_LIMIT)} 核不上：${resolved.error}`;
      }
      const explicit = node.files?.map(normalizeRefPath).filter((path) => index.files.has(path)) ?? [];
      if (node.ref.startsWith("group:") && !explicit.length) return `「${label}」是 group 节点，必须给 files 清单（至少一个已索引文件）`;
      if (node.files?.length && !explicit.length) return `「${label}」给的 files 一个都不在本仓索引里`;
      if (explicit.length) files = explicit;
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
      ...(node.kind === "note" ? { ref: undefined, files: undefined, text: clampText(node.text, 500) ?? "" } : { files, text: undefined })
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

/** 目标图怎么认：给了 id 或唯一名字就用它；只有一张且没指名就用那一张；否则拒（绝不猜一张来改）。 */
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
  const index = refIndexOf(context.index, context.analysis);

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
    图元的名字：先在改完的结构里查，查不到再回到改之前那一份。
    删掉的东西在改完的结构里已经没有位置了，而版本历史那句「删除 X」要的恰恰是 X 原来叫什么——
    只写得下 id 的历史读不出东西（`persistence/diagrams.ts` 给 `note` 那句话定的就是这件事）。
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

  模型发回来的是一段 JSON 字符串，而且写法不固定：契约里 `edit` 嵌一层，实际常有把它摊平到顶层的。
  两种写法都收（同一处校验，不让模型因为形状不对重跑一轮），但字段一格都不多认：
  白名单之外的键不看，只在回话里点名（「不报错也不采纳」比「原样塞进产物」好，
  后者会把模型随手编的字段变成图上的一项读数）。

  两处刻意不留口子：
  - 边上的 `downgraded` 不在白名单里。降档说明只能由引擎写，模型自己填一句等于替自己说「这条边成立」；
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

const NODE_FIELDS = ["id", "kind", "label", "sub", "x", "y", "group", "ref", "files", "text"];
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
    // 这里只判「写没写」，指得着指不着由 `settleBody` 按索引与依赖图判：只有一份判据
    const ref = textOf(entry.ref, 200);
    if (!ref) return "kind=module 的节点要写 ref：file:<路径> / dir:<目录> / symbol:<路径>#<符号> / group:<id>";
    const files = Array.isArray(entry.files)
      ? entry.files.flatMap((item): string[] => (typeof item === "string" && item.trim() ? [item.trim().replaceAll("\\", "/").slice(0, 400)] : [])).slice(0, 500)
      : undefined;
    if (entry.files !== undefined && !files) return "node.files 要是字符串数组（仓内相对路径）";
    return { ...base, ...(sub ? { sub } : {}), ...(group ? { group } : {}), ref, ...(files?.length ? { files } : {}) };
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
  翻一次工具参数。回 `error` 就是这一步没做（调用方据此不落盘），句子要说清缺哪一格——
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
  读侧的诚实检查：图上的模块节点还指得着索引里的文件/目录/符号吗？
  文件会改名、目录会删，而图是历史产物——引用断了要说出来，不能画一个查无此人的节点。
*/
export function diagramWarnings(context: DiagramWriteContext, diagram: Diagram): { node: string; reason: string }[] {
  const index = refIndexOf(context.index, context.analysis);
  const out: { node: string; reason: string }[] = [];
  for (const node of diagram.body.nodes) {
    if (node.kind !== "module" || !node.ref) continue;
    const resolved = node.ref.startsWith("group:")
      ? (node.files?.length ? { files: node.files.filter((path) => index.files.has(path)), missing: node.files.filter((path) => !index.files.has(path)) } : { error: "group 节点没有 files 清单" })
      : resolveRef(node.ref, index);
    if ("error" in resolved) out.push({ node: node.id, reason: `${node.ref.slice(0, DIAGRAM_NAME_LIMIT)} 核不上：${resolved.error}` });
    else if (!resolved.files.length) out.push({ node: node.id, reason: `${node.ref.slice(0, DIAGRAM_NAME_LIMIT)} 没有可展示的已索引文件（改名、删文件或重分析过）` });
    else if ("missing" in resolved && resolved.missing.length) out.push({ node: node.id, reason: `${resolved.missing.length} 个关联文件已不在索引里（${resolved.missing.slice(0, 3).join("、")}）` });
  }
  return out;
}

/** 读侧给界面的文件关联：节点 id → 它覆盖的已索引文件。界面抽屉直接用这份。 */
export function diagramFilesByNode(context: DiagramWriteContext, diagram: Diagram): Record<string, { path: string; line: number }[]> {
  const index = refIndexOf(context.index, context.analysis);
  const out: Record<string, { path: string; line: number }[]> = {};
  for (const node of diagram.body.nodes) {
    if (node.kind !== "module") continue;
    out[node.id] = filesOfNode(node, index).map((path) => ({ path, line: 1 }));
  }
  return out;
}

/**
  给模型的「画布现场」：有哪几张图、正打开的那张有哪些图元。
  有副作用的工具必须先看得见现状——没有这一段，模型只能猜 id、猜「那条边」是哪条。
*/
export function diagramInventoryFor(context: DiagramWriteContext, openDiagramId?: string): string {
  const all = listDiagrams(context.database, context.repositoryId);
  if (!all.length) return "画布现场：这个仓还没有图。要画就用 draw 一次画完整张（节点、边、分组都给全），别一格一格试。";
  const lines = all.map((item) => `- ${item.name}（${item.id}，${item.source === "agent" ? "agent 画的" : "用户建的"}，${item.nodes} 节点 / ${item.edges} 边 / ${item.versions} 版，最后改动 ${versionStamp(item.updatedAt)}）${item.id === openDiagramId ? " ← 画布上正打开的这张" : ""}`);
  const open = openDiagramId ? readDiagram(context.database, context.repositoryId, openDiagramId) : undefined;
  const refs = open ? refIndexOf(context.index, context.analysis) : undefined;
  const detail = open
    ? `正打开的「${open.name}」图元清单：\n`
      + (open.body.nodes.length ? open.body.nodes.map((node) => {
        if (node.kind !== "module" || !refs) return `  · ${node.id} = ${node.label}${node.sub ? `（${node.sub}）` : ""} 便签`;
        const files = filesOfNode(node, refs);
        return `  · ${node.id} = ${node.label}${node.sub ? `（${node.sub}）` : ""} 指 ${node.ref}${files.length ? `（${files.length} 个文件）` : ""}`;
      }).join("\n") : "  ·（还没有节点）")
      + "\n"
      + (open.body.edges.length ? open.body.edges.map((edge) => `  · ${edge.id}: ${edge.from} → ${edge.to} [${edge.origin}]${edge.label ? ` ${edge.label}` : ""}${edge.downgraded ? `（降档：${edge.downgraded}）` : ""}`).join("\n") : "  ·（还没有边）")
    : "";
  return `画布现场：\n${lines.join("\n")}\n${detail}\n改哪张就在 diagram 里给它的 id 或名字；结构改动只有 set_diagram 这一条路，位置用户自己拖，不用你代劳。`;
}

/**
  画布上「结构」的写入口（全仓唯一有副作用的工具）。
  四条纪律写死在描述里而不是留在提示词里劝：位置是用户的（`move` 只在用户开口时代挪一格）；
  `module` 节点必须带真 `ref`，核不上整次拒写；边的 `origin` 由引擎拿结构表核，只降不升，降完把原因写在边上；
  `draw` 一次交整张图。
*/
export const SET_DIAGRAM_TOOL: LlmTool = {
  name: "set_diagram",
  description: "改画布上那一张图的结构，只有九种动作：draw（一次画完整张图：给 name 与 body={groups,nodes,edges}，会新建一张图进图库）、add_node（给 node）、remove_node（给 target，连带删掉挂在它身上的边）、add_edge（给 edge）、remove_edge（给 target）、add_group（给 group）、remove_group（给 target，框里节点的归属一并清掉）、relabel（给 target 与 label/sub/text）、move（给 target 与 x、y）。三条硬规矩：① 位置是用户的：除非用户明确让你摆，别去挪东西（用户自己拖不存版本）；② kind=module 的节点必须带 ref：file:<仓内路径> / dir:<仓内目录> / symbol:<仓内路径>#<符号名> / group:<id>，group 还要给 files 清单；引擎按索引与依赖图核对，指不到就不落笔——画一个查无此人的节点，读者会去代码里找它；③ 边的 origin 你报 static 或 code：引擎会拿 import、调用、类型派发，再加上产物里的类型关系与运行时绑定（依赖注入、SPI 这类代码中没有直接调用的那一类）逐条核，核不到就降成 inferred 并把为什么写在边上（它只会降不会升，也别试图自己写 downgraded，这一项由引擎填）。要改哪张图就写 diagram（id 或名字），省略＝只有一张时的那张；上下文里那份「画布现场」列了现有的图与正打开那张的全部图元 id，照着它写，别猜 id。",
  parameters: {
    type: "object",
    properties: {
      diagram: { type: "string", description: "要改的那张图：id 或名字。省略时如果这个仓只有一张图就用它，认不出会被拒并列出图库" },
      edit: { type: "object", description: "一次改动：{ action, ...该动作的字段 }。action 取 draw / add_node / remove_node / add_edge / remove_edge / add_group / remove_group / relabel / move；node={id,kind:module|note,label,x,y,sub?,group?,module 再带 ref,note 再带 text}，edge={id,from,to,origin:static|code|inferred,label?,evidence?}，group={id,label,x,y,w,h}，body={groups,nodes,edges}" }
    },
    required: ["edit"]
  }
};
