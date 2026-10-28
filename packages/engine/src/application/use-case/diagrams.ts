import { broadcast } from "../../events.js";
import { diagramFilesByNode, diagramWarnings } from "../../diagram/set-diagram.js";
import { withDiagramContext } from "../../infrastructure/diagram-context.js";
import { normalizeDiagramName, type Diagram, type DiagramSummary } from "@codebase-tutor/domain";
/** 几何落盘的一项：节点 id 与它的新位置。*/
export type DiagramPosition = { id: string; x: number; y: number };
import { repositoryOr404 } from "../../infrastructure/composition-root.js";


/**
  画布的用例：列、建、读、改名、删、几何落盘、恢复某一版。
  几何不存版本、不写审计、不广播；结构只能经 agent 的 `set_diagram` 写；建 / 改名 / 删 / 恢复由界面直发并各记一行审计。
*/
export type DiagramFailure =
  | { kind: "repository-missing" }
  | { kind: "diagram-missing" }
  | { kind: "name-taken"; name: string }
  | { kind: "name-unchanged"; name: string }
  | { kind: "name-empty" }
  | { kind: "version-missing"; index: number; total: number };

export type DiagramResult<T> = { ok: true; value: T } | { ok: false; failure: DiagramFailure };

const missing: DiagramResult<never> = { ok: false, failure: { kind: "repository-missing" } };

// pin/unpin 与写上下文装配在 `infrastructure/diagram-context.ts`；这一层只认 `context.store`。

/** 图库列表：只回摘要，不含结构。 */
export function listDiagramsUseCase(repositoryId: string): DiagramResult<{ diagrams: DiagramSummary[] }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return { ok: true, value: { diagrams: withDiagramContext(repository, (context) => context.store.list()) } };
}

/** 新建一张空白图；名字撞了加序号，图库内不允许同名。 */
export function createDiagramUseCase(repositoryId: string, name?: string): DiagramResult<{ diagram: Diagram }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDiagramContext(repository, (context) => {
    const diagram = context.store.createBlank(name);
    repository.audit.append("diagram_created", {
      diagram: diagram.id, name: diagram.name, source: diagram.source, nodes: diagram.body.nodes.length, edges: diagram.body.edges.length, downgraded: 0, via: "user"
    });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: diagram.id, action: "created" } });
    return { ok: true, value: { diagram } } as const;
  });
}

/** 单张图 + 读侧复检：图上的模块节点是否还能对上现在的索引。 */
export function readDiagramUseCase(repositoryId: string, diagramId: string): DiagramResult<{ diagram: Diagram; warnings: ReturnType<typeof diagramWarnings>; filesByNode: ReturnType<typeof diagramFilesByNode> }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDiagramContext(repository, (context) => {
    const diagram = context.store.read(diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    return { ok: true, value: { diagram, warnings: diagramWarnings(context, diagram), filesByNode: diagramFilesByNode(context, diagram) } } as const;
  });
}

/** 改名不存版本；未改动与重名是两条不同的失败。 */
export function renameDiagramUseCase(repositoryId: string, diagramId: string, rawName: string): DiagramResult<{ diagram: Diagram }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDiagramContext(repository, (context) => {
    const diagram = context.store.read(diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    const wanted = normalizeDiagramName(rawName);
    if (wanted && context.store.list().some((item) => item.id !== diagram.id && item.name === wanted)) {
      return { ok: false, failure: { kind: "name-taken", name: wanted } } as const;
    }
    const renamed = context.store.rename(diagram, rawName);
    if (!renamed) return { ok: false, failure: wanted ? { kind: "name-unchanged", name: diagram.name } : { kind: "name-empty" } } as const;
    repository.audit.append("diagram_renamed", { diagram: renamed.id, from: diagram.name, to: renamed.name });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: renamed.id, action: "renamed" } });
    return { ok: true, value: { diagram: renamed } } as const;
  });
}

/** 删除一张图，版本历史一并删除；审计记下名字与版数。 */
export function deleteDiagramUseCase(repositoryId: string, diagramId: string): DiagramResult<{ deleted: true; diagramId: string }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDiagramContext(repository, (context) => {
    const diagram = context.store.read(diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    context.store.delete(diagram);
    repository.audit.append("diagram_deleted", { diagram: diagram.id, name: diagram.name, versions: diagram.versions.length });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: diagram.id, action: "deleted" } });
    return { ok: true, value: { deleted: true, diagramId: diagram.id } } as const;
  });
}

/** 几何落盘：认不出的节点 id 由 `saveGeometry` 跳过，这里不因此拒绝。 */
export function saveGeometryUseCase(repositoryId: string, diagramId: string, positions: DiagramPosition[]): DiagramResult<{ diagram: Diagram }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDiagramContext(repository, (context) => {
    const diagram = context.store.read(diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    return { ok: true, value: { diagram: context.store.saveGeometry(diagram, positions) } } as const;
  });
}

/** 恢复某一版；恢复动作本身也存一版。 */
export function restoreDiagramUseCase(repositoryId: string, diagramId: string, index: number): DiagramResult<{ diagram: Diagram }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDiagramContext(repository, (context) => {
    const diagram = context.store.read(diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    const restored = context.store.restore(diagram, index);
    if (!restored) return { ok: false, failure: { kind: "version-missing", index, total: diagram.versions.length } } as const;
    repository.audit.append("diagram_restored", { diagram: restored.id, to: index, note: restored.versions[restored.versions.length - 1]?.note ?? "" });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: restored.id, action: "restored" } });
    return { ok: true, value: { diagram: restored } } as const;
  });
}
