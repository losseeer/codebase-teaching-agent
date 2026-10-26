import type { SymbolInfo } from "./dependency-graph.js";

/**
  ==== 静态产物层（facts）====

  依赖图回答「谁指向谁」，这一层回答单个函数内部的事：控制流、数据流、类型关系、注册与配置。
  它们与图同源（都出自同一份语法树），但形状完全不同，所以单独存一张按文件分片的表，
  既不写进 `analysis_json`（那是最重的一列），也不参与任何缓存键与 `backendStamp`——
  否则加一类产物就把已导入的仓全部翻键重算（红线探针 `pnpm arch:keyprobe` 钉这条）。

  三条口径，破了就等于这份产物在说谎：
  1. `backend: "none"` 与「这个文件真没有分支」是两件事，必须分开。语法树没就绪、或这个构造
     引擎还没写规则，都落到 `skipped` 里点名，不许静默交一张空图。
  2. 超大函数按 `truncated` 留痕，不悄悄砍。
  3. 每类产物都要在语言能力表里有自己的一格，逐语言照实填——没有规则就填 `unsupported`。
*/
export const FACT_KINDS = ["cfg", "dataflow", "typeRelations", "registry"] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export type FactBackend = "ast" | "none";

/** 一个没被算出来的构造：名字 + 说得出口的原因（与 `RepositoryIndex.unreadable` 同一口径）。 */
export interface FactSkip {
  name: string;
  reason: string;
}

/** 每类产物共有的四格：哪个文件、按哪门语言的语法树算的、算得成不成、哪一版判据算的。 */
export interface FactFileBase {
  path: string;
  language: string;
  backend: FactBackend;
  /** 产出这份读数的分析器版本：形状改了要 bump，读侧据此区分旧行，不拿旧形状当新结论 */
  version: string;
}

/** 控制流图的一个节点：一串顺序执行的语句，或一个判定。 */
export interface CfgBlock {
  id: number;
  kind: "entry" | "straight" | "branch" | "loop" | "selector" | "handler" | "exit";
  startLine: number;
  endLine: number;
  /** 块内语句的语法节点类型（原样、不去重）：块有多"厚"与它由什么构成，靠这一列判 */
  statements: string[];
}

export type CfgEdgeKind = "next" | "true" | "false" | "back" | "exception" | "finally";

export interface CfgEdge {
  from: number;
  to: number;
  kind: CfgEdgeKind;
}

export interface CfgFunction {
  /** 与 `SymbolInfo.id` 同格式，调用边按同一个键引用它 */
  symbolId: string;
  name: string;
  kind: SymbolInfo["kind"];
  startLine: number;
  endLine: number;
  blocks: CfgBlock[];
  edges: CfgEdge[];
  /** 没有后继的块（正常返回、隐式落到函数尾）——图上要能看出这个函数从哪儿出去 */
  exitBlocks: number[];
  /** 圈复杂度 = 判定节点数 + 1（分支、循环、switch 分支、catch 各计一格） */
  complexity: number;
  /** 接不上线的构造（`goto` 找不到标签、`break` 在循环外）：如实记一条，不猜一条边出来 */
  notes?: string[];
  truncated?: boolean;
}

export interface CfgFileFact extends FactFileBase {
  functions: CfgFunction[];
  skipped?: FactSkip[];
}

/** 一次定义或一次使用落在哪：行 + 控制流图上的块 + 它是哪种动作。 */
export type DataflowRole = "param" | "init" | "assign" | "read" | "argument" | "return";

export interface DataflowSite {
  line: number;
  /** `CfgFunction.blocks` 里那个块的 id；块是按行区间对上的 */
  block: number;
  role: DataflowRole;
}

export interface DataflowUse extends DataflowSite {
  /** 能到达这次使用的定义行（沿控制流图的边算出来，不是「同一函数里出现过的赋值」） */
  reaches: number[];
}

export interface DataflowVariable {
  name: string;
  defs: DataflowSite[];
  uses: DataflowUse[];
}

export interface DataflowFunctionFact {
  /** 与 `CfgFunction.symbolId` 同一个键 */
  symbolId: string;
  name: string;
  startLine: number;
  endLine: number;
  variables: DataflowVariable[];
  /** 读在写之前（这个函数里没有任何定义能到达它）：可能是外层变量、也可能是真 bug */
  unresolved?: { name: string; line: number }[];
  /** 变量数、单变量的使用数或不动点迭代打满上限：只留前面这些，不悄悄砍 */
  truncated?: boolean;
}

export interface DataflowFileFact extends FactFileBase {
  functions: DataflowFunctionFact[];
  skipped?: FactSkip[];
}

/**
  类型之间「谁用到谁」的那一类边。与依赖图的 `dispatch`（implements/extends 的文件级边）分开放：
  那边是为「让实现类接回执行流」服务的，只到文件为止；这里要的是类型名级别的全貌——
  字段指向哪个类型、泛型实参是谁、方法返回什么、参数收什么。

  落点（`toFile`）靠「类型名 → 声明了这个名字的文件」反查，与 `dispatch.supertypePath` 同一判据：
  同名类型可能指错，所以每条边都带 `via` 说明它是怎么来的，反查不到就不写 `toFile`（不猜）。
*/
export type TypeRelationKind = "extends" | "implements" | "field" | "parameter" | "returns" | "generic-argument" | "alias";

export interface TypeRelationEdge {
  /** 被关联到的类型名（原文，不带泛型实参） */
  to: string;
  kind: TypeRelationKind;
  /** 这一格写了什么判据：`extends 子句` / `字段类型标注` / `泛型实参` 等 */
  via: string;
  line: number;
  /** 反查到的仓内文件；空 = 仓外类型、标准库、或同名多解（不猜） */
  toFile?: string;
  /** 同名多解时把候选都列出来，读的人才知道这不是「没解析出来」 */
  ambiguous?: string[];
}

export interface DeclaredType {
  name: string;
  kind: "class" | "interface" | "struct" | "enum" | "alias" | "trait";
  line: number;
  endLine: number;
  relations: TypeRelationEdge[];
  truncated?: boolean;
}

export interface TypeRelationFileFact extends FactFileBase {
  types: DeclaredType[];
  skipped?: FactSkip[];
}

/**
  注册与配置索引：运行时才连上的那批关系。
  依赖图看不见它们——`@Autowired private OrderService svc` 没有一行调用，
  `app.use(router)` 的实参是个导入进来的对象，`META-INF/services` 更是纯文本清单。

  配置文件只记键名，绝不记值。这份产物落在被学习仓自己的 `.tutor/` 里，跟着仓库走、
  可被随仓删掉，但它仍是明文盘上文件：把 `spring.datasource.password=...` 抄进来，
  等于自己新开一个泄露面。值里有意义的那部分（比如「有没有配数据源」）由键名本身就能说出来。
*/
export type RegistryKind = "route" | "route-consumer" | "di-binding" | "registration" | "config-key" | "manifest";

export interface RegistryEntry {
  kind: RegistryKind;
  /** 被登记的东西：路由是归一化后的路径，DI 是接口名，注册点是中间件/插件名，清单是模块或入口 */
  name: string;
  /** 怎么认出来的：`Spring 注解` / `构造注入` / `app.use` / `SPI 清单` / `pom 模块` 等 */
  via: string;
  line: number;
  /** 指向谁：接口→实现、路由→处理函数、SPI 接口→实现类 */
  target?: string;
  /** 方法（路由用）：GET/POST…，认不出来就不写 */
  method?: string;
}

export interface RegistryFileFact extends FactFileBase {
  entries: RegistryEntry[];
  skipped?: FactSkip[];
}
