export type JobPhase = "queued" | "indexing" | "summarizing" | "building_course" | "completed" | "failed";

export interface ImportJob {
  id: string;
  repositoryPath: string;
  repositoryId?: string;
  phase: JobPhase;
  progress: number;
  message: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
  /** 导入时选择的摘要口径：true=「参考注释导入」（slice-v2c 档），false=普通导入；undefined=不改该仓既有设置。
      导入开始时会把显式值写进该仓 settings（读-合并-写），之后成本监控页的开关继续作为唯一事实源。 */
  summaryHeaderComments?: boolean;
}

export interface FileEntry {
  path: string;
  extension: string;
  bytes: number;
  lines: number;
  /** 正文 SHA-256 前 16 位；升级前生成的旧索引没有此字段——出题键对缺值回落全仓 versionStamp 语义。 */
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
    扫描期**读不出来**的文件（读到一半被删、权限不对、被换成特殊节点）。缺省 = 一个都没有。
    这些文件被跳过而不算失败（一个坏文件不该掀掉整次导入），但必须记名：
    `totalFiles` 与后面所有「这个仓有多少代码、哪些文件没摘要」的读数都建立在「缺席是知道的」之上。
    上限 50 条，超出只按前 50 条报（真出到几百条时，前 50 条足够定位问题目录）。
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

export type VerificationStatus = "verified" | "needs_review" | "skipped";

export interface AssertionCheck {
  statement: string;
  status: VerificationStatus;
  reason: string;
  anchors: SourceAnchor[];
}

/**
  模块分级（分级折叠用，引擎在 `/course` 响应前现算，不落树）：
  - `core` 主干 = 模块里有入口，或执行主干文件占到可见文件的四分之一；
  - `facility` 设施 = 只有支撑逻辑或外部设施接入（配置、存储、网络客户端）；
  - `periphery` 外围 = 只剩末端工具与测试（文档、监控看板、压测报表都在这里）。
  判据来自 `depgraph/roles.ts` 的结构规则（确定、可复现），不依赖模型。
  占比这一档 2026-10-06 实测：只「有一个主干文件就算主干」时，Xingyan 有个 66 个可见文件的模块全靠 1 个文件撑档。
  */
export type CourseTier = "core" | "facility" | "periphery";

/**
  分级依据（与 `tier` 一起现算，给界面把判据露出来）：分不准时先要看得见为什么这么分。
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
  verification?: AssertionCheck[];
  /** Present on overview and paged responses when descendants are not yet loaded. */
  childCount?: number;
  /** 仅 module 节点有值：界面据此把「外围」折起来，首屏只露主干与设施 */
  tier?: CourseTier;
  /** 仅 module 节点有值，与 `tier` 同时现算：这一档是按哪些数判出来的 */
  tierEvidence?: CourseTierEvidence;
}

export interface CourseTree {
  repositoryId: string;
  modelVersion: string;
  generatedAt: string;
  root: CourseNode;
}

/** Lightweight first response for a large repository's course map. */
export interface RepositoryOverview {
  repositoryId: string;
  totalFiles: number;
  totalLines: number;
  hotspots: Hotspot[];
  root: CourseNode;
}

export interface CourseNodePage {
  parentId: string;
  offset: number;
  total: number;
  items: CourseNode[];
  nextOffset?: number;
}

export interface CourseNodeDetail {
  nodeId: string;
  implementation?: ImplementationUnit;
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

/** M1 policy is a continuous 0-100 value; M0 presets remain 35, 50 and 65. */
export type StyleLevel = number;

/**
  语言风格档位的判据与展示名 —— engine 与 GUI 的**唯一**来源（两侧都从这里取，不再各写阈值）。
  历史坑：harness 的本地回落文案曾写死 `>= 65`，与 policy 里的 67 不一致，滑块 65/66 两处口径不同。
  档位只决定基调和回显名；档**内**的逐步细化在 engine 的 harness/prompts.ts（那里的 `at` 阈值是叠加在档位之上的补充要求）。
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
export type TeachingStage = "orient" | "procedure" | "concept" | "verify" | "confirmed";

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
  stage?: TeachingStage;
}

export interface TutorSession {
  id: string;
  repositoryId: string;
  courseNodeId: string;
  style: StyleLevel;
  settings: TutorSettings;
  stage: TeachingStage;
  fallbackCount: number;
  messages: TutorMessage[];
  createdAt: string;
}

/**
  会话持久化的作用域：三种对话各自独立成列表（teach 绑课程节点，practice 绑练习题，map 可不绑）。
  与 journal 的 `turn_text.scene`（teach / map_chat / practice_chat）是两套口径——前者是产品域的会话归属，
  后者是审计线的事件标签，不强行统一。
  */
export type ChatScope = "teach" | "map" | "practice";

/** 一个对话线程的头（正文在 chat_message；软删只体现在 `deletedAt`，列表读侧过滤）。 */
export interface ChatThread {
  id: string;
  repositoryId: string;
  scope: ChatScope;
  courseNodeId?: string;
  exerciseId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 线程里的一条消息：`error` 非空表示这轮失败（失败也入库，GUI 才能重现「当时报错」的气泡）。 */
export interface ChatThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  stage?: TeachingStage;
  error?: string;
}

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

