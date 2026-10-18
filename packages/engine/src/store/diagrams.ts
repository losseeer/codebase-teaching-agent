import { randomUUID } from "node:crypto";
import type { Diagram, DiagramBody, DiagramSource, DiagramSummary, DiagramVersion } from "@codebase-tutor/shared";
import type { TutorDatabase } from "./database.js";

/**
  画布上的一张图的唯一读写口（表在 `store/database.ts` 的 `diagram`，一行 = 一张图）。

  两条写入路径权限不一样，所以分成两个函数，别混：

  - `saveGeometry`：**几何**。用户自己拖出来的位置，不存版本、不写审计、不广播——
    位置不承载对错，一天能拖几百次，进任何一条记录线都只会淹掉真信号；
  - `applyStructure`：**结构**。加删节点、连线、分组、改名字，只有 agent 的 `set_diagram` 走这里
    （界面不留第二个写入口），每一次都自动存一版。

  版本策略：`versions` 旧→新，上限 20（超了丢最旧的一版）；**恢复旧版是往前追加一版**，
  不截断历史——否则「回到那一版」这个动作本身就把证据抹了，用户下次没法说「不，我要刚才那版」。
*/

/** 一版快照存多少个：再多就是拿用户的数据换一句「历史很长」，20 版够回头看一天。 */
export const DIAGRAM_VERSION_LIMIT = 20;

/** 图名上限：左栏一行装得下的字数，收口在写侧，读侧就不必每处都截。 */
export const DIAGRAM_NAME_LIMIT = 40;

/** 一张图的图元上限：画布不是用来装全仓的，超了让 agent 拆成几张图（图库存在的意义就在这）。 */
export const DIAGRAM_NODE_LIMIT = 120;
export const DIAGRAM_EDGE_LIMIT = 240;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const emptyDiagramBody = (): DiagramBody => ({ groups: [], nodes: [], edges: [] });

/** 名字收口：去空白、压空格、限长；空串返回 ""，默认值由调用方决定（这里不猜）。 */
export function normalizeDiagramName(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, DIAGRAM_NAME_LIMIT);
}

