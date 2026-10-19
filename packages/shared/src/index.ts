import type {
  ChatScope,
  ChatThread,
  ChatThreadMessage,
  CostBucket,
  CostComponent,
  CostDay,
  CostSummary,
  ImportJob,
  JobPhase,
  RepositoryCatalogEntry,
  RepositoryFreshness,
  RepositoryFreshnessVerdict,
  RepositoryMountReason,
  ScopedStreamFrame,
  ScopedStreamProgress,
  ServerEvent,
  TeachingProgress,
  TurnScene
} from "./contracts.js";

export type {
  ChatScope,
  ChatThread,
  ChatThreadMessage,
  CostBucket,
  CostComponent,
  CostDay,
  CostSummary,
  ImportJob,
  JobPhase,
  RepositoryCatalogEntry,
  RepositoryFreshness,
  RepositoryFreshnessVerdict,
  RepositoryMountReason,
  ScopedStreamFrame,
  ScopedStreamProgress,
  ServerEvent,
  TeachingProgress,
  TurnScene
} from "./contracts.js";
export { checkContract, ContractViolation, scopedStreamProgressSchema, serverEventSchema, importJobSchema, repositoryCatalogEntrySchema, costSummarySchema, chatThreadSchema, chatThreadMessageSchema } from "./contracts.js";

/**
  引擎侧共享出口。跨进程流动的形状住在 `contracts.ts`（zod schema 反推类型）；
  界面只从 `wire.ts` 取（contracts + 界面真正消费的领域类型），不再直接依赖这里的引擎内部模型
  （课程树、图、切片、练习……）与辅助函数。
*/

export interface FileEntry {
  path: string;
  extension: string;
  bytes: number;
  lines: number;
  /** 正文 SHA-256 前 16 位；缺这个字段时出题键回落到全仓 `versionStamp` 语义。 */
  contentHash?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileTreeNode[];
}

export interface Hotspot {
  path: string;
  changes: number;
}

/**
  文件在仓库里扮演的角色（架构层的粗分类）。只在「文件」这一粒度上取值：
  core = 执行主干；support = 支撑逻辑；infra = 外部设施接入（配置、存储、日志、网络客户端）；
  tool = 末端工具（无依赖也不被依赖）；test = 测试。
  口径由 `depgraph/roles.ts` 的结构规则给出（确定、可复现），不依赖模型。
*/
export type FileRole = "core" | "support" | "infra" | "tool" | "test";

export interface RepositoryIndex {
  repositoryId: string;
  repositoryPath: string;
  scannedAt: string;
  totalFiles: number;
  totalLines: number;
  files: FileEntry[];
  fileTree: FileTreeNode[];
  hotspots: Hotspot[];
  /**
    扫描期读不出来的文件（读到一半被删、权限不对、被换成特殊节点）。默认 = 一个都没有。
    这些文件被跳过而不算失败（一个坏文件不该掀掉整次导入），但必须记名：
    `totalFiles` 与后面所有「这个仓有多少代码、哪些文件没摘要」的读数都建立在「缺席是知道的」之上。
    上限 50 条，超出只按前 50 条报（够定位问题目录）。
  */
  unreadable?: UnreadableFile[];
}

/** 扫描期读不到的一个文件与其报错首行（原因要说得出口，不能只给「少了」）。 */
export interface UnreadableFile {
  path: string;
  reason: string;
}

export interface SourceAnchor {
  path: string;
  line: number;
  endLine?: number;
  label: string;
}

/**
  模块分级（分级折叠用，引擎在 `/course` 响应前实时计算，不落树）：
  - `core` 主干 = 模块里有入口，或执行主干文件占到可见文件的四分之一；
  - `facility` 基础设施 = 只有支撑逻辑或外部设施接入（配置、存储、网络客户端）；
  - `periphery` 外围 = 只剩末端工具与测试（文档、监控看板、压测报表都在这里）。
  判据来自 `depgraph/roles.ts` 的结构规则（确定、可复现），不依赖模型。
  占比门槛是为了别让一个文件把几十文件的模块抬成主干。
*/
export type CourseTier = "core" | "facility" | "periphery";

/**
  分级依据（与 `tier` 一起实时计算，给界面把判据露出来）：分不准时先要看得见为什么这么分。
  `decidingPath` 是把模块抬成主干的那个文件；`entryFiles`/`coreFiles`/`visibleFiles` 是数出来的量。
*/
export interface CourseTierEvidence {
  visibleFiles: number;
  coreFiles: number;
  entryFiles: number;
  /** 可见文件里被判主干的占比（0~1）。 */
  coreShare: number;
  decidingPath?: string;
  /** 为什么是这个档：一句话（中文，界面原样显示）。 */
  reason: string;
}

export interface CourseNode {
  id: string;
  title: string;
  summary: string;
  kind: "overview" | "workflow" | "module" | "implementation";
  anchors: SourceAnchor[];
  children: CourseNode[];
  /** 仅 module 节点有值：界面据此把「外围」折起来，首屏只露主链路与基础设施 */
  tier?: CourseTier;
  /** 仅 module 节点有值，与 `tier` 同时实时计算：这一档是按哪些数判出来的 */
  tierEvidence?: CourseTierEvidence;
  /**
    仅 module 节点有值：`tier` 被人工改过时为 true，并带上引擎自己判的那一档。
    界面得知道现在这个档是谁说的，否则「恢复引擎判据」没有依据，
    「分得准不准」的读数也只剩一个孤零零的改后值。
  */
  tierOverridden?: boolean;
  tierGiven?: CourseTier;
}

export interface CourseTree {
  repositoryId: string;
  modelVersion: string;
  generatedAt: string;
  root: CourseNode;
}

/**
  外部包的分类档。类型放在 shared（图上的「边界之外」栏与它对得上），
  具体词典在引擎侧 `depgraph/external-catalog.ts`（那是数据，且只覆盖真实遇到的包）。
  `stdlib` 单列：语言自带的东西不算「系统之外」，混进 `other` 会把那一栏灌满噪声。
  `other` 的界面档名叫「未识别」而不是「外部依赖」——没认出来就别说自己知道它是什么。
*/
export type ExternalCategory = "database" | "cache" | "queue" | "model" | "http-client" | "framework" | "testing" | "stdlib" | "other";

export const EXTERNAL_CATEGORY_LABEL: Record<ExternalCategory, string> = {
  database: "数据存储",
  cache: "缓存",
  queue: "队列",
  model: "模型服务",
  "http-client": "外部接口",
  framework: "框架与库",
  testing: "测试框架",
  stdlib: "语言自带",
  other: "未识别"
};

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

/** 图元节点只有两种：挂在课程树上的模块节点，和一张便签。 */
export type DiagramNodeKind = "module" | "note";

/**
  一条边的可信度，三档封闭：
  - `static` 依赖图可证明（两个模块之间有文件级 import 边）；
  - `code` 源码正文读过（有调用 / 类型派发边可指）；
  - `inferred` 模型推断（没有行级依据，只有它自己那句话）。
*/
export type DiagramEdgeOrigin = "static" | "code" | "inferred";

/** 节点上的一条依据：文件 + 行号。`module` 节点读时现算，不落在图里。 */
export interface DiagramAnchor {
  path: string;
  line: number;
}

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
    `kind:"module"` 必填：课程树里的模块 id 或画布模块块 id（`arch:...`）。
    引擎按它现算依据与摘要，id 核不上就拒写（宁可让 agent 重说一次，也不画一个查无此人的节点）。
  */
  ref?: string;
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


/**
  一次模块档位修正的意图（Agent 的 `set_module_tier` 与覆盖层写入口共用）。
  只表达「这个模块归哪一档」与「撤销」：层、边、文件都不在这里，类型层面就写不出。
*/
export type ModuleTierOverrideIntent =
  | { kind: "set_tier"; module: string; tier: CourseTier; given?: string }
  | { kind: "reset"; module?: string };

export interface ModuleOverlayRecord {
  renamed?: Record<string, string>;
  hidden?: string[];
  custom?: { id: string; label: string; hint?: string }[];
  tier?: Record<string, CourseTier>;
}

export interface RepositoryOverlays {
  modules?: ModuleOverlayRecord;
}

export interface ImportEstimate {
  cachedFiles: number;
  summarizedFiles: number;
  estimatedInputTokens: number;
  estimatedCostUsd: number;
  provider: string;
  modelVersion: string;
  /** 本次新算的摘要里，有多少条没拿到模型结果、由确定性档补齐（旧数据没有该字段）。 */
  fallbackFiles?: number;
}

/** 风格档是 0~100 的连续值；预设值仍是 35、50、65。 */
export type StyleLevel = number;

