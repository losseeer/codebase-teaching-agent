import { broadcast } from "../../events.js";
import { diagramFilesByNode, diagramWarnings } from "../../diagram/set-diagram.js";
import { diagramWriteContextFor } from "../../infrastructure/canvas-tools.js";
import { normalizeDiagramName } from "@codebase-tutor/domain";
import { createBlankDiagram, deleteDiagram, listDiagrams, readDiagram, renameDiagram, restoreVersion, saveGeometry } from "../../adapter/outbound/persistence/diagrams.js";
/** 几何落盘的一项：节点 id 与它的新位置。*/
export type DiagramPosition = { id: string; x: number; y: number };
import { repositoryOr404 } from "../../infrastructure/composition-root.js";

type Mounted = NonNullable<ReturnType<typeof repositoryOr404>>;

/**
  画布的用例：列、建、读、改名、删、几何落盘、恢复某一版。
  图是产物实体，不是某一页的渲染结果：一个仓可以有很多张，住在 `diagram` 表里。

  权限划分在这里说清楚，controller 只把结果翻成状态码：

  - 几何：位置不承载对错，所以不存版本、不写审计、不广播——拖动频次高，进任何一条记录线都会淹掉真信号，
    广播那一帧还会抢鼠标；
  - 结构（加删节点、连线、分组）：界面对结构只能读，写只能经 agent 的 `set_diagram` 一个入口
    （`diagram/set-diagram.ts`），避免两条写路径各写一套校验与记账；
  - 建、改名、删、恢复动的是这张图这个实体而不是它的结构，所以由界面直发，各自记一行审计、广播一帧。

  读侧全是纯读：没有任何一步会发模型请求（`diagramWarnings` / `diagramFilesByNode` 只比对索引与依赖图）。
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

/** 一次取用把句柄 pin 住，做完再放：LRU 驱逐不该发生在半个请求中间。 */
function withDatabase<T>(repository: Mounted, run: (database: ReturnType<Mounted["handle"]["pin"]>) => T): T {
  const database = repository.handle.pin();
  try {
    return run(database);
  } finally {
    repository.handle.unpin();
  }
}

/** 图库列表：只回摘要，不拖整张图的结构进左栏。 */
export function listDiagramsUseCase(repositoryId: string): DiagramResult<{ diagrams: ReturnType<typeof listDiagrams> }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return { ok: true, value: { diagrams: withDatabase(repository, (database) => listDiagrams(database, repository.index.repositoryId)) } };
}

/** 新建一张空白图：名字撞了由 `uniqueDiagramName` 加序号——图库与 agent 都靠名字认图，不允许两张同名。 */
export function createDiagramUseCase(repositoryId: string, name?: string): DiagramResult<{ diagram: ReturnType<typeof createBlankDiagram> }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDatabase(repository, (database) => {
    const diagram = createBlankDiagram(database, repository.index.repositoryId, name);
    repository.audit.append("diagram_created", {
      diagram: diagram.id, name: diagram.name, source: diagram.source, nodes: diagram.body.nodes.length, edges: diagram.body.edges.length, downgraded: 0, via: "user"
    });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: diagram.id, action: "created" } });
    return { ok: true, value: { diagram } } as const;
  });
}

/** 单张图 + 读侧的引用复检：图上的模块节点还指得着现在的索引吗（图是历史产物，文件会改名、目录会删）。 */
export function readDiagramUseCase(repositoryId: string, diagramId: string): DiagramResult<{ diagram: NonNullable<ReturnType<typeof readDiagram>>; warnings: ReturnType<typeof diagramWarnings>; filesByNode: ReturnType<typeof diagramFilesByNode> }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDatabase(repository, (database) => {
    const diagram = readDiagram(database, repository.index.repositoryId, diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    const context = diagramWriteContextFor(repository, database);
    return { ok: true, value: { diagram, warnings: diagramWarnings(context, diagram), filesByNode: diagramFilesByNode(context, diagram) } } as const;
  });
}

/** 改名：不存版本（它不动结构）。「一个字都没改」与「图库里已经有这个名字」是两条不同的 400。 */
export function renameDiagramUseCase(repositoryId: string, diagramId: string, rawName: string): DiagramResult<{ diagram: NonNullable<ReturnType<typeof renameDiagram>> }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDatabase(repository, (database) => {
    const diagram = readDiagram(database, repository.index.repositoryId, diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    const wanted = normalizeDiagramName(rawName);
    if (wanted && listDiagrams(database, repository.index.repositoryId).some((item) => item.id !== diagram.id && item.name === wanted)) {
      return { ok: false, failure: { kind: "name-taken", name: wanted } } as const;
    }
    const renamed = renameDiagram(database, diagram, rawName);
    if (!renamed) return { ok: false, failure: wanted ? { kind: "name-unchanged", name: diagram.name } : { kind: "name-empty" } } as const;
    repository.audit.append("diagram_renamed", { diagram: renamed.id, from: diagram.name, to: renamed.name });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: renamed.id, action: "renamed" } });
    return { ok: true, value: { diagram: renamed } } as const;
  });
}

/** 删掉一张图：版本历史一起没，所以这一行审计要留得住名字与版数。 */
export function deleteDiagramUseCase(repositoryId: string, diagramId: string): DiagramResult<{ deleted: true; diagramId: string }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDatabase(repository, (database) => {
    const diagram = readDiagram(database, repository.index.repositoryId, diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    deleteDiagram(database, diagram);
    repository.audit.append("diagram_deleted", { diagram: diagram.id, name: diagram.name, versions: diagram.versions.length });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: diagram.id, action: "deleted" } });
    return { ok: true, value: { deleted: true, diagramId: diagram.id } } as const;
  });
}

/**
  几何落盘：认不出来的节点 id 由 `saveGeometry` 一个个跳过（图上没有的东西不该因为一次陈旧拖拽被造出来），
  所以这里不为「有几个 id 没落上」而拒。
  */
export function saveGeometryUseCase(repositoryId: string, diagramId: string, positions: DiagramPosition[]): DiagramResult<{ diagram: NonNullable<ReturnType<typeof readDiagram>> }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDatabase(repository, (database) => {
    const diagram = readDiagram(database, repository.index.repositoryId, diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    return { ok: true, value: { diagram: saveGeometry(database, diagram, positions) } } as const;
  });
}

/** 恢复某一版：恢复动作本身也存一版（为什么不能截断历史见 `persistence/diagrams.ts` 的 `restoreVersion`）。 */
export function restoreDiagramUseCase(repositoryId: string, diagramId: string, index: number): DiagramResult<{ diagram: NonNullable<ReturnType<typeof restoreVersion>> }> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missing;
  return withDatabase(repository, (database) => {
    const diagram = readDiagram(database, repository.index.repositoryId, diagramId);
    if (!diagram) return { ok: false, failure: { kind: "diagram-missing" } } as const;
    const restored = restoreVersion(database, diagram, index);
    if (!restored) return { ok: false, failure: { kind: "version-missing", index, total: diagram.versions.length } } as const;
    repository.audit.append("diagram_restored", { diagram: restored.id, to: index, note: restored.versions[restored.versions.length - 1]?.note ?? "" });
    broadcast({ type: "diagram_updated", payload: { repositoryId: repository.index.repositoryId, diagramId: restored.id, action: "restored" } });
    return { ok: true, value: { diagram: restored } } as const;
  });
}