  为什么要单独一类边，而不是塞进 `imports`：Java/C# 的「控制器注入接口、运行时才绑到实现」这一拍
  **在源码里没有调用行**，import 边只到接口为止，于是实现类整片在图上失联（2026-10-05 实测：
  dianping 45 个 Controller/Service/Mapper 文件里 30 个从任何入口都走不到）。方向反过来是
  「接口 → 实现」的派发，这是执行流，不是依赖流，混进 import 边会把「谁依赖谁」说反。

  TS/Python 不产这类边：那两门语言的继承/实现必须先 import 那个名字，关系已经在 import 边里了。
  ⚠️ `supertypePath` 靠类名→文件解析，同名类型可能指错，故它是 A1 级的近似证据，不是权威结论。
*/
export interface TypeDispatchEdge {
  subtypePath: string;
  supertypePath: string;
  kind: "implements" | "extends";
  line: number;
}

export interface DependencyGraphData {
  imports: Record<string, string[]>;
  calls: CallEdge[];
  /** 类型派发边；旧产物没有该字段（那时只有 import 与 call 两类关系），缺失即按空表处理。 */
  dispatch?: TypeDispatchEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: { language: "typescript" | "python"; status: "available" | "fallback"; reason?: string }[];
  /**
    符号抽取走的哪条路：`ast` = 语法树（准确），`regex` = 逐行文本匹配（回落，只在
    语法解析器加载失败时出现）。旧数据没有这两个字段，故可选；缺失即视为 `regex`。
  */
  parseBackend?: "ast" | "regex";
  parseBackendReason?: string;
}

/**
  ==== 语言能力表（引擎自报口径）====

  这是什么：每门语言 × 五个能力格的取值，只回答「引擎现在真的能做到什么程度」。
  为什么要单独成表：各语言的支持程度本来就不均——符号抽取走真实语法树（多语法，加载失败会回落逐行匹配），
  import 落点是**每语言一条自己的规则**（Java 全限定类名、Go 包目录、C# 命名空间、TS 相对路径 + 别名、
  Python 点号模块、C/C++ 头文件），入口判定只有部分语言有权威规则，构建清单只读了三份
  （package.json / tsconfig / go.mod）。这些差异过去只写在引擎代码的注释里，界面与读数都看不出来，
  用户拿到一张图没法判断「这条边是编译器级的、还是按文件名猜的」。

  ⚠️ 四条纪律，违反任何一条就等于这张表在骗人：
  1. 它是**引擎自报口径**，与 `packages/engine/src/depgraph/graph.ts` + `parser.ts` 的实现必须同步：
     新增一门语言、补了某条规则，就改这张表；**别在 GUI 或提示词里另写一份判断**。
  2. 取值**照实填**，别因为「想让表好看」抬高某一格。判据见下面 `CapabilityLevel`。
  3. 纯元数据：不参与建图、不进任何缓存键（图的内容、`backendStamp`、摘要与润色缓存都与它无关）——
     改这张表不会引发流程/摘要重烧。真要挪走这份口径，先确认没有键把它算进去。
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
  五个能力格（GUI 与单测都按这份清单遍历，加格要一起改表与测试）：
  - `symbolExtraction` 符号抽取：函数/类/方法是怎么被认出来的、起止行可不可信
  - `dependencyEdge` 依赖边落点：一条依赖边指向哪个文件，可信到什么程度
  - `entrypoint` 入口判定：图上标成「执行入口」的那个文件是怎么定的
  - `packageResolution` 路径别名与包解析：`@/x`、`crate::x`、`com.a.B` 这类非相对路径靠什么落点
  - `buildVisibility` 构建可见性：读不读这门语言的构建/清单文件，因而知不知道「哪些文件真在一起编译」
*/
export const CAPABILITY_CELLS = ["symbolExtraction", "dependencyEdge", "entrypoint", "packageResolution", "buildVisibility"] as const;

export type CapabilityCell = (typeof CAPABILITY_CELLS)[number];

/** 能力格的中文显示名（界面提示用；别在界面上露英文格名）。 */
export const CAPABILITY_CELL_LABEL: Record<CapabilityCell, string> = {
  symbolExtraction: "符号抽取",
  dependencyEdge: "依赖边",
  entrypoint: "入口判定",
  packageResolution: "路径别名与包解析",
  buildVisibility: "构建可见性"
};

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
  /** 五格的取值；类型是必填的 `Record`，漏一格编译就过不去。 */
  cells: Record<CapabilityCell, CapabilityLevel>;
  /** 每格一句白话：说清「为什么是这一档」以及「看到这档该当怎么读」。界面提示条直接用它。 */
  notes: Record<CapabilityCell, string>;
}