/**
  语言风格档位的判据与展示名 —— engine 与 GUI 的唯一来源（两侧都从这里取，不各写阈值）：
  别处写死一个数字就会和这里的取值不一致，同一个滑块出现两套口径。
  档位只决定基调和回显名；档内的逐步细化在 engine 的 harness/prompts.ts（那里的 `at` 阈值是叠加在档位之上的补充要求）。
*/
export const STYLE_BAND_THRESHOLDS = { rigorousMax: 33, plainMin: 67 } as const;

export type StyleBand = "plain" | "neutral" | "rigorous";

export const STYLE_BAND_LABEL: Record<StyleBand, string> = { rigorous: "严肃", neutral: "普通", plain: "通俗" };

/** 非有限值（NaN / Infinity）按中间档（普通）处理，与 engine `validateStyle` 的回落值 50 落在同一档。 */
export function styleBand(style: number): StyleBand {
  if (!Number.isFinite(style)) return "neutral";
  if (style >= STYLE_BAND_THRESHOLDS.plainMin) return "plain";
  if (style <= STYLE_BAND_THRESHOLDS.rigorousMax) return "rigorous";
  return "neutral";
}

export type Pedagogy = "socratic" | "explanatory" | "practice";
export type DecompositionDepth = "macro" | "micro";

/**
  教学回合是纯问答：不推进阶段、不记 fallbackCount，也不产生提示阶梯那一类事件。
  库里与 journal 的历史行仍带着阶段与阶梯的取值，读侧不再解释它们（字段留在 SQLite 列里不迁移）。
*/
export interface TeachingPolicy {
  level: StyleLevel;
  label: string;
  constraints: string[];
  pedagogy: Pedagogy;
  depth: DecompositionDepth;
}

export interface TutorSettings {
  style: StyleLevel;
  pedagogy: Pedagogy;
  depth: DecompositionDepth;
}

export interface TutorMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface TutorSession {
  id: string;
  repositoryId: string;
  courseNodeId: string;
  style: StyleLevel;
  settings: TutorSettings;
  messages: TutorMessage[];
  createdAt: string;
}

/**
  会话持久化的作用域：三种对话各自独立成列表（teach 绑课程节点，practice 绑练习题，map 可不绑）。
  与 journal 的 `turn_text.scene`（teach / map_chat / practice_chat）是两套口径——前者是产品域的会话归属，
  后者是审计线的事件标签，不强行统一。
  */
export interface SymbolInfo {
  id: string;
  name: string;
  /** `type` = 接口/类型别名/枚举这类只有声明没有可执行体的名字；`method` = 类或对象里的方法。 */
  kind: "function" | "class" | "method" | "variable" | "type";
  path: string;
  line: number;
  endLine: number;
  parameters: string[];
  language: "typescript" | "python" | "java" | "go" | "rust" | "csharp" | "cpp" | "other";
  type?: string;
  referenceCount?: number;
}

export interface CallEdge {
  callerPath: string;
  callerSymbol?: string;
  calleePath: string;
  calleeSymbol?: string;
  line: number;
}

/**
  类型派发边：`实现类/子类的文件 → 它 extends/implements 的那个类型所在的文件`。

  为什么要单独一类边而不是写入 `imports`：Java/C# 的「控制器注入接口、运行时才绑到实现」这一拍
  在源码里没有调用行，import 边只到接口为止，于是实现类整片在图上失联。方向反过来是
  「接口 → 实现」的派发，这是执行流，不是依赖流，混进 import 边会把「谁依赖谁」说反。

  TS/Python 不产这类边：那两门语言的继承/实现必须先 import 那个名字，关系已经在 import 边里了。
  `supertypePath` 靠类名→文件解析，同名类型可能指错，故它是近似证据，不是权威结论。
*/
export interface TypeDispatchEdge {
  subtypePath: string;
  supertypePath: string;
  kind: "implements" | "extends";
  line: number;
}

export interface DependencyGraphData {
  imports: Record<string, string[]>;
  /**
    每个文件「仓内解析不到的裸包名」（`redis`、`@fastify/cors`、`org.springframework`、`github.com/gin-gonic`）。
    它是图上「边界之外」栏的唯一数据源，且与 `imports` 严格分家：
    `imports` 只连仓内文件、外部一律丢弃（这是既定设计，见上面 `languageOfExtension` 那段），
    这里只是把被丢掉的名字留个名，不新增任何一条边。
    出题的缓存键不吃这个节点：`graphStampOf` 只数三类边。
    把它写进任何一份 payload = 已缓存题目翻键 = 每仓重付一次付费调用。
    产物没有这个字段时按「未采集」处理，与 `dispatch` 同一口径——不是「这个仓没有外部依赖」。
  */
  externals?: Record<string, string[]>;
  calls: CallEdge[];
  /** 类型派发边；产物没有这个字段时按空表处理。 */
  dispatch?: TypeDispatchEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: { language: "typescript" | "python"; status: "available" | "fallback"; reason?: string }[];
  /**
    符号抽取走的哪条路：`ast` = 语法树（准确），`regex` = 逐行文本匹配（回落，只在语法解析器加载失败时出现）。
    字段缺失视为 `regex`。
  */
  parseBackend?: "ast" | "regex";
  parseBackendReason?: string;
}

/**
  ==== 语言能力表（引擎自报口径）====

  这是什么：每门语言 × 五个能力格的取值，只回答「引擎现在真的能做到什么程度」。
  为什么要单独成表：各语言的支持程度本来就不均——符号抽取走真实语法树（多语法，加载失败会回落逐行匹配），
  import 落点是每语言一条自己的规则（Java 全限定类名、Go 包目录、C# 命名空间、TS 相对路径 + 别名、
  Python 点号模块、C/C++ 头文件），入口判定只有部分语言有权威规则，构建清单只读了三份
  （package.json / tsconfig / go.mod）。这些差异只写在引擎代码里时，界面与读数都看不出来，
  用户拿到一张图没法判断「这条边是编译器级的、还是按文件名猜的」。

  四条纪律，违反任何一条就等于这张表在误导人：
  1. 它是引擎自报口径，与 `packages/engine/src/depgraph/graph.ts` + `parser.ts` 的实现必须同步：
     新增一门语言、补了某条规则，就改这张表；别在 GUI 或提示词里另写一份判断。
  2. 取值照实填，别因为「想让表好看」抬高某一个节点。判据见下面 `CapabilityLevel`。
  3. 纯元数据：不参与建图、不进任何缓存键（图的内容、`backendStamp`、摘要与润色缓存都与它无关），
     改这张表不会引发流程或摘要重算。真要挪走这份口径，先确认没有键把它算进去。
  4. 它跟 `DependencyGraphData.lspStatus` 是两套口径，别混用：本表说「引擎自己的规则有多硬」，
     `lspStatus` 说「有没有借到外部语义服务补类型与被引用次数」（目前只有 TypeScript 与 Python 会去探测）。
*/

/**
  三档的判据（写死在这里，避免引擎、界面、提示词各说一套）：
  - `exact` 可信：按这门语言/框架的权威规则落点，命中即可信。不足之处只会表现为「没覆盖到、少画一条」，
    而不是「画了一条错的」。
  - `approximate` 近似：规则在，但依据是启发式或粒度偏粗——同一条边可能多连几个文件，也可能落到同名文件上。
  - `unsupported` 未覆盖：没有针对这门语言的专门规则，只剩跨语言的通用兜底（按文件名猜），或这类文件根本不进图。

  未知语言一律回落 `unsupported`，不许按 `approximate` 装「大概能行」——近似必须显式。
*/
export type CapabilityLevel = "exact" | "approximate" | "unsupported";

/**
  九个能力格（GUI 与单测都按这份清单遍历，加格要一起改表与测试）：
  前五格说依赖图，后四格说静态产物层（`static_fact` 表，不参与任何缓存键）。
  - `symbolExtraction` 符号抽取：函数/类/方法是怎么被认出来的、起止行可不可信
  - `dependencyEdge` 依赖边落点：一条依赖边指向哪个文件，可信到什么程度
  - `entrypoint` 入口判定：图上标成「执行入口」的那个文件是怎么定的
  - `packageResolution` 路径别名与包解析：`@/x`、`crate::x`、`com.a.B` 这类非相对路径靠什么落点
  - `buildVisibility` 构建可见性：读不读这门语言的构建/清单文件，因而知不知道「哪些文件真在一起编译」
  - `controlFlow` 控制流图：函数内的分支、循环、跳转边编不编得出来
  - `dataflow` 函数内数据流：一个变量在哪行被定义、哪些行读到它
  - `typeRelations` 类型关系：继承/实现/字段/参数/返回值这些边，以及它们指到哪个文件
  - `registry` 注册与配置索引：路由、依赖注入绑定、SPI 清单、构建清单里的键
*/
export const CAPABILITY_CELLS = ["symbolExtraction", "dependencyEdge", "entrypoint", "packageResolution", "buildVisibility", "controlFlow", "dataflow", "typeRelations", "registry"] as const;

