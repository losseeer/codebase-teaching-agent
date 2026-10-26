/**
  ==== 宏观设计 = agent 画图工作区 ====

  一句话：图是产物实体，不是某一页的渲染结果。一个仓有多张图，存在 `diagram` 表里，
  在左侧图库里挑、在中间画布上看。图元只有三种：节点、边、分组框。

  两条权限分得很清楚（这是这一页的全部纪律）：
  - 几何自由：节点摆哪儿、画布怎么平移缩放，都是用户自己的事，走 `PUT .../geometry`，
    不存版本、不写审计、不经模型——位置不承载对错；
  - 结构归 agent：加删节点、连线、分组、改名字，只有 `set_diagram` 这一个写入口（界面不留第二个）。
    每次结构改动自动存一版，上限 20 版，回滚也是往前追加一版（历史不许被改写）。

  三样东西的来源必须分开，混了就等于让模型编事实：
  - 节点挂的依据（哪些文件哪几行）与摘要：`kind:"module"` 的节点由引擎按 `ref` 现算，
    agent 手填的一律丢弃（见 engine `diagram/set-diagram.ts`）；
  - 边的可信度 `origin` 三档：模型可以报 `static`/`code`，但引擎只降不升——
    核不到 import / 调用证据就改成 `inferred`，并把降级原因写在 `downgraded` 上；
  - `kind:"note"` 的便签正文与 `inferred` 边的 `evidence`：这些是模型/用户说的话，
    原样存、原样标，不冒充引擎读数。
*/

/** 这张图是谁建的：agent 画的，还是用户自己新建空白的。图库与工具栏的徽标就看这一格。 */
export type DiagramSource = "agent" | "me";

/** 图元节点只有两种：挂在文件/目录/符号或分组上的模块节点，和一张便签。 */
export type DiagramNodeKind = "module" | "note";

/**
  一条边的可信度，三档封闭：
  - `static` 依赖图可证明（两个模块之间有文件级 import 边）；
  - `code` 源码正文读过（有调用 / 类型派发边可指）；
  - `inferred` 模型推断（没有行级依据，只有它自己那句话）。
*/
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
  /**
    `kind:"module"` 必填：画布代码实体的引用。
    支持 `file:<仓内路径>`、`dir:<仓内目录>`、`symbol:<仓内路径>#<名字>`、`group:<id>`；
    引擎按索引与依赖图核对，核不上就拒写。`group:` 必须同时给 `files`。
  */
  ref?: string;
  /**
    可选：这个节点显式关联的文件（`group:` 必填，其余可用来收窄范围）。
    引擎逐条核对是否在索引里；界面抽屉展示的就是这份清单。
  */
  files?: string[];
  /** `kind:"note"`：便签正文。这是人/模型写的话，不是读数。 */
  text?: string;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  origin: DiagramEdgeOrigin;
  /** 边上那句关系名（事务写入 / 校验参数……）只进抽屉，画布上不排字。 */
  label?: string;
  /** `static`/`code` 是引擎核出来的那条依据；`inferred` 是模型自述的理由。 */
  evidence?: string;
  /** 被引擎降过档：原报的哪一档 + 为什么。界面要在悬停里说清，不能替模型掩盖。 */
  downgraded?: string;
}

/** 分组框：一个标签加一块底。不可点、不可拖，纯排版记号（框住的是节点，不是关系）。 */
export interface DiagramGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一张图的结构本体。版本快照存的就是这一格。 */
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

/** 图库列表用的一行摘要：不拖整张图的结构进左栏。 */
export interface DiagramSummary {
  id: string;
  name: string;
  source: DiagramSource;
  updatedAt: string;
  nodes: number;
  edges: number;
  versions: number;
}

/**
  `set_diagram` 的一次结构改动（单写入口能表达的全部形状）。
  这里是白名单：想改边就只能是 add_edge / remove_edge，
  「把这条箭头变粗」「加一个模块」这类要求在类型层面就没有落点，不是运行时的漏洞。
*/
export type DiagramEdit =
  | { action: "draw"; name?: string; body: DiagramBody }
  | { action: "add_node"; node: DiagramNode }
  | { action: "remove_node"; target: string }
  | { action: "add_edge"; edge: DiagramEdge }
  | { action: "remove_edge"; target: string }
  | { action: "add_group"; group: DiagramGroup }
  | { action: "remove_group"; target: string }
  | { action: "relabel"; target: string; label?: string; sub?: string; text?: string }
  /** 几何：agent 替用户挪一格（用户自己拖走另一条免费路由，不进这里、不存版本）。 */
  | { action: "move"; target: string; x: number; y: number };

/** 一次结构改动的落点：改哪张图 + 改什么。`diagram` 缺省时由服务端按「画布上正打开的那张」定，认不出就拒。 */
export interface DiagramEditRequest {
  diagram?: string;
  edit: DiagramEdit;
}
