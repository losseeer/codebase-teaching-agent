import type { Diagram, DiagramBody, DiagramSummary, DiagramVersion } from "@codebase-tutor/domain";
import { buildDiagram, DIAGRAM_VERSION_LIMIT, diagramId, normalizeDiagramName, versionStamp } from "@codebase-tutor/domain";
import { id } from "@codebase-tutor/platform";

import type { TutorDatabase } from "./database.js";

/** 画布上的一张图的读写口（表 `diagram`，一行 = 一张图）；建图规则在 `@codebase-tutor/domain` 的 diagram.ts。
    几何写入不存版本，结构写入每趟存一版；`versions` 旧→新，超过 `DIAGRAM_VERSION_LIMIT` 丢最旧的一版。 */

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface ParsedRow { body: DiagramBody; versions: DiagramVersion[] }

/** 读一行；结构解析不出来当作没有这张图。 */
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
  database.diagrams.put(diagram.repositoryId, diagram.id, {
    name: diagram.name,
    source: diagram.source,
    createdAt: Date.parse(diagram.createdAt) || Date.now(),
    updatedAt: Date.parse(diagram.updatedAt) || Date.now(),
    payload: { ...diagram.body, versions: diagram.versions }
  });
}

export function readDiagram(database: TutorDatabase, repositoryId: string, diagramId: string): Diagram | undefined {
  const row = database.diagrams.byId(repositoryId, diagramId);
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

/** 图库列表：只回摘要，不含图体结构。 */
export function listDiagrams(database: TutorDatabase, repositoryId: string): DiagramSummary[] {
  const out: DiagramSummary[] = [];
  for (const row of database.diagrams.list(repositoryId)) {
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

/** 新建空白图并落盘；空白图不存第一版。 */
export function createBlankDiagram(database: TutorDatabase, repositoryId: string, name?: string): Diagram {
  const diagram = buildDiagram(repositoryId, { id: diagramId(id()), name: uniqueDiagramName(database, repositoryId, normalizeDiagramName(name) || "未命名图"), source: "me" });
  put(database, diagram);
  return diagram;
}

/** 同名就加序号：`系统分层总览` → `系统分层总览（2）`；图库内名字唯一。 */
export function uniqueDiagramName(database: TutorDatabase, repositoryId: string, wanted: string): string {
  const taken = new Set(listDiagrams(database, repositoryId).map((item) => item.name));
  if (!taken.has(wanted)) return wanted;
  let index = 2;
  while (taken.has(`${wanted}（${index}）`)) index += 1;
  return `${wanted}（${index}）`;
}

/** 结构落盘并追加一版；`note` 截到 120 字。 */
export function applyStructure(database: TutorDatabase, diagram: Diagram, body: DiagramBody, note: string): Diagram {
  const at = new Date().toISOString();
  const versions = [...diagram.versions, { at, note: note.slice(0, 120), body: clone(body) }];
  const next: Diagram = { ...diagram, body: clone(body), versions: versions.slice(-DIAGRAM_VERSION_LIMIT), updatedAt: at };
  put(database, next);
  return next;
}

/** 首次落盘一张画好的图，同时记为第一版。 */
export function insertDrawnDiagram(database: TutorDatabase, diagram: Diagram): Diagram {
  return applyStructure(database, diagram, diagram.body, "agent 初版");
}

/** 改名不动结构，不存版本；名字未变或为空返回 `undefined`。 */
export function renameDiagram(database: TutorDatabase, diagram: Diagram, name: string): Diagram | undefined {
  const next = normalizeDiagramName(name);
  if (!next || next === diagram.name) return undefined;
  const renamed: Diagram = { ...diagram, name: next, updatedAt: new Date().toISOString() };
  put(database, renamed);
  return renamed;
}

/** 只改节点的 x/y：不碰 versions，不推 updatedAt。 */
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

/** 恢复到某一版，并在历史末尾追加一版记录这次恢复。 */
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
  database.diagrams.remove(diagram.repositoryId, diagram.id);
}

/** 交出绑定单个仓的图画存取口。 */
export function diagramStoreFor(database: TutorDatabase, repositoryId: string) {
  return {
    list: () => listDiagrams(database, repositoryId),
    read: (diagramId: string) => readDiagram(database, repositoryId, diagramId),
    uniqueName: (wanted: string) => uniqueDiagramName(database, repositoryId, wanted),
    insert: (diagram: Diagram) => insertDrawnDiagram(database, diagram),
    applyStructure: (diagram: Diagram, body: DiagramBody, note: string) => applyStructure(database, diagram, body, note),
    createBlank: (name?: string) => createBlankDiagram(database, repositoryId, name),
    rename: (diagram: Diagram, name: string) => renameDiagram(database, diagram, name),
    saveGeometry: (diagram: Diagram, positions: readonly { id: string; x: number; y: number }[]) => saveGeometry(database, diagram, [...positions]),
    restore: (diagram: Diagram, index: number) => restoreVersion(database, diagram, index),
    delete: (diagram: Diagram) => deleteDiagram(database, diagram)
  };
}
