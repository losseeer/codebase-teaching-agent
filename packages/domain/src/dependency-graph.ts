import type { SourceAnchor } from "./repository-index.js";

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

export interface ImpactResult {
  changedPaths: string[];
  impactedPaths: string[];
  edges: { from: string; to: string; kind: "import" | "call" }[];
}