export type CapabilityCell = (typeof CAPABILITY_CELLS)[number];


/** 三档的中文显示名。`unsupported` 直说「没有规则」，不用「未支持」这种看着像「差一点就支持」的说法。 */
export const CAPABILITY_LEVEL_LABEL: Record<CapabilityLevel, string> = {
  exact: "可信",
  approximate: "近似",
  unsupported: "没有规则"
};

export interface LanguageCapabilities {
  /** 语言 id，与本表的键一致；界面显示用 `displayName`，别直接露这个。 */
  language: string;
  displayName: string;
  /** 依赖图里归到这门语言的扩展名。各条目的这一列汇总成 `LANGUAGE_BY_EXTENSION`，不在别处再列一份。 */
  extensions: string[];
  /** 各格的取值；类型是必填的 `Record`，漏一个节点编译就过不去。 */
  cells: Record<CapabilityCell, CapabilityLevel>;
  /** 每个节点一句白话：说清「为什么是这一档」以及「看到这档该当怎么读」。界面提示条直接用它。 */
  notes: Record<CapabilityCell, string>;
}

/**
  表体。取值依据 = 当前实现（graph.ts 的分派 + parser.ts 的语法覆盖 + roles.ts 的测试路径判定），
  每一个节点都注了降级理由。改动实现后请同步这里，engine 侧有一份单测钉住「本表的扩展名清单
  与 `DependencyGraph` 实际处理的扩展名清单不漂移」。
  只用 `satisfies` 不用 `as const`：键的字面量类型留着（`SupportedLanguage` 靠它），
  但值里的 `extensions` 需要是可写数组，`as const` 会让它变成只读元组而通不过类型检查。
*/
export const LANGUAGE_CAPABILITIES = {
  typescript: {
    language: "typescript",
    displayName: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    cells: { symbolExtraction: "exact", dependencyEdge: "exact", entrypoint: "approximate", packageResolution: "approximate", buildVisibility: "approximate", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、类、方法、接口与类型别名，起止行是解析出来的而不是按大括号数出来的。语法树整体加载失败时引擎会回落逐行匹配，并在图数据里写明回落原因。",
      dependencyEdge: "边来自真正的 import / export 语句，落点按「同名文件是否真在仓库里」逐个验证，而且只试这一门语言（含 Vue 与 TS 互引这一族）的扩展名——TS 里写 `./util` 不会连到同目录的 `util.py`。第三方包与解析不到的写法不会画出来，所以这里的少边是真少，不是连错。",
      entrypoint: "框架入口是精确的：Fastify / Express / Koa / Nest 的实例构造、路由登记与 listen 都算服务入口；客户端调用（axios 那种 api.get 一个路径）刻意不算，它是打路由的一方。证据行落在注释或跨行模板字符串里的也不算——这个节点判据取自语法树。剩下的靠 package.json 的 main / bin / scripts 与文件名（main、index、app、server、cli）猜：同名但并非入口的文件会被误标，实例从形参进来的子路由文件认不出来。",
      packageResolution: "只读仓库根那一份 tsconfig.json 的 paths，且只认带星号的通配别名（如 `@/*` → `src/*`）；精确别名、通过 extends 继承来的配置、包内的导出映射都不读，这类别名导入会画不出边。",
      buildVisibility: "读过根 package.json 与 tsconfig.json，但没有应用 include / exclude，也不看子包配置，所以图里的文件集合来自目录扫描，不受构建范围约束。",
      controlFlow: "if / 三元 / 循环（含 do-while 的先跑后判）/ switch（含无 break 的贯穿）/ try-catch-finally / return / throw / break / continue 全部按语法树编成节点与边，圈复杂度是「边数 − 节点数 + 2」算出来的而不是数分支数出来的。可选链与短路只用一条边近似表达先后，不逐子表达式分叉。",
      dataflow: "定义与读到按「名字」记：`a.x = 1` 记成对 `a` 的一次写，成员与解构不拆开；不做别名与指针分析，也不跨函数（谁传进来的参数在函数外被改，这里看不见）。多分支汇合处用并集，所以某行读到的定义是「可能到达」而不是「一定到达」。读不到本仓定义的名字进 `unresolved`，外部件与上游传值都混在这一格。",
      typeRelations: "边（继承 / 实现 / 字段 / 参数 / 返回值 / 泛型实参 / 类型别名）取自语法树，形状可信；但「这个类型定义在哪个文件」是按名字在全仓反查——同名类型会标成 `ambiguous`，第三方与标准库类型查不到落点（边留着，`toFile` 空着）。",
      registry: "认的是写法不是执行：`app.use(...)`、`router.get(\"/x\")`、Nest 的装饰器这类登记语句命中即入册，运行时未必真跑到。没覆盖的框架（自建路由表、插件按约定加载）只剩通用写法兜底；配置文件只进「键名」，值一律不抄（`.tutor` 目录是明文，抄口令就多一处泄露面）。"
    }
  },
  vue: {
    language: "vue",
    displayName: "Vue 组件",
    extensions: [".vue"],
    cells: { symbolExtraction: "approximate", dependencyEdge: "approximate", entrypoint: "unsupported", packageResolution: "approximate", buildVisibility: "unsupported", controlFlow: "approximate", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "单文件组件没有专属语法：引擎把 `<script>` 块以外的行原地垫空，再按脚本语言解析。脚本里的函数与常量能拿到，模板与样式里的东西不进符号表。",
      dependencyEdge: "`<script>` 里的 import 走 TypeScript 那条规则，可信；但模板里 `<SomeButton />` 这类组件引用不会产生边，所以「这个页面用到那个组件」在图上看不见。",
      entrypoint: "没有针对 Vue 的入口规则。能标出来的入口来自 package.json 与 main.ts、App.vue 这类文件名约定，那是通用兜底。",
      packageResolution: "只认 tsconfig.json 里的通配别名；构建配置里另设的别名（如 vite / webpack 的别名表）不读，这类导入画不出边。",
      buildVisibility: "Vue 与构建器的配置文件一条都没读，因此不知道实际构建包含哪些文件、也没法把单文件组件拆成它的依赖。",
      controlFlow: "只编 `<script>` 里的那条路，用的还是 TypeScript 那套规则；模板里的 `v-if` / `v-for` / `v-show` 是组件真实分支的一部分，这里一条都不产生。看到单个组件的图只有脚本那半截，不是解析失败。",
      dataflow: "脚本块内部按名字记定义与读到（同 TypeScript 那格的限制：成员不拆开、不跨函数、汇合取并集）；模板里 `{{ count }}` 这类读法不算读到，所以 `count` 的读到点只列脚本里的那些。",
      typeRelations: "脚本里的 `interface` / `type` / class 继承与实现照收；`defineProps<{...}>()` 这种只有类型没有类名的形状不成边，模板里的组件用法更不在射程内。",
      registry: "`<script>` 里出现的 `app.use(插件)`、路由表登记这类通用写法会入册；但组件自身的名字、模板里的 `<router-view>` 与按目录约定的自动注册都不认，所以这个文件在册的条目通常比它实际登记的少。"
    }
  },
  python: {
    language: "python",
    displayName: "Python",
    extensions: [".py"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "approximate", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数与类，方法的归属靠缩进层级判定，起止行是解析出来的。语法树加载失败时回落逐行匹配（引擎会写明原因）。",
      dependencyEdge: "import 语句本身是真的，但 Python 的模块名是点号路径，落点要试文件：`from a.b import c` 会同时试 `a/b.py`、`a/b/__init__.py` 和 `a/b/c.py`——同名目录或文件会连错；标准库与第三方包按设计不入图。仓库不是「根目录就是包根」的布局（例如代码在 `src/` 下）时，绝对导入落不到点。",
      entrypoint: "认的是框架级语句而不是文件名：应用对象（`app = FastAPI(...)`）、Django 的路由表、挂在应用对象上的路由装饰器、启动语句，以及脚本守卫 `if __name__ == \"__main__\":`——命中即取代按文件名猜，且一个文件只取最强的一条。没覆盖到的（其它 Web 框架、命令行工具的入口声明）只剩文件名约定兜底；装饰器那一条理论上会把同名的其它装饰器误认成路由。",
      packageResolution: "不读任何包配置（pyproject.toml、setup.cfg、requirements.txt），没有源码根布局与命名空间包的概念。",
      buildVisibility: "打包与依赖清单一条都没读，因此分不清包内代码与 vendored 依赖，也不知道哪些文件真属于同一个分发单元。",
      controlFlow: "if / elif 链（含缩进里的 `else if`）/ for / while / try-except-else-finally / return / raise / break / continue 都按语法树编边；`with` 当作直接穿过的壳。两处形状还没进表：3.10 的 `match/case` 会被摊平成普通语句（图上看着像没有分支），`for/while ... else` 的 else 体不收。看到这两类文件的图比实际短，是这一格造成的，不是解析失败。",
      dataflow: "按名字记定义与读到：`self.count = 1` 记成对 `self` 的写，成员不拆开；不解推导式与生成器表达式的内部变量作用域，也不跨函数。多分支汇合取并集，读不到本仓定义的名字进 `unresolved`（内置函数、第三方对象全在这一格）。",
      typeRelations: "类头的基类与函数签名上的标注照收；Python 的类型是可选的，没写标注的地方一条边也不会有——这里的少边是「源码本身没说」，不是「引擎丢了」。基类落点按名字在全仓反查，同名会标 `ambiguous`，标准库基类没有落点。",
      registry: "`@app.route` / `urlpatterns` / Blueprint 登记这类写法命中即入册；用装饰器变量、循环批量注册或第三方框架自有的登记形状认不出来。pyproject 与 requirements 只进「键名与包名」，值不抄。"
    }
  },
  java: {
    language: "java",
    displayName: "Java",
    extensions: [".java"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "approximate", buildVisibility: "unsupported", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取类、方法、构造器、接口、枚举与记录，起止行是解析出来的。",
      dependencyEdge: "三条路：① 直接 import（`import com.a.B;`）按「包名 + 文件名」定位，通常可信；② `import com.a.*;` 这种整包导入只在类名真的出现在正文（含注释）里时才补一条边，强度低于直接 import；③ 类型派发边——类头 `extends`/`implements` 的落点（接口与实现之间没有调用行，靠它把实现类接回执行流）。跨文件调用边认「类名.方法(」与「变量接收者」：`mapper.insert(` 靠字段、方法参数、局部变量三种声明形状换成类型，换不出就退回裸名匹配。注释与 import 行在扫描前清除（等长替换，行号不变），注释里写的 `xxxService.handle(...)` 不算调用证据。同名类型、继承来的方法、内部类的归属仍可能指错，所以整格是 approximate。",
      entrypoint: "Spring 仓可信：启动类与控制器上的框架注解是权威标记，路由前缀能直接报出来。但非 Spring 的 Java 仓目前没有规则（连 `public static void main` 都还没进主函数清单），只剩文件名约定兜底。",
      packageResolution: "全限定类名靠每个文件自己的 package 声明来定，这条可信；但同名类型的取舍、内部类与静态成员的精确归属靠逐级去尾试探，不做模块级区分。",
      buildVisibility: "不读 Maven / Gradle 构建文件：分不清主代码目录与测试目录的构建范围，生成的源码目录也被当成普通源码进图。",
      controlFlow: "if / else、三种 for（含 for-each）、while / do-while、switch（冒号贯穿与箭头形式都认）、try-catch-finally 与带资源的 try、return / throw / break / continue 全按语法树编边。唯一没区分的一处：`break 标签` / `continue 标签` 目前按最内层那层循环接，所以标签跳多层循环的函数会少一段路。",
      dataflow: "按名字记定义与读到：`user.getName()` 里的 `user` 算读、`this.count = 1` 算对 `this` 的写，成员与字段不拆开；不做别名分析、不跨方法（接口方法在哪实现、实现里改了什么，这里看不见）。汇合点取并集，读不到本仓定义的名字进 `unresolved`——getter 拿到的、依赖注入框架塞进来的都落在这一格，数量大是正常的。",
      typeRelations: "类头的 `extends` / `implements`、字段类型、方法参数与返回值、泛型实参都成边，形状来自语法树；落点按简单类名在全仓反查，同名类型标 `ambiguous`，JDK 与第三方类型没有落点（边留着、`toFile` 空着）。接口与实现之间靠这张表才连得上——它比依赖图那条派发边细，但同样是名字反查。",
      registry: "Spring 这条线覆盖得最全：`@Autowired` / `@Resource` 字段注入与构造器注入落成「接口 → 实现」的绑定，`@RestController` / `@RequestMapping` 的路由、`@Bean` 工厂方法、`@ComponentScan` 这类扫描开关、`META-INF/services` 的 SPI 实现清单都入册。认的是写法不是执行：没被扫到的包里的注解一样进册。application.yml / .properties 只进「键名」，值一律不抄（`.tutor` 是明文目录，抄了口令就多一处泄露面）。非 Spring 仓只剩通用写法兜底。"
    }
  },
  go: {
    language: "go",
    displayName: "Go",
    extensions: [".go"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "approximate", buildVisibility: "approximate", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、方法和类型（结构体 / 接口的名字在类型声明里单独展开）。",
      dependencyEdge: "Go 的 import 指向「包」（一个目录）而不是文件，落点会把该目录下所有非测试文件各连一条边——粒度是整个包，比真正用到的那几个文件宽。对不上仓内模块前缀的（外部仓库、被替换的依赖）不画。",
      entrypoint: "`func main()` 是语言级的唯一起点，命中即确定；每个可执行文件一个，测试文件已排除。",
      packageResolution: "读每个 go.mod 的 module 行来划仓内边界，这块可信；替换指令、多模块工作区文件与 vendored 目录不认，这类路径落不到点。",
      buildVisibility: "读过 go.mod（模块名），但不读工作区与 vendor 清单，也不按构建标签取舍文件，所以图里的文件集合按目录扫描，不随构建条件变化。",
      controlFlow: "if / else if 链、唯一的 `for`（三种形态，`for {}` 死循环不接出口）、`switch`（含表达式式与类型式，只有写 `fallthrough` 才掉下去）、`select` 的每个通信臂、`goto` 与标签（向前跳也接得上）、return / break / continue 都按语法树编边。`defer` 是普通语句，不会画到函数出口那一格——它的执行时机在图上体现不出来。`break 标签` 同 Java 那格：按最内层循环接。",
      dataflow: "按名字记定义与读到：`:=` 短变量声明、普通赋值、`i++`、形参都算定义；`s.field = x` 记成对 `s` 的写，成员不拆开。`err := f()` 这种多返回值只按左边的名字记，不看返回了第几个值；不跨函数，汇合取并集。读不到定义的名字进 `unresolved`，包外的函数与内置的 `len` 之类全在这一格。",
      typeRelations: "结构体字段类型、接口的内嵌、方法的接收者类型、函数参数与返回值、泛型实参都成边。Go 没有继承，`extends` 这一类只会出现在接口内嵌上；接口的实现关系是隐式的（没有 `implements` 字样），所以「谁实现了这个接口」在这张表里连不出来，得靠调用边反推。落点按名字在全仓反查，同名标 `ambiguous`。",
      registry: "路由登记按写法收：`r.GET(\"/x\", h)`、`mux.Handle`、`http.HandleFunc` 这类命中即入册，`/path` 里的 `{}` 与 `:` 段折成 `{*}` 后比对。Go 没有依赖注入容器规则，`fx.Module` / wire / 手写构造函数注入都不认（这类关系要从类型关系与调用边里看）。go.mod 只进模块路径这一条，版本号与 require 的值不抄。"
    }
  },
  rust: {
    language: "rust",
    displayName: "Rust",
    extensions: [".rs"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "approximate", buildVisibility: "unsupported", controlFlow: "approximate", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、结构体、trait、枚举与模块；impl 块里的函数升为方法。",
      dependencyEdge: "两种仓内关系都认：`mod x;`（子模块声明，落 `x.rs` 或 `x/mod.rs`，与编译器一致）和 `use crate::a::b;`。后者会一段段去掉尾部往上找能落地的文件，所以 `use crate::a::b::Thing` 常连到 a 的模块文件而不是 Thing 真正定义的文件——方向对、位置偏粗。属性里指定的非常规文件名不认。",
      entrypoint: "`fn main()` 是语言级起点，命中即确定。库工程没有 main 是正常情况，不算入口缺失。",
      packageResolution: "`crate::` 的起点按约定假定为 `src/`，`mod` 声明相对当前文件解析（这两条覆盖标准布局）；但不读 Cargo.toml，`[lib]`/`[[bin]]` 指定的自定义入口落不到点。",
      buildVisibility: "Cargo.toml 没读：工作区成员、测试与基准目录的构建边界、按功能开关取舍的代码都判不出来。",
      controlFlow: "if / else if 链、`loop` / `while` / `for`、match 的每一臂（含 `_` 兜底与 `if` 守卫）、`?` 的「提前离开 / 继续」两条边（藏在 `let v = f()?;` 里的也扫得到）、return 与闭包都按语法树编。两处把它压到近似：`break '外层标签` / `continue '外层标签`（Rust 的常见写法）目前按最内层那层接，边指错而不是缺失；`panic!`、`unreachable!` 这类宏当普通语句，不会画出「这里离开函数」。",
      dataflow: "按名字记定义与读到：`let`（含 `let mut`）、赋值、`+=` 这类复合赋值、形参算定义；`let (a, b) = …` 的解构只按整条声明记，成员与字段不拆开。移动与借用是 Rust 的核心语义，这里不跟踪——值被移走之后原来的名字仍按「读得到」算。汇合取并集，不跨函数；读不到定义的名字进 `unresolved`。",
      typeRelations: "`impl Trait for Type` 的两头都成边（这是 Rust 唯一能连「接口 ↔ 实现」的地方）、`impl` 块里的自类型、结构体与枚举的字段类型、函数参数与返回、泛型实参都收；trait bound（`T: Display`）与关联类型不展开。落点按名字在全仓反查，同名标 `ambiguous`，标准库与 crate 外的类型没有落点。",
      registry: "认的是链式登记的写法：`.route(\"/x\", …)`、`.layer(…)`、`.nest(…)` 命中即入册。但 Actix / Rocket 的主力写法是属性宏（`#[get(\"/x\")]`、`#[derive(...)]`），宏展开不是这套语法树能看到的，这类路由在注册索引里是空的——要找回它们得看类型关系与调用边。Cargo.toml 只收段名（`[lib]` / `[workspace]`）与 `name =` 的目标名，依赖版本不抄。"
    }
  },
  csharp: {
    language: "csharp",
    displayName: "C#",
    extensions: [".cs"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取类、结构体、接口、枚举与方法。",
      dependencyEdge: "`using A.B.C;` 指向命名空间而非文件，落点是「声明了这个命名空间的全部文件」，比真正用到的类宽。命名空间靠正文里的 namespace 语句收（块式与文件式都收）；跨项目引用（类型在另一个工程里）落不到点。",
      entrypoint: "`Main` / `MainAsync` 方法名命中即可信；但新版允许的顶层语句（入口文件直接写代码、不声明 Main）认不出来，这类仓只能退回文件名约定。",
      packageResolution: "不读工程文件与解决方案文件：没有项目引用的概念，全仓按命名空间字符串混在一起找落点。",
      buildVisibility: "工程文件没读：目标框架、按条件编译取舍的代码、被排除的文件都判不出来，生成物目录只在目录排除规则生效时才不进图。",
      controlFlow: "if / else、for（三种头）/ foreach / while / do、switch（C# 不贯穿，所以每臂一条到结尾的边）、try-catch-finally（含只 catch 或只有 finally 的形状）、`using` / `lock` / `checked` 这类不改路径的壳按直接穿过处理、return / throw / break / continue 与 goto + 标签都按语法树编边。`break 标签` 同 Java：按最内层接；switch 里的 `goto case` / `goto default` 认成接不上的标签，会在该函数的 `notes` 里点名，不静默略过。",
      dataflow: "按名字记定义与读到：声明（含 `var`）、赋值、`+=` 复合赋值、`out` / `ref` 实参、形参都算定义；`user.Name = x` 记成对 `user` 的写，属性与字段不拆开。不跨方法调用（`service.Save(list)` 里对 list 做了什么看不见），汇合取并集。读不到本仓定义的名字进 `unresolved`，BCL 类型与扩展方法全落在这一格。",
      typeRelations: "类头的基类与接口列表、字段类型、方法参数与返回值、泛型实参、`where T : …` 约束都成边；属性（`public Foo Bar { get; set; }`）的 `Foo` 暂时不收，这类关系要去调用边那边看。落点按名字在全仓反查，同名标 `ambiguous`，BCL 与 NuGet 里的类型没有落点。",
      registry: "依赖注入这条线覆盖到位：`AddScoped<接口, 实现>()` / `AddSingleton` / `AddTransient`（含 Keyed 那三种与 `AddScoped<I>(sp => …)` 的工厂写法）都落成「接口 → 实现」的绑定；工程文件收 `ProjectReference` / `PackageReference` 的项目名、解决方案收项目清单。路由不在射程内：`[Route(\"api/x\")]` 特性与最小 API 的 `app.MapGet(…)` 都不认，那是 Java / Python 那条路由规则没扩到这里。配置文件只进键名，值一律不抄。"
    }
  },
  cpp: {
    language: "cpp",
    displayName: "C / C++",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "exact", dataflow: "approximate", typeRelations: "approximate", registry: "unsupported" },
    notes: {
      symbolExtraction: "按真实语法树抽取（C 与 C++ 共用一份语法）。C 的函数名不在独立字段里，要从声明符链条末端取，实现已覆盖指针与引用修饰。",
      dependencyEdge: "只认引号形式的 `#include \"x.h\"`（项目内头文件），尖括号是系统或第三方头，按设计不入图。先按当前文件同目录解析（编译器的首要规则）；解析不到就退化成「全仓里路径以这个名字结尾的文件」，多个命中就全连——这些是按文件名猜的边。头文件搜索路径（编译时指定的包含目录）无从得知。",
      entrypoint: "`int main(` 是语言级起点，命中即确定。",
      packageResolution: "没有包管理器清单可查，引擎也没读：包含目录、库依赖关系都不判。",
      buildVisibility: "构建脚本（CMake / Bazel / makefile）一条都没读：编译单元怎么划分、宏定义了哪些分支、按条件取舍的文件都判不出来。",
      controlFlow: "if / else、for（含区间 for）、while / do-while、switch（C/C++ 默认贯穿，没写 break 就掉下一臂）、goto + 标签（向前跳先记账、建完再连）、try / catch（C++，一个 catch 既是处理器也是兜底）、return / throw / break / continue 都按语法树编边。两处不建模：`throw` 之后经过的局部对象析构不画展开路径；`setjmp` / 信号 / 协程这类非常规跳转当普通调用。",
      dataflow: "按名字记定义与读到：声明、初始化、赋值、`++` / `--`、复合赋值、形参都算定义。指针与引用不做别名分析——`*p = x` 记成对 `p` 的写，`p` 指向的那个对象在图上不认；`free(p)` 之后再用 `p` 也照旧算「读得到」。这就是 C/C++ 里这一格只能是近似的原因。汇合取并集，不跨函数；读不到的名字进 `unresolved`（库函数、宏展开出来的全在这一格）。",
      typeRelations: "类的基类列表（含 `public` / `virtual` 修饰后的那个名字）、结构体与类的成员、函数参数与返回、模板实参、`using X = Y` 的别名都成边；前置声明（`class Foo;`）也收到，可能只有一条指向自己的名字。落点按名字在全仓反查——头文件声明、源文件实现是两份同名，会标成 `ambiguous`；标准库类型没有落点。",
      registry: "这一格没有规则：注册与配置索引靠的是框架写法（路由登记、依赖注入绑定）或构建清单，C/C++ 两边都没接——既没有可注册的框架概念，也不读 CMakeLists / Bazel / makefile。所以本门语言的源码与构建脚本在注册索引里一条都不会有，读侧看到的空白是真空白。"
    }
  }
} satisfies Record<string, LanguageCapabilities>;