/**
  表体。取值依据 = 当前实现（graph.ts 的分派 + parser.ts 的语法覆盖 + roles.ts 的测试路径判定），
  每一格都注了降级理由。改动实现后请同步这里，engine 侧有一份单测钉住「本表的扩展名清单
  与 `DependencyGraph` 实际处理的扩展名清单不漂移」。
  只用 `satisfies` 不用 `as const`：键的字面量类型留着（`SupportedLanguage` 靠它），
  但值里的 `extensions` 需要是可写数组，`as const` 会让它变成只读元组而通不过类型检查。
*/
export const LANGUAGE_CAPABILITIES = {
  typescript: {
    language: "typescript",
    displayName: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    cells: { symbolExtraction: "exact", dependencyEdge: "exact", entrypoint: "approximate", packageResolution: "approximate", buildVisibility: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、类、方法、接口与类型别名，起止行是解析出来的而不是按大括号数出来的。语法树整体加载失败时引擎会回落逐行匹配，并在图数据里写明回落原因。",
      dependencyEdge: "边来自真正的 import / export 语句，落点按「同名文件是否真在仓库里」逐个验证。第三方包与解析不到的写法不会画出来，所以这里的少边是真少，不是连错。",
      entrypoint: "package.json 里 main / bin / scripts 指到的文件可信；其余入口按文件名（main、index、app、server、cli）认，同名但并非入口的文件会被误标。",
      packageResolution: "只读仓库根那一份 tsconfig.json 的 paths，且只认带星号的通配别名（如 `@/*` → `src/*`）；精确别名、通过 extends 继承来的配置、包内的导出映射都不读，这类别名导入会画不出边。",
      buildVisibility: "读过根 package.json 与 tsconfig.json，但没有应用 include / exclude，也不看子包配置，所以图里的文件集合来自目录扫描，不受构建范围约束。"
    }
  },
  vue: {
    language: "vue",
    displayName: "Vue 组件",
    extensions: [".vue"],
    cells: { symbolExtraction: "approximate", dependencyEdge: "approximate", entrypoint: "unsupported", packageResolution: "approximate", buildVisibility: "unsupported" },
    notes: {
      symbolExtraction: "单文件组件没有专属语法：引擎把 `<script>` 块以外的行原地垫空，再按脚本语言解析。脚本里的函数与常量能拿到，模板与样式里的东西不进符号表。",
      dependencyEdge: "`<script>` 里的 import 走 TypeScript 那条规则，可信；但模板里 `<SomeButton />` 这类组件引用不会产生边，所以「这个页面用到那个组件」在图上看不见。",
      entrypoint: "没有针对 Vue 的入口规则。能标出来的入口来自 package.json 与 main.ts、App.vue 这类文件名约定，那是通用兜底。",
      packageResolution: "只认 tsconfig.json 里的通配别名；构建配置里另设的别名（如 vite / webpack 的别名表）不读，这类导入画不出边。",
      buildVisibility: "Vue 与构建器的配置文件一条都没读，因此不知道实际构建包含哪些文件、也没法把单文件组件拆成它的依赖。"
    }
  },
  python: {
    language: "python",
    displayName: "Python",
    extensions: [".py"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "unsupported", buildVisibility: "unsupported" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数与类，方法的归属靠缩进层级判定，起止行不再靠猜。语法树加载失败时回落逐行匹配（引擎会写明原因）。",
      dependencyEdge: "import 语句本身是真的，但 Python 的模块名是点号路径，落点要试文件：`from a.b import c` 会同时试 `a/b.py`、`a/b/__init__.py` 和 `a/b/c.py`——同名目录或文件会连错；标准库与第三方包按设计不入图。仓库不是「根目录就是包根」的布局（例如代码在 `src/` 下）时，绝对导入落不到点。",
      entrypoint: "认的是框架级语句而不是文件名：应用对象（`app = FastAPI(...)`）、Django 的路由表、挂在应用对象上的路由装饰器、启动语句，以及脚本守卫 `if __name__ == \"__main__\":`——命中即取代按文件名猜，且一个文件只取最强的一条。没覆盖到的（其它 Web 框架、命令行工具的入口声明）只剩文件名约定兜底；装饰器那一条理论上会把同名的其它装饰器误认成路由。",
      packageResolution: "不读任何包配置（pyproject.toml、setup.cfg、requirements.txt），没有源码根布局与命名空间包的概念。",
      buildVisibility: "打包与依赖清单一条都没读，因此分不清包内代码与 vendored 依赖，也不知道哪些文件真属于同一个分发单元。"
    }
  },
  java: {
    language: "java",
    displayName: "Java",
    extensions: [".java"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "approximate", buildVisibility: "unsupported" },
    notes: {
      symbolExtraction: "按真实语法树抽取类、方法、构造器、接口、枚举与记录，起止行是解析出来的。",
      dependencyEdge: "三条路：① 直接 import（`import com.a.B;`）按「包名 + 文件名」定位，通常可信；② `import com.a.*;` 这种整包导入只在类名真的出现在正文（含注释）里时才补一条边，强度低于直接 import；③ 类型派发边——类头 `extends`/`implements` 的落点（接口与实现之间没有调用行，靠它把实现类接回执行流）。跨文件调用边认「类名.方法(」与**变量接收者**：`mapper.insert(` 靠字段、方法参数、局部变量三种声明形状换成类型，换不出就退回裸名匹配。注释与 import 行在扫描前抹掉（等长替换，行号不变），注释里写的 `xxxService.handle(...)` 不算调用证据。同名类型、继承来的方法、内部类的归属仍可能指错，所以整格是 approximate。",
      entrypoint: "Spring 仓可信：启动类与控制器上的框架注解是权威标记，路由前缀能直接报出来。但非 Spring 的 Java 仓目前没有规则（连 `public static void main` 都还没进主函数清单），只剩文件名约定兜底。",
      packageResolution: "全限定类名靠每个文件自己的 package 声明来定，这条可信；但同名类型的取舍、内部类与静态成员的精确归属靠逐级去尾试探，不做模块级区分。",
      buildVisibility: "不读 Maven / Gradle 构建文件：分不清主代码目录与测试目录的构建范围，生成的源码目录也被当成普通源码进图。"
    }
  },
  go: {
    language: "go",
    displayName: "Go",
    extensions: [".go"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "approximate", buildVisibility: "approximate" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、方法和类型（结构体 / 接口的名字在类型声明里单独展开）。",
      dependencyEdge: "Go 的 import 指向「包」（一个目录）而不是文件，落点会把该目录下所有非测试文件各连一条边——粒度是整个包，比真正用到的那几个文件宽。对不上仓内模块前缀的（外部仓库、被替换的依赖）不画。",
      entrypoint: "`func main()` 是语言级的唯一起点，命中即确定；每个可执行文件一个，测试文件已排除。",
      packageResolution: "读每个 go.mod 的 module 行来划仓内边界，这块可信；替换指令、多模块工作区文件与 vendored 目录不认，这类路径落不到点。",
      buildVisibility: "读过 go.mod（模块名），但不读工作区与 vendor 清单，也不按构建标签取舍文件，所以图里的文件集合按目录扫描，不随构建条件变化。"
    }
  },
  rust: {
    language: "rust",
    displayName: "Rust",
    extensions: [".rs"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "approximate", buildVisibility: "unsupported" },
    notes: {
      symbolExtraction: "按真实语法树抽取函数、结构体、trait、枚举与模块；impl 块里的函数升为方法。",
      dependencyEdge: "两种仓内关系都认：`mod x;`（子模块声明，落 `x.rs` 或 `x/mod.rs`，与编译器一致）和 `use crate::a::b;`。后者会一段段去掉尾部往上找能落地的文件，所以 `use crate::a::b::Thing` 常连到 a 的模块文件而不是 Thing 真正定义的文件——方向对、位置偏粗。属性里指定的非常规文件名不认。",
      entrypoint: "`fn main()` 是语言级起点，命中即确定。库工程没有 main 是正常情况，不算入口缺失。",
      packageResolution: "`crate::` 的起点按约定假定为 `src/`，`mod` 声明相对当前文件解析（这两条覆盖标准布局）；但不读 Cargo.toml，`[lib]`/`[[bin]]` 指定的自定义入口落不到点。",
      buildVisibility: "Cargo.toml 没读：工作区成员、测试与基准目录的构建边界、按功能开关取舍的代码都判不出来。"
    }
  },
  csharp: {
    language: "csharp",
    displayName: "C#",
    extensions: [".cs"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "approximate", packageResolution: "unsupported", buildVisibility: "unsupported" },
    notes: {
      symbolExtraction: "按真实语法树抽取类、结构体、接口、枚举与方法。",
      dependencyEdge: "`using A.B.C;` 指向命名空间而非文件，落点是「声明了这个命名空间的全部文件」，比真正用到的类宽。命名空间靠正文里的 namespace 语句收（块式与文件式都收）；跨项目引用（类型在另一个工程里）落不到点。",
      entrypoint: "`Main` / `MainAsync` 方法名命中即可信；但新版允许的顶层语句（入口文件直接写代码、不声明 Main）认不出来，这类仓只能退回文件名约定。",
      packageResolution: "不读工程文件与解决方案文件：没有项目引用的概念，全仓按命名空间字符串混在一起找落点。",
      buildVisibility: "工程文件没读：目标框架、按条件编译取舍的代码、被排除的文件都判不出来，生成物目录只在目录排除规则生效时才不进图。"
    }
  },
  cpp: {
    language: "cpp",
    displayName: "C / C++",
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
    cells: { symbolExtraction: "exact", dependencyEdge: "approximate", entrypoint: "exact", packageResolution: "unsupported", buildVisibility: "unsupported" },
    notes: {
      symbolExtraction: "按真实语法树抽取（C 与 C++ 共用一份语法）。C 的函数名不在独立字段里，要从声明符链条末端取，实现已覆盖指针与引用修饰。",
      dependencyEdge: "只认引号形式的 `#include \"x.h\"`（项目内头文件），尖括号是系统或第三方头，按设计不入图。先按当前文件同目录解析（编译器的首要规则）；解析不到就退化成「全仓里路径以这个名字结尾的文件」，多个命中就全连——这些是按文件名猜的边。头文件搜索路径（编译时指定的包含目录）无从得知。",
      entrypoint: "`int main(` 是语言级起点，命中即确定。",
      packageResolution: "没有包管理器清单可查，引擎也没读：包含目录、库依赖关系都不判。",
      buildVisibility: "构建脚本（CMake / Bazel / makefile）一条都没读：编译单元怎么划分、宏定义了哪些分支、按条件取舍的文件都判不出来。"
    }
  }
} satisfies Record<string, LanguageCapabilities>;