export function newDiagramId(): string {
  return `dg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** 版本时间戳给人看的那一档（`10-18 14:05`）：ISO 串进库，界面与 note 里都用这一档。 */
export function versionStamp(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface ParsedRow { body: DiagramBody; versions: DiagramVersion[] }

/** 读一行：结构解析不出来就当没有这张图——半张图会被画成一张完整的图，那比没有更糟。 */
function parseRow(row: { payload: string }): ParsedRow | undefined {
  try {
    const parsed = JSON.parse(row.payload) as DiagramBody & { versions?: unknown };
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || !Array.isArray(parsed.groups)) return undefined;
    const versions = Array.isArray(parsed.versions)
      ? (parsed.versions as DiagramVersion[]).filter((version) => typeof version?.at === "string" && Array.isArray(version?.body?.nodes))
      : [];
    return { body: { groups: parsed.groups, nodes: parsed.nodes, edges: parsed.edges }, versions };
  } catch {
    return undefined;
  }
}

function put(database: TutorDatabase, diagram: Diagram): void {
  database.putDiagramRow(diagram.repositoryId, diagram.id, {
    name: diagram.name,
    source: diagram.source,
    createdAt: Date.parse(diagram.createdAt) || Date.now(),
    updatedAt: Date.parse(diagram.updatedAt) || Date.now(),
    payload: { ...diagram.body, versions: diagram.versions }
  });
}

export function readDiagram(database: TutorDatabase, repositoryId: string, diagramId: string): Diagram | undefined {
  const row = database.getDiagramRow(repositoryId, diagramId);
  const parsed = row ? parseRow(row) : undefined;
  if (!row || !parsed) return undefined;
  return {
    repositoryId,
    id: diagramId,
    name: row.name,
    source: row.source === "agent" ? "agent" : "me",
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    versions: parsed.versions,
    body: parsed.body
  };
}

/** 图库列表：只回摘要（名字、谁建的、几版、多少图元），不拖结构进左栏。 */
export function listDiagrams(database: TutorDatabase, repositoryId: string): DiagramSummary[] {
  const out: DiagramSummary[] = [];
  for (const row of database.listDiagramRows(repositoryId)) {
    const parsed = parseRow(row);
    if (!parsed) continue;
    out.push({
      id: row.diagramId,
      name: row.name,
      source: row.source === "agent" ? "agent" : "me",
      updatedAt: new Date(row.updatedAt).toISOString(),
      nodes: parsed.body.nodes.length,
      edges: parsed.body.edges.length,
      versions: parsed.versions.length
    });
  }
  return out;
}

/** 建一张图（不落盘）：`createBlankDiagram` 与 agent 一次画完整张图都从这一个构造点走，两处口径才不会漂。 */
export function buildDiagram(repositoryId: string, input: { name?: string; source: DiagramSource; body?: DiagramBody; id?: string }): Diagram {
  const now = new Date().toISOString();
  return {
    repositoryId,
    id: input.id ?? newDiagramId(),
    name: normalizeDiagramName(input.name) || "未命名图",
    source: input.source,
    createdAt: now,
    updatedAt: now,
    versions: [],
    body: input.body ?? emptyDiagramBody()
  };
}

/** 新建一张图并落盘（用户点「+」）。空白图不存第一版：它还没有结构可回。 */
export function createBlankDiagram(database: TutorDatabase, repositoryId: string, name?: string): Diagram {
  const diagram = buildDiagram(repositoryId, { name: uniqueDiagramName(database, repositoryId, normalizeDiagramName(name) || "未命名图"), source: "me" });
  put(database, diagram);
  return diagram;
}

/**
  同名就加序号（`系统分层总览` → `系统分层总览（2）`）。
  图库靠名字认图，两张同名图会让「改那张登录流程」这句话没有答案——agent 那一侧也一样，
  所以重名不是在界面上标一下，而是压根不让它发生。
*/
export function uniqueDiagramName(database: TutorDatabase, repositoryId: string, wanted: string): string {
  const taken = new Set(listDiagrams(database, repositoryId).map((item) => item.name));
  if (!taken.has(wanted)) return wanted;
  let index = 2;
  while (taken.has(`${wanted}（${index}）`)) index += 1;
  return `${wanted}（${index}）`;
}

/**
  结构落盘 + 存一版。`note` 是「这次改了什么」的人话（`加 notify` / `删除 数据库`），
  版本历史那一栏全靠它才读得懂——只写时间戳的列表等于没有历史。
*/
export function applyStructure(database: TutorDatabase, diagram: Diagram, body: DiagramBody, note: string): Diagram {
  const at = new Date().toISOString();
  const versions = [...diagram.versions, { at, note: note.slice(0, 120), body: clone(body) }];
  const next: Diagram = { ...diagram, body: clone(body), versions: versions.slice(-DIAGRAM_VERSION_LIMIT), updatedAt: at };
  put(database, next);
  return next;
}

/** 首次落盘一张画好的图：连同「agent 初版」这一版一起存，用户至少能回到第一版。 */
export function insertDrawnDiagram(database: TutorDatabase, diagram: Diagram): Diagram {
  return applyStructure(database, diagram, diagram.body, "agent 初版");
}

/** 改名不动结构，所以不存版本。名字没变或空串都回 undefined（调用方据此决定要不要写审计）。 */
export function renameDiagram(database: TutorDatabase, diagram: Diagram, name: string): Diagram | undefined {
  const next = normalizeDiagramName(name);
  if (!next || next === diagram.name) return undefined;
  const renamed: Diagram = { ...diagram, name: next, updatedAt: new Date().toISOString() };
  put(database, renamed);
  return renamed;
}

/**
  几何：只改 x/y，其余一格都不动，也不碰 versions、不推 updatedAt。
  只认图上真有的节点，坐标收为非负整数——画布没有负坐标那一格，NaN 更不能进库。
*/
export function saveGeometry(database: TutorDatabase, diagram: Diagram, positions: { id: string; x: number; y: number }[]): Diagram {
  const byId = new Map(positions.map((item) => [item.id, item]));
  const nodes = diagram.body.nodes.map((node) => {
    const moved = byId.get(node.id);
    if (!moved) return node;
    const x = Number.isFinite(moved.x) ? Math.max(0, Math.round(moved.x)) : node.x;
    const y = Number.isFinite(moved.y) ? Math.max(0, Math.round(moved.y)) : node.y;
    return x === node.x && y === node.y ? node : { ...node, x, y };
  });
  const next: Diagram = { ...diagram, body: { ...diagram.body, nodes } };
  put(database, next);
  return next;
}

/**
  恢复到某一版。恢复本身**再存一版**（`恢复到 …`），历史只追加不改写——
  否则这个动作会把它之后的证据一起抹掉，用户没法再反悔。
*/
export function restoreVersion(database: TutorDatabase, diagram: Diagram, index: number): Diagram | undefined {
  const version = diagram.versions[index];
  if (!version) return undefined;
  const at = new Date().toISOString();
  const versions = [...diagram.versions, { at, note: `恢复到 ${versionStamp(version.at)}`, body: clone(version.body) }];
  const next: Diagram = { ...diagram, body: clone(version.body), versions: versions.slice(-DIAGRAM_VERSION_LIMIT), updatedAt: at };
  put(database, next);
  return next;
}

export function deleteDiagram(database: TutorDatabase, diagram: Diagram): void {
  database.deleteDiagramRow(diagram.repositoryId, diagram.id);
}