/** 本表覆盖的语言 id（`languageCapabilitiesOf` 对未知语言回落的条目不在此列）。 */
export type SupportedLanguage = keyof typeof LANGUAGE_CAPABILITIES;

/** 各格全为 `unsupported` 的回落条目：未知语言用它，界面会明说「这门语言没有规则」。 */
export const UNKNOWN_LANGUAGE_CAPABILITIES: LanguageCapabilities = {
  language: "unknown",
  displayName: "未知语言",
  extensions: [],
  cells: { symbolExtraction: "unsupported", dependencyEdge: "unsupported", entrypoint: "unsupported", packageResolution: "unsupported", buildVisibility: "unsupported", controlFlow: "unsupported", dataflow: "unsupported", typeRelations: "unsupported", registry: "unsupported" },
  notes: {
    symbolExtraction: "引擎没有这门语言的语法，文件里的函数与类进不了符号表。",
    dependencyEdge: "引擎没有这门语言的依赖解析规则，图里不会出现它指向别人或别人指向它的边。",
    entrypoint: "没有入口规则，只有跨语言的文件名约定可能把它误认成入口。",
    packageResolution: "非相对路径无处可查，落不了点。",
    buildVisibility: "构建清单不读，实际编译范围未知。",
    controlFlow: "没有语法就没有控制流图：这个文件在产物层不留行，读侧看到的是「没算过」而不是「算出来是空的」。",
    dataflow: "同上，变量在哪行定义、哪些行读到，一条也记不出来。",
    typeRelations: "类型之间的边要从语法树里读，没有语法就没有边。",
    registry: "既没有这一门的注册写法表，也没有它的构建清单键表，所以路由、注入绑定、配置键都无从登记。"
  }
};

