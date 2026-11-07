/** 图是产物实体，一仓多图存在 `diagram` 表里；结构改动只有 `set_diagram` 一个写入口，几何走 `PUT .../geometry`（不存版本、不写审计、不经模型）。
  `kind:"module"` 节点的依据与摘要由引擎按 `ref` 现算（agent 手填的丢弃）；边的 `origin` 引擎只降不升，核不到证据就改成 `inferred` 并记 `downgraded`。 */

/** `me` = 用户自己新建的空白图。 */
export type DiagramSource = "agent" | "me";

export type DiagramNodeKind = "module" | "note";

/** static = 有文件级 import 边可证；code = 读过源码正文，有调用/类型派发边可指；inferred = 模型推断，没有行级依据。 */
export type DiagramEdgeOrigin = "static" | "code" | "inferred";

export interface DiagramNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  /** 角色小字（入口 / 核心 / 环节 / 决策……）。`module` 节点没写就现算一个。 */
  sub?: string;
  /** 画布世界坐标，左上角，px。 */
  x: number;
  y: number;
  /** 挂在哪个分组框里（纯声明，不做包含判定）。 */
  group?: string;
  /** `kind:"module"` 必填：`file:<仓内路径>` / `dir:<仓内目录>` / `symbol:<仓内路径>#<名字>` / `group:<id>`；引擎按索引与依赖图核对，核不上就拒写，`group:` 必须同时给 `files`。 */
  ref?: string;
  /** 显式关联的文件（`group:` 必填，其余可用来收窄范围）；引擎逐条核对是否在索引里。 */
  files?: string[];
  /** `kind:"note"`：便签正文。这是人/模型写的话，不是读数。 */
  text?: string;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  origin: DiagramEdgeOrigin;
  /** 关系名只进抽屉，画布上不排字。 */
  label?: string;
  /** `static`/`code` 是引擎核出来的那条依据；`inferred` 是模型自述的理由。 */
  evidence?: string;
  /** 被引擎降过档：原报的哪一档 + 为什么。 */
  downgraded?: string;
}

/** 分组框：不可点、不可拖，纯排版记号（框住的是节点，不是关系）。 */
export interface DiagramGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 结构本体；版本快照存的就是这一格。 */
export interface DiagramBody {
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** 一版快照：时间是 ISO 串（界面自己格式化），`body` 是改完之后的整张结构。 */
export interface DiagramVersion {
  at: string;
  note: string;
  body: DiagramBody;
}

export interface Diagram {
  repositoryId: string;
  id: string;
  name: string;
  source: DiagramSource;
  createdAt: string;
  updatedAt: string;
  /** 旧→新排列，上限 20（超了丢最早的一版）。回滚同样往后追加，绝不截断历史。 */
  versions: DiagramVersion[];
  body: DiagramBody;
}

export interface DiagramSummary {
  id: string;
  name: string;
  source: DiagramSource;
  updatedAt: string;
  nodes: number;
  edges: number;
  versions: number;
}

/** `set_diagram` 一次结构改动的白名单。 */
export type DiagramEdit =
  | { action: "draw"; name: string; body: DiagramBody }
  | { action: "add_node"; node: DiagramNode }
  | { action: "remove_node"; target: string }
  | { action: "add_edge"; edge: DiagramEdge }
  | { action: "remove_edge"; target: string }
  | { action: "add_group"; group: DiagramGroup }
  | { action: "remove_group"; target: string }
  | { action: "relabel"; target: string; label?: string; sub?: string; text?: string }
  /** 几何：用户自己拖动走另一条路由，不进这里、不存版本。 */
  | { action: "move"; target: string; x: number; y: number };

/** `diagram` 缺省时按画布上正打开的那张定，认不出就拒；`draw` 例外：带 `diagram` 是整张替换（沿用原 id 与名字、上一版进版本历史），不带才是新建。 */
export interface DiagramEditRequest {
  diagram?: string;
  edit: DiagramEdit;
}

/** 图的模型规则：不碰存储也不碰 node 内置，发号要的随机数由调用方给；存储侧（`persistence/diagrams.ts`）与画图工具共用这一份。 */

export const DIAGRAM_VERSION_LIMIT = 20;

export const DIAGRAM_NAME_LIMIT = 40;

export const DIAGRAM_NODE_LIMIT = 120;
export const DIAGRAM_EDGE_LIMIT = 240;

/** 图的 id：`dg_` + 16 位十六进制（随机数由调用方发，这里只做形状收口）。 */
export const diagramId = (uuid: string): string => `dg_${uuid.replace(/-/g, "").slice(0, 16)}`;

/** 名字收口：去空白、压空格、限长；空串返回 ""，默认值由调用方决定（这里不猜）。 */
export function normalizeDiagramName(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, DIAGRAM_NAME_LIMIT);
}

/** 三个集合都在，读侧不必再判 undefined。 */
export const emptyDiagramBody = (): DiagramBody => ({ groups: [], nodes: [], edges: [] });

/** 版本时间戳给人看的那一档（MM-DD HH:mm）：ISO 串进库，界面与 note 里都用这一档。 */
export function versionStamp(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 建一张图（不落盘）；`id` 由调用方发。 */
export function buildDiagram(repositoryId: string, input: { id: string; name?: string; source: DiagramSource; body?: DiagramBody }): Diagram {
  const now = new Date().toISOString();
  return {
    repositoryId,
    id: input.id,
    name: normalizeDiagramName(input.name) || "未命名图",
    source: input.source,
    createdAt: now,
    updatedAt: now,
    // 初版由落盘那层记（insertDiagram），这里不给版本数组。
    versions: [],
    body: input.body ?? emptyDiagramBody()
  };
}