/** 本表覆盖的语言 id（`languageCapabilitiesOf` 对未知语言回落的条目不在此列）。 */
export type SupportedLanguage = keyof typeof LANGUAGE_CAPABILITIES;

/** 五格全为 `unsupported` 的回落条目：未知语言用它，界面会明说「这门语言没有规则」。 */
export const UNKNOWN_LANGUAGE_CAPABILITIES: LanguageCapabilities = {
  language: "unknown",
  displayName: "未知语言",
  extensions: [],
  cells: { symbolExtraction: "unsupported", dependencyEdge: "unsupported", entrypoint: "unsupported", packageResolution: "unsupported", buildVisibility: "unsupported" },
  notes: {
    symbolExtraction: "引擎没有这门语言的语法，文件里的函数与类进不了符号表。",
    dependencyEdge: "引擎没有这门语言的依赖解析规则，图里不会出现它指向别人或别人指向它的边。",
    entrypoint: "没有入口规则，只有跨语言的文件名约定可能把它误认成入口。",
    packageResolution: "非相对路径无处可查，落不了点。",
    buildVisibility: "构建清单不读，实际编译范围未知。"
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
  未知语言回落 `UNKNOWN_LANGUAGE_CAPABILITIES`（全格 `unsupported`），**不假装是 approximate**。
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

/** 本仓一门语言的分布与它的能力档（`inDependencyGraph` 为假时只有分布，图里没有它的边）。 */
export interface RepositoryLanguageRow {
  language: string;
  displayName: string;
  extensions: string[];
  files: number;
  lines: number;
  /** 占本仓被索引文件的文件数比例，0-1 */
  fileShare: number;
  /** 这类文件会进依赖图吗（引擎只处理 `DependencyGraph` 那串扩展名） */
  inDependencyGraph: boolean;
  capabilities: LanguageCapabilities;
}

/**
  随分析响应下发的语言画像（引擎**请求时现算**，不落库、不参与任何缓存键）。
  `parseBackend` 是全局回落位：它为 `regex` 时，上面各语言的「符号抽取」都要按近似读。
*/
export interface RepositoryLanguageProfile {
  /** 按文件数从多到少排；未知语言按扩展名各占一行（合并成一行会把「300 个 Markdown」说成「一门语言没规则」） */
  languages: RepositoryLanguageRow[];
  /** 进入依赖图的文件占本仓被索引文件的比例，0-1。很低时，这张图的边本来就只覆盖一小部分仓库。 */
  graphFileShare: number;
  parseBackend: "ast" | "regex";
  parseBackendReason?: string;
}

export interface ImpactResult {
  changedPaths: string[];
  impactedPaths: string[];
  edges: { from: string; to: string; kind: "import" | "call" }[];
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
  verification: AssertionCheck[];
}

export interface QualityReport {
  generatedAt: string;
  micro: AssertionCheck[];
  macro: AssertionCheck[];
  skippedBecause?: string;
}

export interface RepositoryAnalysis {
  repositoryId: string;
  generatedAt: string;
  graph: DependencyGraphData;
  implementations: ImplementationUnit[];
  quality: QualityReport;
  versionStamp: string;
  /** 分析那一刻的 git HEAD（`git rev-parse HEAD`）。非 git 仓或取不到时缺省；懒挂载用它与当前 HEAD 比对新鲜度。 */
  gitHead?: string;
  lastIncrementalUpdate?: { changedPaths: string[]; impactedPaths: string[]; at: string };
  /**
    本仓语言分布 + 每语言能力档。**只在 HTTP 响应里现算**（见 engine `GET /api/repositories/:id/analysis`）：
    不落库、不进缓存键，所以已导入的仓不用重烧就能看到这份口径；旧产物/旧引擎读不到时就当没有，
    界面按「没有提示」处理，不自己另判一套语言规则。
   */
  languageProfile?: RepositoryLanguageProfile;
}

/**
  跨语言 HTTP 接缝：前端那条 `request.get('/shop/list')` 与后端 `@GetMapping("/list")` 之间
  **没有任何语法级依赖**——两边唯一的共享标识符是路由字符串，所以整仓依赖图天生看不见这条链。
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

/** `GET /api/repositories/:id/seams?with=<另一个仓>` 的响应：本仓↔相关仓的双向接缝。 */
export interface SeamReport {
  repositoryId: string;
  otherRepositoryId: string;
  /** 本仓调用相关仓的接口（本仓是消费方） */
  outbound: SeamDirection;
  /** 相关仓调用本仓的接口（本仓是提供方） */
  inbound: SeamDirection;
}

/**
  挂载在引擎内存里的仓库的新鲜度判定（**只报告，不触发任何重分析**）：
  - `contentChanged` = 磁盘内容与产物记录的 `versionStamp` 不一致（真的过期了）；
  - `changedFiles` = 与落库 `contentHash` 不一致的文件数（告诉用户「改动集中在哪几处」，比只说「脏了」有用）；
  - HEAD 变了但内容哈希没变（切分支回到同一份内容、或提交移动但工作树相同）判 `drifted`——产物仍可用，只是要知道分析点在别的提交上；
  - 老仓库没记 HEAD 时判 `unknown`，界面明说「只比对了文件内容」。
  */
export type RepositoryFreshnessVerdict = "fresh" | "drifted" | "stale" | "unknown";

export interface RepositoryFreshness {
  verdict: RepositoryFreshnessVerdict;
  /** 产物生成时间（`analysis.generatedAt`），界面据此说「这是几天前的分析」 */
  analyzedAt: string;
  versionStamp: string;
  contentChanged: boolean;
  changedFiles: number;
  headAtAnalysis?: string;
  headNow?: string;
}

/** 地址簿里的一条（引擎**不读产物**就能列出；`mounted` 才带新鲜度）。 */
export interface RepositoryCatalogEntry {
  repositoryId: string;
  repositoryPath: string;
  /** 目录名，界面显示用 */
  name: string;
  mounted: boolean;
  /** 目录还在吗（不存在时保留条目并如实标注，由用户决定移除） */
  exists: boolean;
  /** 产物是否已就绪（`.tutor/tutor.db` 里四件套齐不齐）；未挂载时不探测，缺省 */
  artifactsReady?: boolean;
  freshness?: RepositoryFreshness;
  /**
    增量监听此刻活着吗（只挂着的仓有值）。false = 这个仓**不会**自动跟上磁盘改动，
    上面那份 `freshness` 只到挂载那一刻为止——不报这条，界面就会一直拿一次旧判定说「产物是新的」。
    */
  watching?: boolean;
  /** 监听起不来或中途死掉的报错原文，配合 `watching: false` 看 */
  watchError?: string;
  /**
    预算闸门此刻是否失效（只在失效时有值）。挂在地址簿而不是等用户进了仓才在成本页说：
    单价没配 ⇒ 闸门判不出超支 ⇒ 下一次导入就是在无上限花钱，这句话必须出现在花钱**之前**那页。
    */
  budgetGateNotice?: string;
}

/** 懒挂载失败的原因：GUI 要靠它分清「清掉工作区」还是「留着让用户处置」。 */
export type RepositoryMountReason = "not_in_catalog" | "directory_missing" | "artifacts_incomplete";

/** 流程环节的性质；界面据此给不同的徽标（判断/回环与普通环节的读法不同）。 */
export type FlowStageKind = "entry" | "stage" | "decision" | "loop" | "exit";

/** 环节关联的一个文件。**只在节点详情里展示**——画布上不出现路径，避免流程视图退化成定位清单。 */
export interface FlowStageFile {
  path: string;
  line: number;
  /** 该文件在这个环节里承担什么（≤40 字） */
  note?: string;
}

/**
 * 流程视图的一个环节：由 LLM 依据静态证据（依赖关系、符号、静态调用链）生成。
 * 与静态调用链的区别正是它存在的理由——回调注册（`add_node("evaluate", evaluate)`）、
 * 反射、依赖注入这类编排不会产生调用边，静态图看不见，而模型可以从文件与符号语义里读出来。
 */
export interface FlowStage {
  /** 展示序号，1 起 */
  order: number;
  kind: FlowStageKind;
  /** 环节名（≤14 字） */
  title: string;
  /** 环节说明：一句简要描述（提示词约束，不展开实现细节；≤160 字为防御上限，超出引擎截断并以「…」收尾） */
  detail: string;
  /** 关联文件；全部经仓库索引校验，不存在的路径不会出现在这里 */
  files: FlowStageFile[];
  /** 分叉说明：该环节的多条去向与判断依据（有一个以上去向时给出） */
  branches: string[];
  /** 回环目标序号：回到本流程内更靠前的某个环节（有回边时给出） */
  loopsTo?: number;
}

/**
  流程里的一条边（环节之间的去向 + 它的依据）。

  `origin` 必须显式区分三种来源，这是「读到的」与「推断的」的分界：
  - `static`：依赖图能证明（两个环节的文件之间存在 import 或跨文件调用）
  - `code`：在**源码正文**里读到的（回调或节点注册、路由表、依赖注入、事件订阅），
    依赖图上看不见，但代码里写着；evidence 必须引到这条边自己的文件上
  - `inferred`：模型的编排常识推断，没有可核对的行级依据

  ⚠️ 边级校验**只降不升**：声称 `static` 但依赖图对不上的会降为 `inferred`（不删边——删边会篡改
  拓扑，降级保真度更高）；`code` 只由「按需深入」那一步在真的读过正文之后给出。
*/
export interface FlowEdge {
  /** 起点环节序号（1 起，对应 `FlowStage.order`） */
  from: number;
  /** 终点环节序号（1 起） */
  to: number;
  origin: "static" | "code" | "inferred";
  /** 这条边的依据；静态边给「文件:行 → 文件:行」，代码边给「文件:行 + 是什么结构」。非空。 */
  evidence: string;
}

/** 一条从入口出发的执行流程（流程视图的数据源）。 */
export interface RepositoryFlow {
  entry: SourceAnchor;
  /** 整条流程的标题（≤18 字） */
  title: string;
  /** 流程总述（≤100 字） */
  summary: string;
  stages: FlowStage[];
  /** 环节之间的去向；**这是拓扑的真源**，`stages[].branches` 只是给人看的文字说明。 */
  edges: FlowEdge[];
  /** 自述没能确认的部分（例如怀疑参与但证据不足的文件、看不清的分支）。 */
  uncovered?: string[];
  /** 已知边界：模型自述的不确定处、被校验丢弃的内容、或降级说明。界面原样展示，不吞掉。 */
  caveats?: string;
  generatedAt: string;
}

/** 流程环节数上限；超出即截断，并在 `caveats` 里明示截断了多少。 */
export const FLOW_MAX_STAGES = 12;

/** 流程生成来源。`static` = 静态调用链降级（LLM 未配置、预算触顶或调用失败），必须显式告知用户。 */
export interface RepositoryFlowResult {
  flow: RepositoryFlow;
  source: "llm" | "static";
  /** source=static 时的原因 */
  reason?: string;
}

/** 一个计费档位：输入拆「未命中 / 缓存命中」两档价，输出单独一档。 */
export interface CostComponent {
  label: "未命中输入" | "命中输入（缓存）" | "输出";
  tokens: number;
  ratePerMillionUsd: number;
  /** true = 命中价没单独配置，按输入价计（不打折：宁可高估，也不要把花掉的钱说少） */
  rateFallback: boolean;
  estimatedCostUsd: number;
}

/** 成本聚合的一个分桶（按场景或按 provider），一条 `token_usage` 记一个回合。 */
export interface CostBucket {
  label: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

/** 按自然日（本地时区无关，取 journal `at` 的前 10 位）聚合的用量，画近期条形用。 */
export interface CostDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CostSummary {
  sessionId?: string;
  /** 输入总用量（含命中那部分，与 provider 的 prompt_tokens 同口径） */
  inputTokens: number;
  /** 按未命中价计费的那部分输入 = inputTokens − cacheHitTokens（逐条相减后求和，不为负） */
  billedInputTokens: number;
  /** 命中前缀缓存、按命中价计费的那部分输入；provider 没上报时为 0 */
  cacheHitTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  monthlyBudgetUsd: number;
  remainingBudgetUsd: number;
  mode: "normal" | "degraded";
  /** 本月计入的回合数 */
  turns: number;
  /** 三档计费的逐项明细；estimatedCostUsd 就是这三项之和 */
  costComponents: CostComponent[];
  /**
    三档单价是否全未配置（`TUTOR_INPUT_USD_PER_MILLION` / `TUTOR_CACHE_HIT_USD_PER_MILLION` / `TUTOR_OUTPUT_USD_PER_MILLION`）。
    ⚠️ false 的连带后果比「金额不好看」严重：`mode` 由「算出的钱 ≥ 预算」决定，钱算不出来就恒为 0、
    永远判 "normal"，于是**所有**「超预算回落本地规则」的闸门一起静默放行——不是没超预算，是根本没比过。
    界面必须把这一格说成「预算闸门未生效」，不能只报 $0.0000。
    */
  pricingConfigured: boolean;
  /** 因预算触顶而走本地规则（不付 token）的回合数 */
  degradedTurns: number;
  byScene: CostBucket[];
  byProvider: CostBucket[];
  byDay: CostDay[];
}

export type ExerciseKind = "output_prediction" | "change_localization" | "impact_analysis" | "llm_rubric";
/** 规则出题族题型：题面/选项/标准答案全部由静态分析与受限执行产出（server 校验 / 缓存命中校验共用这一份）。 */
export const EXERCISE_KINDS: ExerciseKind[] = ["output_prediction", "change_localization", "impact_analysis"];
/** 练习题族：comprehension=程序理解题（规则出题、确定性判分），llm=LLM 出题（rubric 判分）。family 是实现层概念，对用户不可见。 */
export type ExerciseFamily = "comprehension" | "llm";
export type ExerciseInputMode = "text" | "multi_select" | "open";
export type ExerciseGradingMode = "execution" | "set_match" | "rubric";
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

export interface ExerciseAnswer {
  text?: string;
  selectedIds?: string[];
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
  feedbackSource?: "rule" | "llm_polished" | "llm_judge";
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
  dependencyEvents: number;
  averageHintDepth: number | null;
  lastStage?: TeachingStage;
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

  - 引擎侧（学习语义）：unit_mastered 起至 file_read；由引擎在状态机 / 工具循环 / 成本核算里写。
  - UI 侧（交互动作）：flow_node_selected 起至 repository_switched；由 GUI 经 `POST /api/repositories/:id/journal` 写。
    这条契约来自设计文档第 8 章 PRINCIPLE 03「可观测」：每次切节点、打开文件、切换模块、提交练习都必须有事件可查。

  ⚠️ 改这里必须同步 `packages/engine/src/store/journal.ts` 的运行时 `eventTypes` Set——
  它才是 `Journal.append` 的白名单，漏同步会在运行期抛 `Unknown journal event`。
  append-only：只许新增，不许改名既有取值；删除只发生过一次例外——teach_moment 随 companion 功能于 2026-09-22 整体移除
  （readJournal 读侧不校验类型，历史仓里的旧 teach_moment 事件仍可读，只是不再接受新写入）。
  */
export type JournalEventType =
  // 引擎侧
  | "unit_mastered"
  | "exercise_result"
  | "hint_depth"
  | "dependency_event"
  | "style_shift"
  | "unassisted_test"
  | "action_veto"
  | "exercise_declined"
  /** 练习**送达**事件（漏斗分母）：payload.source = llm|cache|rule|review；拒绝侧另有 exercise_declined。 */
  | "exercise_generated"
  | "token_usage"
  | "file_read"
  | "code_search"
  | "scope_degraded"
  /** 回合文本落盘（2026-09-22 拍板口径）：payload = scene(teach|map_chat|practice_chat) + question/answer
    双边原文，各截 2000 字并带 *_truncated 留痕；永久追加、不做 TTL、无开关。B 档第 2/3 刀（教学法机检、
    表达质量裁判）的被测输入源。 */
  | "turn_text"
  /** 运行期不变量复检（2026-10-04，B 档第 2 刀的在环那一半）：一回合一条，**合格也记**（分母要在环成立）。
    payload = scene(teach|map_chat|practice_chat) + applicable(该回合该判的条目) + failed(失守条目) + evidence(逐条证据摘录)。
    判据与离线 `phaseB:eval` 第 4 节共用同一个函数，所以「线上说合格、离线算不合格」不可能出现。 */
  | "turn_invariant"
  /** 会话线程的生命周期事件（2026-09-27 会话持久化）：`session_created` 在引擎发 id 建线程时写，
    `session_deleted` 只在**软删**时写。payload = scope(teach|map|practice) + thread_id + node_id/exercise_id + reason。
    删除是产品线的动作，journal 这条线只留「发生过删除」这一事实，不删任何既有事件行。 */
  | "session_created"
  | "session_deleted"
  /** agent 回合的循环决策摘要（2026-09-27）：一回合一条，记「提议动作 → 守门裁决 → 实际执行」与工具循环轮次。
    practice 对话无 agent loop，不记本事件；veto 侧另有更早的 action_veto（学习语义口径，保留不并入）。 */
  | "loop_round"
  /** 回合被用户主动停止（2026-09-30「停止生成」）：payload = scene(teach|map_chat|practice_chat) + turn_id +
      aborted_by(恒为 user_stop)。与「客户端断开」刻意区分——后者引擎照常算完落库，不记本事件。
      中止的一轮没有成品：不写 turn_text，也不伪造 assistant 正文。 */
  | "turn_aborted"
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
    架构视图里把本仓与地址簿里的另一个仓配对（跨仓 HTTP 接缝）。**引擎侧写**：
    这条读的是两个仓的源码，成本与「配得上几条」都是要能查的数，交给 GUI 写就会漏掉直接打 API 的调用。
    payload：`other_repository_id` / `outbound` / `inbound`（两个方向各自配上的条数）。
    */
  | "repository_paired"
  /**
    用户手动把某个模块改成另一档（主干 / 设施 / 外围）。GUI 侧写。
    payload：`module_id` / `module_label` / `from` / `to` / `core_share`（改的时候引擎算的占比，用来看判据离真值有多远）。
    结构判据没有真值可比，这条就是攒真值的读数——攒够了才谈「判据改对了没」。
    */
  | "module_tier_overridden";

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
  durationMs?: number | null;
  detail: Record<string, TraceScalar>;
}

/** 全局事件流（GET /api/events，SSE）的广播事件：导入进度与仓库更新。对话的 delta/progress 不走这里——它们在各自请求的响应流里。 */
export interface ServerEvent {
  type: "import.progress" | "repository.updated";
  payload: Record<string, unknown>;
}