/**
  扩展名 → 语言。由本表各条目的 `extensions` 汇总而成（只有一份来源）。
  ⚠️ 与 `DependencyGraph` 实际处理的扩展名同一条命：加一门语言要改两处，漂移由 engine 的单测发现。
*/
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SupportedLanguage>> = Object.fromEntries(
  Object.entries(LANGUAGE_CAPABILITIES).flatMap(([language, entry]) => entry.extensions.map((extension): [string, SupportedLanguage] => [extension, language as SupportedLanguage]))
);

/** 只认自有键：`Object.fromEntries` 出来的对象仍带原型，`"constructor"` 这类键不能被判成一门语言。 */
const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** 一个扩展名（`.java`）或文件名属于哪门语言；图里没有这个扩展名时 undefined。 */
export function languageOfExtension(extension: string): SupportedLanguage | undefined {
  const normalized = (extension ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  const key = normalized.startsWith(".") ? normalized : `.${normalized}`;
  return hasOwn(LANGUAGE_BY_EXTENSION, key) ? LANGUAGE_BY_EXTENSION[key] : undefined;
}

/**
  查一门语言的能力档：接受语言 id（`java`）、扩展名（`.java` 或 `java`）或带扩展名的路径（`src/a.java`）。
  未知语言回落 `UNKNOWN_LANGUAGE_CAPABILITIES`（全格 `unsupported`），不假装是 approximate。
*/
export function languageCapabilitiesOf(extensionOrLanguage: string): LanguageCapabilities {
  const raw = (extensionOrLanguage ?? "").trim().toLowerCase();
  if (!raw) return UNKNOWN_LANGUAGE_CAPABILITIES;
  const slash = raw.lastIndexOf("/");
  const tail = slash >= 0 ? raw.slice(slash + 1) : raw;
  if (hasOwn(LANGUAGE_CAPABILITIES, tail)) return LANGUAGE_CAPABILITIES[tail as SupportedLanguage];
  const dot = tail.lastIndexOf(".");
  const language = dot > 0 ? languageOfExtension(tail.slice(dot)) : languageOfExtension(tail);
  return language ? LANGUAGE_CAPABILITIES[language] : UNKNOWN_LANGUAGE_CAPABILITIES;
}

export interface ImpactResult {
  changedPaths: string[];
  impactedPaths: string[];
  edges: { from: string; to: string; kind: "import" | "call" }[];
}

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

export interface ImplementationUnit {
  id: string;
  symbol: SymbolInfo;
  summary: string;
  inputs: string[];
  output: string;
  invariants: string[];
  boundaries: string[];
  traps: string[];
}

export interface RepositoryAnalysis {
  repositoryId: string;
  generatedAt: string;
  graph: DependencyGraphData;
  implementations: ImplementationUnit[];
  versionStamp: string;
  /** 分析那一刻的 git HEAD（`git rev-parse HEAD`）。非 git 仓或取不到时默认；懒挂载用它与当前 HEAD 比对新鲜度。 */
  gitHead?: string;
  lastIncrementalUpdate?: { changedPaths: string[]; impactedPaths: string[]; at: string };
}

/**
  跨语言 HTTP 接缝：前端那条 `request.get('/shop/list')` 与后端 `@GetMapping("/list")` 之间
  没有任何语法级依赖——两边唯一的共享标识符是路由字符串，所以整仓依赖图天生看不见这条链。
  类型放共享层是因为两侧都要读（界面要显示「这条链的另一头在哪个仓的哪一行」）。
  识别与配对逻辑住在 engine `depgraph/routes.ts`，这里只定契约。
*/
export interface RouteProvider {
  /** 归一化后的路由：带前导斜杠，参数段统一折成 `{*}` */
  route: string;
  path: string;
  line: number;
  /** 怎么认出这条路由的（界面用白话说「这是 Spring 的注解」） */
  framework: "spring" | "flask" | "fastapi";
}

export interface RouteConsumer {
  route: string;
  path: string;
  line: number;
  /** 原始字面量：归一化会吃掉 `${id}` 这类信息，排查与界面都要看原文 */
  raw: string;
}

export interface RouteLink {
  route: string;
  consumer: RouteConsumer;
  provider: RouteProvider;
  /** `exact`=整段相等；`suffix`=提供方路由按整段落在消费方尾部（网关前缀那一类）。两者证据强度不同，不能混成一个数 */
  via: "exact" | "suffix";
  /** 这条消费串一共配到几个提供方。1 之外都是歧义，必须被数出来而不是静默取第一个 */
  ambiguousWith: number;
}

/** 一个方向的配对结果（带统计，界面不用自己再数一遍）。 */
export interface SeamDirection {
  links: RouteLink[];
  /** 这一侧被扫到的路由字符串/路由声明条数 */
  scanned: number;
  matched: number;
  ambiguous: number;
}

/** 本仓↔相关仓的双向接缝清单。界面上不再有这条入口，它是 agent 的 `cross_repo_link` 工具背后的数据。 */
export interface SeamReport {
  repositoryId: string;
  otherRepositoryId: string;
  /** 本仓调用相关仓的接口（本仓是消费方） */
  outbound: SeamDirection;
  /** 相关仓调用本仓的接口（本仓是提供方） */
  inbound: SeamDirection;
}


/**
  题型五档：
  - `change_localization` / `impact_analysis`：静态分析产出的理解题，不跑代码。
  - `patch_edit`：给一段有缺陷的实现，学习者在编辑器里改到测试全过。
  - `author_function`：给题面与骨架文件，学习者从零写实现。
  - `llm_rubric`：开放分析题，rubric 判分。
*/
export type ExerciseKind = "change_localization" | "impact_analysis" | "patch_edit" | "author_function" | "llm_rubric";
/** 规则出题族题型：题面/选项/标准答案全部由静态分析产出（server 校验 / 缓存命中校验共用这一份）。 */
export const EXERCISE_KINDS: ExerciseKind[] = ["change_localization", "impact_analysis"];
/** 要进沙箱真跑的族：学习者交的是代码，判分只由测试是否全过决定。 */
export const CODE_EXERCISE_KINDS: ExerciseKind[] = ["patch_edit", "author_function"];
/** 当前引擎真能出、真能判的全部题型（路由 400 校验、复习队列回放、round-robin 选题共用这一份，不再各写清单）。 */
export const SUPPORTED_EXERCISE_KINDS: ExerciseKind[] = [...EXERCISE_KINDS, ...CODE_EXERCISE_KINDS];
/** 练习题族：comprehension=程序理解题（规则出题、确定性判分），code=沙箱代码题（模型出题、跑测试判分），llm=LLM 出题（rubric 判分）。family 是实现层概念，对用户不可见。 */
export type ExerciseFamily = "comprehension" | "code" | "llm";
export type ExerciseInputMode = "text" | "multi_select" | "open" | "code";
/** `execution` 意味着「沙箱真跑测试」，判分只由测试是否全过决定。 */
export type ExerciseGradingMode = "execution" | "set_match" | "rubric";
/** 沙箱支持的语言。就是这一份清单——加一门语言要同时给 runner（怎么起）与探测（能不能真拦住），否则整域禁用。 */
export type ExerciseLanguage = "typescript" | "python" | "java";
/** 下发给界面编辑器的可编辑文件（`patch_edit` 给的是带缺陷的那一份，`author_function` 给的是骨架）。
    判分用的测试与替身不在这里，它们只留在引擎缓存行里。 */
export interface ExerciseCodeSlot {
  language: ExerciseLanguage;
  files: { path: string; contents: string }[];
  /** typescript/python：入口文件名；java：入口类名 */
  entry: string;
}
/** rubric 判分的评分细则维度（LLM 出题时一并产出，存于引擎缓存，不下发 GUI）。 */
export interface RubricCriterion {
  dimension: string;
  description: string;
}
export type MasteryLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ExerciseOption {
  id: string;
  label: string;
  detail?: string;
}

/** A learner-safe exercise. Expected answers remain in the engine cache. */
export interface Exercise {
  id: string;
  repositoryId: string;
  contentVersion: string;
  kind: ExerciseKind;
  targetUnitId: string;
  targetTitle: string;
  difficulty: MasteryLevel;
  title: string;
  prompt: string;
  anchors: SourceAnchor[];
  inputMode: ExerciseInputMode;
  gradingMode: ExerciseGradingMode;
  options?: ExerciseOption[];
  /** 代码题（`patch_edit` / `author_function`）的可编辑文件包；理解题与主观题没有这个节点。 */
  code?: ExerciseCodeSlot;
  /** 练习题族；旧缓存记录无此字段视为 comprehension。 */
  family?: ExerciseFamily;
  /** llm 族：用户配置的出题主题标签（题面语义提示）。 */
  tag?: string;
  /** 这道题的内容由哪些文件决定（题面 + 标准答案）；作答时逐文件核对哈希，无关文件的修改不打扰已有题目。
      旧缓存记录无此字段，回落 `contentVersion` 全仓比对。 */
  contentHashes?: { path: string; hash: string }[];
  createdAt: string;
}

/** 教学模块「推荐入口」的单条 LLM 推荐（engine `/module-entries` 返回；id 必须能回查课程树节点）。 */
export interface SuggestedEntry {
  id: string;
  title: string;
  path: string;
  line: number;
  reason?: string;
}

/**
  「这条路径是文档，不是代码」——推荐入口的排除判据，引擎与界面共用这一份（判据两处各写一遍迟早漂移）。
  只看文件自己的扩展名，不看目录名：`docs/` 下放的可能是示例代码，按目录一次改动切会连代码一起挡掉。
  `.json`/`.yml` 不算文档（它们是配置与构建输入，不是散文）。
  现在只有 `.md` 真能走到这一层（收录层的扩展名白名单在前面把关），列全是为了这条判据本身说得通。
*/
export const DOCUMENTATION_EXTENSIONS: readonly string[] = [".md", ".markdown", ".rst", ".adoc", ".txt"];

export function isDocumentationPath(path: string): boolean {
  const base = (path ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return DOCUMENTATION_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

export interface ExerciseAnswer {
  text?: string;
  selectedIds?: string[];
  /** 代码题：学习者提交的整组文件。path 必须与题面下发的那一组一致——判分时用它替换 `given`，其余文件用出题时冻结的那一份。 */
  files?: { path: string; contents: string }[];
}

export interface ExerciseResult {
  exerciseId: string;
  repositoryId: string;
  targetUnitId: string;
  kind: ExerciseKind;
  score: number;
  passed: boolean;
  automatic: boolean;
  gradingMode: ExerciseGradingMode;
  feedback: string;
  /** 反馈来源：rule=规则判分原文；llm_polished=LLM 润色的解释；llm_judge=rubric 判分产出。 */
  /** `sandbox` = 结论出自沙箱真跑（测试通过/失败计数），没经过任何模型；`llm_polished` 只改措辞不改结论。 */
  feedbackSource?: "rule" | "llm_polished" | "llm_judge" | "sandbox";
  matchedIds?: string[];
  missingIds?: string[];
  unexpectedIds?: string[];
  reviewedAt: string;
  review: ReviewSchedule;
}

export interface MasteryRecord {
  unitId: string;
  level: MasteryLevel;
  attempts: number;
  successes: number;
  lastPracticedAt?: string;
}

export interface MasteryMapEntry extends MasteryRecord {
  successRate: number;
}

export type FadedTransition = "fade" | "replenish" | "steady";

export interface FadedState {
  sampleCompleteness: 0 | 1 | 2;
  hintDepth: 0 | 1 | 2 | 3;
  stylePlainness: 0 | 1 | 2;
  mastered: boolean;
  transition: FadedTransition;
  reason: string;
  updatedAt?: string;
}

export interface RecommendedTutorSettings {
  settings: TutorSettings;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export interface LearnerProfile {
  repositoryId: string;
  generatedAt: string;
  mastery: MasteryMapEntry[];
  faded: FadedState;
  fadedByUnit: Record<string, FadedState>;
  recommended: RecommendedTutorSettings;
}

export interface ReviewSchedule {
  exerciseId: string;
  unitId: string;
  repetitions: number;
  intervalDays: number;
  easinessFactor: number;
  dueAt: string;
  lastReviewedAt?: string;
}

export interface PracticeSummary {
  repositoryId: string;
  contentVersion: string;
  dueReviews: number;
  mastery: MasteryRecord[];
}

/**
  学习日志事件类型。分两类：

  - 引擎侧（学习语义）：`ENGINE_JOURNAL_EVENTS`（含 turn_text / turn_invariant / code_egress 等审计事件），
    由引擎在工具循环 / 判分 / 成本核算里写。
  - UI 侧（交互动作）：flow_node_selected 起至 repository_switched；由 GUI 经 `POST /api/repositories/:id/journal` 写。
    每次切节点、打开文件、切换模块、提交练习都必须有事件可查。

  每张表都要正好归到 `ENGINE_JOURNAL_EVENTS` 或 `UI_JOURNAL_EVENTS` 之一：下面那条编译期对账会查漏归类，
  `packages/engine/src/store/journal.ts` 的运行时白名单由这两张表派生。
  append-only：只许新增，不许改名既有取值，也不删类型——读侧不校验类型，历史事件仍可读，只是不再接受新写入。
*/
export type JournalEventType =
  // 引擎侧
  /** 历史事件：教学状态机撤除后不再写。类型保留不删——append-only 那条纪律，
      历史仓里的这些行仍要能被归类；新行不再产生。 */
  | "unit_mastered"
  | "hint_depth"
  | "dependency_event"
  | "unassisted_test"
  | "action_veto"
  /** 判分结果与风格切换：仍由练习判分与教学会话写入。 */
  | "exercise_result"
  | "style_shift"
  /**
    练习未送达事件。payload 必带 `family`（comprehension|code|llm）与 `stage`：
    `no_target` 这一档是共用的选题路径写出的，两族都可能命中，没有族别就没法把「代码题被沙箱拒了」
    和「这个仓里挑不出单元」分在一个数里读。没带这个键的历史行按「未标族别」单列。
  */
  | "exercise_declined"
  /** 练习送达事件（转化率的分母）：payload.source = llm|cache|rule|review；拒绝侧另有 exercise_declined。 */
  | "exercise_generated"
  | "token_usage"
  | "file_read"
  | "code_search"
  /**
    产品 agent 调了一次外部 MCP 工具。一次调用一条，失败也记——
    分母要完整：连不上、超时、参数不合法、server 自己报错是四种不同处置（改配置 / 调上限 / 换提示词 / 收白名单）。
    payload = `server` / `tool` / `args_chars` + `args_hash`（参数正文不落盘，与 `code_egress` 同一口径：
    发出去的可能是仓内代码，另开一条日志线等于自己造一个泄露面）/ `result_chars` / `masked`（密钥筛隐去处数，
    `0` 与不填是两个读数）/ `ok` / `ms` / `error`(unknown_tool|bad_arguments|timeout|no_tool|server_reported_error)。
    这一行不能当「源码出网」的证据：MCP server 是别人写的本机子进程，它拿到的内容会不会再往外走，引擎不知道，
    所以这条线只是「我们把什么交给了哪个 server」的指针。数据流报表要单列，不许混进 `code_egress` 的总数。
  */
  | "mcp_call"
  /**
    产品 agent 取了一份技能正文：`skill` + `chars` + `found`。
    记「取过」而不是只记「装过」——一份写好的做法没人调用，是这份做法没被模型认出来的读数，
    而清单里有名字、正文从没被取走这件事只能从这一行看出来。
  */
  | "skill_read"
  | "scope_degraded"
  /** 回合文本落盘：payload = scene(teach|map_chat|practice_chat) + question/answer
      双边原文，各截 2000 字并带 *_truncated 留痕；永久追加、不做 TTL、无开关。教学法机检与表达质量裁判的被测输入源。 */
  | "turn_text"
  /** 运行期不变量复检：一回合一条，合格也记（分母要运行时成立）。
      payload = scene(teach|map_chat|practice_chat) + applicable(该回合该判的条目) + failed(失守条目) + evidence(逐条证据摘录)。
      判据与离线 `phaseB:eval` 共用同一个函数，所以「线上说合格、离线算不合格」不可能出现。 */
  | "turn_invariant"
  /** 会话线程的生命周期事件：`session_created` 在引擎发 id 建线程时写，
      `session_deleted` 只在软删时写。payload = scope(teach|map|practice) + thread_id + node_id/exercise_id + reason。
      删除是产品线的动作，journal 这条线只留「发生过删除」这一事实，不删任何既有事件行。 */
  | "session_created"
  | "session_deleted"
  /** agent 回合的工具循环摘要：一回合一条，记工具轮次与各类工具调用次数。
      practice 对话无工具循环，不记本事件。 */
  | "loop_round"
  /** 回合被用户主动停止：payload = scene(teach|map_chat|practice_chat) + turn_id +
      aborted_by(恒为 user_stop)。与「客户端断开」刻意区分——后者引擎照常算完落库，不记本事件。
      中止的一轮没有成品：不写 turn_text，也不伪造 assistant 正文。 */
  | "turn_aborted"
  /**
    沙箱真跑了一次代码。一次运行一条，成败都记——
    分母要完整：出题自证链跑三趟（原码/缺陷版/参考解），判分再跑一趟，少一条就分不清「题没出成」和「题没被作答」。
    payload：`language` / `stage`(validate-proposal|grade) / `ok` / `exit_code` / `signal` / `timed_out` /
    `truncated` / `stdout_bytes` / `duration_ms` / `isolation`(enforced|unavailable) / `runner`（解释器与 profile 指纹，
    换 runner 要让旧题的缓存键一起失效，所以这列必须落在行上才查得回）。
    只记读数不记正文：学习者写的代码与运行输出留在内存里判完就丢，正文进 `code_egress` 那一侧才有出网记录。
  */
  | "exercise_run"
  // UI 侧
  | "flow_node_selected"
  | "file_anchored"
  | "file_opened"
  | "line_located"
  | "module_switched"
  | "exercise_submitted"
  | "repository_switched"
  | "entry_adopted"
  | "entry_overridden"
  /**
    把本仓与地址簿里的另一个仓配对（跨仓 HTTP 接缝）。引擎侧写：这条读的是两个仓的源码，
    配上几条是要能查的数。只有 agent 调 `cross_repo_link` 时才会发生（`via: "tool"`）。
    payload：`other_repository_id` / `outbound` / `inbound`（两个方向各自配上的条数）。
  */
  | "repository_paired"
  /**
    人工把某个模块改成另一档（主链路 / 基础设施 / 外围）。引擎侧写（Agent 的 `set_module_tier`）。
    payload：`module` / `module_title` / `given` / `to` / `core_share` / `visible_files` / `restored` / `via`。
    结构判据没有真值可比，这条就是攒真值的读数——攒够了才谈「判据改对了没」。
  */
  | "module_tier_overridden"
  /**
    历史事件：分层视图的人工改层/改层名，随分层视图退役后不再写。
    类型保留不删——历史仓里的这些行仍要能被归类。
  */
  | "architecture_layer_overridden"
  /**
    源码出网清单（LLM 数据流审计）。引擎侧写，一行 = 一段进过模型请求的仓内源码。
    记指针与指纹（`scene`/`kind`/`path`/`lines`/`chars`/`hash`，另带 `masked`/`truncated`），不记正文；
    与 llm.log 靠 `traceId + scene` 关联。字段语义以 engine `security/dataflow.ts` 的注释为准，不在此复述。
  */
  | "code_egress"
  /**
    画布上的一张图被建出来（agent 一次画完整张，或用户新建空白）：
    payload = diagram + name + source(agent|me) + nodes + edges + downgraded（几条边被引擎降了档）。
    记的是「谁画的、画了多少、有几条不成立」，不记图内容（内容在 `diagram` 表里）。
  */
  | "diagram_created"
  /**
    一次结构改动落了盘：payload = diagram + action(add_node|remove_node|add_edge|remove_edge|add_group|remove_group|relabel|move)
    + nodes + edges + downgraded + via(agent|user)。
    几何拖动不走这条——位置不承载对错、也不是判断被推翻的读数，一天能拖几百次，写进审计只会淹掉真信号。
  */
  | "diagram_edited"
  /** 图改名（payload = diagram + from + to）。改名不存版本：它不动结构。 */
  | "diagram_renamed"
  /** 图被删（payload = diagram + name + versions）：版本历史一起删，所以这条要留痕。 */
  | "diagram_deleted"
  /** 恢复到某一版（payload = diagram + to + note）：恢复本身又追加一版，历史只追加不改写。 */
  | "diagram_restored";

/**
  同一份事件的写入权分两张表。
  上面那张联合类型说的是「有哪些事件」，这两张说的是「谁有资格写」：
  `POST /api/repositories/:id/journal` 只认 UI 侧那张。理由是证据价值本身——
  `.tutor/journal.jsonl` 承担着「哪些代码出过门」这类账（`file_read` / `code_egress` / `token_usage`），
  而这条接口是本机任何进程都能调的：能塞一行就能编一段账，能编账的审计线就不是审计线。
  引擎侧那张由引擎在状态机、工具循环、装配与成本核算里自己写，界面不得发射（同一事实只写一处）。
*/
export const ENGINE_JOURNAL_EVENTS = [
  "unit_mastered", "exercise_result", "hint_depth", "dependency_event", "style_shift", "unassisted_test",
  "action_veto", "exercise_declined", "exercise_generated", "token_usage", "file_read", "code_search",
  "mcp_call", "skill_read",
  "scope_degraded", "turn_text", "turn_invariant", "loop_round", "turn_aborted", "exercise_run",
  "session_created", "session_deleted", "repository_paired", "code_egress",
  // 改档是「判断被人工推翻」的读数，只能由引擎写（`set_module_tier` 的落盘路径），审计与写入同处才不漏；architecture_layer_overridden 仅为历史行保留
  "architecture_layer_overridden", "module_tier_overridden", "diagram_created", "diagram_edited", "diagram_renamed", "diagram_deleted", "diagram_restored"
] as const satisfies readonly JournalEventType[];

export const UI_JOURNAL_EVENTS = [
  "flow_node_selected", "file_anchored", "file_opened", "line_located", "module_switched",
  "exercise_submitted", "repository_switched", "entry_adopted", "entry_overridden"
] as const satisfies readonly JournalEventType[];

export type EngineJournalEventType = (typeof ENGINE_JOURNAL_EVENTS)[number];
export type UiJournalEventType = (typeof UI_JOURNAL_EVENTS)[number];

/** 约束到 `never` 的断言别名：参数不是 never 就在编译期报错（下面拿它当对账闸）。 */
type AssertNever<T extends never> = T;

/**
  编译期对账：两张表并起来必须正好等于 `JournalEventType`。
  往 union 加了新事件却忘了归进某一张表，这里直接报错，不用等运行期，也不用靠人审。
*/
type _JournalPartitionGuard = AssertNever<Exclude<JournalEventType, EngineJournalEventType | UiJournalEventType>>;

export interface JournalEvent {
  id: string;
  type: JournalEventType;
  at: string;
  repositoryId: string;
  sessionId?: string;
  /** 产生该事件的请求 traceId；后台任务（导入 / 监听刷新）无请求上下文时为 null。 */
  traceId?: string | null;
  payload: Record<string, string | number | boolean | null>;
}

/** 引擎工作日志（trace）里允许出现的标量——与 journal payload 同口径，避免结构化对象随版本漂移。 */
export type TraceScalar = string | number | boolean | null;

/**
  引擎工作日志的事件种类。只描述「引擎这个进程在干活」，不描述对话语义：
  - http     一次 HTTP 请求（method / url / status / 耗时）
  - import   导入任务（索引 → 摘要 → 建课 → LLM 润色的阶段推进与结果）
  - reindex  挂载仓库被写入触发的重分析
  - degrade  降级与预算熔断（不静默：降级必须留痕）
  - turn_stop 用户点「停止生成」命中在途回合（对话语义本身在 journal 的 turn_aborted）
  - boot     启动分段计时
  LLM 调用明细不在此列——它落在 `~/.codebase-tutor/llm.log`，两处靠 traceId 关联（单一事实来源，不双写）。
  */
export type EngineTraceKind = "http" | "import" | "reindex" | "degrade" | "turn_stop" | "boot" | "mount";

export interface EngineTraceEvent {
  at: string;
  kind: EngineTraceKind;
  /** 关联键：同一请求产生的 http / llm / journal 事件共享它；后台任务为 null。 */
  traceId: string | null;
  /**
    调用方身份（API key 的名字）。认证闸撤了之后新行恒 null，只有历史行里有值。
    字段保留只为两份日志线（`llm.log` 与本文件）的列形状一致，不要按它做按人对账。
  */
  actor?: string | null;
  durationMs?: number | null;
  detail: Record<string, TraceScalar>;
}

