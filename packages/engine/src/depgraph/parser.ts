import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { SymbolInfo } from "@codebase-tutor/shared";
import { traceEngine } from "../trace/engine-log.js";

/**
  基于语法树的符号抽取（替代原先的逐行文本匹配）。

  逐行匹配的固有缺陷：只认「长得像函数定义行」的文本，于是类方法被当成普通函数、
  接口与类型别名根本认不出来，函数体到哪一行结束还要靠数大括号猜——代码里出现含大括号的
  字符串或注释就会猜错。而 `endLine` 是锚点高亮、调用归属、微观讲解切片的共同依据。

  实现用 WASM 版解析器（`web-tree-sitter` + VS Code 预编译的语法文件），**不引入原生模块**：
  本项目已经在数据库驱动上吃过「换 Node 版本就要重新配预编译二进制」的亏，不再增加这类依赖。

  ⚠️ 加载失败**不抛给调用方**：回落逐行匹配，但必须把原因写进图数据的 `parseBackendReason`
  并记一条 `degrade` 工作日志——静默降级是明令禁止的。
*/

export type ParseBackend = "ast" | "regex";

export interface ParseBackendStatus {
  backend: ParseBackend;
  /** 回落原因（backend === "regex" 时必有） */
  reason?: string;
}

/** 只覆盖依赖图真正处理的扩展名（其余语言本来就走不进这里）。wasm 全部来自 `@vscode/tree-sitter-wasm`，零新增依赖。 */
const GRAMMAR_FILES = {
  python: "tree-sitter-python.wasm",
  java: "tree-sitter-java.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  csharp: "tree-sitter-c-sharp.wasm",
  cpp: "tree-sitter-cpp.wasm"
} as const;

type GrammarName = keyof typeof GRAMMAR_FILES;

/** 语法选择按扩展名：`.jsx` 用 tsx 语法（JSX 是它的子集，纯 JS 语法解析不了 JSX）。 */
function grammarOf(path: string): GrammarName | undefined {
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".cs")) return "csharp";
  if (/\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(path)) return "cpp";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return "tsx";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  return undefined;
}

/** `SymbolInfo.language` 的口径与索引层保持一致，与用哪种语法解析无关。 */
function languageOf(path: string): SymbolInfo["language"] {
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".cs")) return "csharp";
  if (/\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(path)) return "cpp";
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) ? "typescript" : "other";
}

type SyntaxNode = NonNullable<ReturnType<Parser["parse"]>>["rootNode"];

let loading: Promise<ParseBackendStatus> | undefined;
let status: ParseBackendStatus = { backend: "regex", reason: "语法解析器尚未加载" };
const grammars = new Map<GrammarName, Language>();
let parser: Parser | undefined;

export function parseBackendStatus(): ParseBackendStatus {
  return status;
}

/**
  加载解析器与语法文件（幂等：并发调用共享同一次加载）。

  必须在建图之前 await 一次——解析器的初始化是异步的，而建图是同步的；
  没加载就建图会走逐行匹配，属于「能跑但结果更差」，所以由调用方显式决定何时加载，
  而不是在建图里偷偷 await。
*/
export function loadSymbolParser(): Promise<ParseBackendStatus> {
  loading ??= (async (): Promise<ParseBackendStatus> => {
    try {
      await Parser.init();
      const require = createRequire(import.meta.url);
      const wasmDir = dirname(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm"));
      for (const [name, file] of Object.entries(GRAMMAR_FILES) as [GrammarName, string][]) {
        grammars.set(name, await Language.load(join(wasmDir, file)));
      }
      parser = new Parser();
      status = { backend: "ast" };
    } catch (error) {
      const reason = `语法解析器加载失败（${error instanceof Error ? error.message : String(error)}），本次分析已回落逐行文本匹配`;
      status = { backend: "regex", reason };
      traceEngine("degrade", { component: "depgraph.parser", reason }, { traceId: null });
    }
    return status;
  })();
  return loading;
}

/** 仅测试用：把状态复位，便于分别验证「加载成功」与「加载失败回落」两条路径。 */
export function resetSymbolParserForTest(): void {
  loading = undefined;
  grammars.clear();
  parser = undefined;
  status = { backend: "regex", reason: "语法解析器尚未加载" };
}

const TS_FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration"]);
const TS_CLASS_NODES = new Set(["class_declaration", "abstract_class_declaration", "record_declaration"]);
/** 接口/类型别名/枚举：不是可执行体，但是理解文件职责的重要名字（工程上常比函数名更能说明用途）。 */
const TS_TYPE_NODES = new Set(["interface_declaration", "type_alias_declaration", "enum_declaration"]);
const TS_VARIABLE_NODES = new Set(["lexical_declaration", "variable_declaration"]);
const TS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

/** 声明节点的 kind；认不出来返回 undefined。方法用节点类型直接判定，不依赖外层是不是类（对象字面量里的简写方法也是方法）。 */
function kindOf(type: string, inClass: boolean): SymbolInfo["kind"] | undefined {
  if (TS_FUNCTION_NODES.has(type)) return "function";
  if (TS_CLASS_NODES.has(type)) return "class";
  // Java：class/record/interface/enum 与 TS 同名节点共享上面的集合；方法与构造器是 Java 独有类型
  if (type === "method_declaration" || type === "constructor_declaration") return "method";
  if (type === "method_definition") return "method";
  if (TS_TYPE_NODES.has(type)) return "type";
  if (type === "class_definition") return "class";
  if (type === "function_definition") return inClass ? "method" : "function";
  // Go：function_declaration/method_declaration 与前序语言共享；type_declaration 的名字在 type_spec 里，单独展开
  // C#：struct 与类同权重（可执行体、有成员）；接口/枚举/记录已共享 TS 集合
  if (type === "struct_declaration") return "class";
  // Rust：fn/struct/trait/enum/mod；impl 无名（体成员由递归收进来，inClass 让其升为 method）
  if (type === "function_item") return inClass ? "method" : "function";
  if (type === "struct_item" || type === "union_item") return "class";
  if (type === "trait_item" || type === "enum_item" || type === "mod_item") return "type";
  // C/C++：class/struct 是值类型家族（class_specifier 有 name 字段），enum 只有声明价值
  if (type === "class_specifier" || type === "struct_specifier") return "class";
  if (type === "enum_specifier") return "type";
  return undefined;
}

/** C 系 function_definition 没有 name 字段，名字藏在 declarator 链的末端（`int *foo(void)` → declarator(pointer_declarator(function_declarator(identifier)))）。 */
function declaratorName(node: SyntaxNode): string | undefined {
  // C 的函数名节点就叫 identifier；C++ 才有 qualified_identifier/destructor_name 这些带后缀的变体
  const isNameNode = (type: string): boolean => type === "identifier" || type === "destructor_name" || type.endsWith("_identifier");
  let current: SyntaxNode | null | undefined = node.childForFieldName("declarator");
  const seen = new Set<number>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isNameNode(current.type)) {
      return current.type === "qualified_identifier" ? (current.text.split("::").pop() ?? current.text) : current.text;
    }
    current = current.childForFieldName("declarator") ?? current.namedChildren.find((child) => child.type.endsWith("_declarator") || isNameNode(child.type));
  }
  return undefined;
}

/** 「进入这些节点后，体内的函数定义算成员方法」：TS/Java/Python 类 + C++ 的 class/struct + Rust 的 impl/trait。 */
const CONTAINER_BODIES = new Set<string>([...TS_CLASS_NODES, "class_definition", "class", "class_specifier", "struct_specifier", "impl_item", "trait_item"]);

/** 参数原文列表：取参数节点的具名子节点，带类型标注/默认值/可见性修饰都原样保留。 */
function parameterTexts(node: SyntaxNode): string[] {
  const list = node.childForFieldName("parameters");
  if (!list) return [];
  return list.namedChildren.map((child) => child.text.trim()).filter(Boolean);
}

/** `export_statement`（TS）与 `decorated_definition`（Python）只是外壳，真正的声明在里面。 */
function unwrap(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === "export_statement") return node.childForFieldName("declaration") ?? undefined;
  if (node.type === "decorated_definition") return node.childForFieldName("definition") ?? undefined;
  return undefined;
}

function symbolOf(node: SyntaxNode, path: string, kind: SymbolInfo["kind"]): SymbolInfo | undefined {
  // C/C++ 的 function_definition 没有 name 字段，名字要从 declarator 链取
  const name = node.childForFieldName("name")?.text.trim() || declaratorName(node);
  if (!name) return undefined;
  const line = node.startPosition.row + 1;
  return {
    // id 格式与旧实现一致：它写进 `analysis_json` 并被调用边按 `calleeSymbol` 引用，不能改
    id: `symbol:${path}:${name}:${line}`,
    name,
    kind,
    path,
    line,
    // 语法树给的是**最后一行（含）**，与旧的「数大括号/看缩进」结果口径一致但不再猜错
    endLine: node.endPosition.row + 1,
    parameters: parameterTexts(node),
    language: languageOf(path)
  };
}

/** 变量声明里的箭头函数/函数表达式/类表达式：`const f = () => {}` 这类旧实现也在收，语义保持一致。 */
function collectVariableDeclarators(node: SyntaxNode, path: string, out: SymbolInfo[]): void {
  for (const declarator of node.namedChildren) {
    if (declarator.type !== "variable_declarator") continue;
    const value = declarator.childForFieldName("value");
    if (!value) continue;
    const kind: SymbolInfo["kind"] | undefined = TS_FUNCTION_VALUES.has(value.type) ? "function" : value.type === "class" ? "class" : undefined;
    if (!kind) continue;
    const name = declarator.childForFieldName("name")?.text.trim();
    if (!name) continue;
    // 具名声明用变量名定位，区间取「声明行 → 值的结束行」，与直接写 function 的观感一致
    out.push({
      id: `symbol:${path}:${name}:${declarator.startPosition.row + 1}`,
      name,
      kind,
      path,
      line: declarator.startPosition.row + 1,
      endLine: value.endPosition.row + 1,
      parameters: value.type === "class" ? [] : parameterTexts(value),
      language: languageOf(path)
    });
  }
}

function collectSymbols(node: SyntaxNode, path: string, inClass: boolean, out: SymbolInfo[]): void {
  const inner = unwrap(node);
  if (inner) {
    collectSymbols(inner, path, inClass, out);
    return;
  }
  // Go 的 type_declaration 只是外壳：名字在各自 type_spec 里，kind 按类型本体区分（struct/interface 是可执行体家族）
  if (node.type === "type_declaration") {
    for (const spec of node.namedChildren) {
      if (spec.type !== "type_spec") continue;
      const specName = spec.childForFieldName("name")?.text.trim();
      if (!specName) continue;
      const specType = spec.childForFieldName("type")?.type;
      const kind: SymbolInfo["kind"] = specType === "struct_type" || specType === "interface_type" ? "class" : "type";
      out.push({
        id: `symbol:${path}:${specName}:${spec.startPosition.row + 1}`,
        name: specName,
        kind,
        path,
        line: spec.startPosition.row + 1,
        endLine: spec.endPosition.row + 1,
        parameters: [],
        language: languageOf(path)
      });
    }
    return;
  }
  const kind = kindOf(node.type, inClass);
  if (kind) {
    const symbol = symbolOf(node, path, kind);
    if (symbol) out.push(symbol);
  }
  if (TS_VARIABLE_NODES.has(node.type)) collectVariableDeclarators(node, path, out);
  // 进到类体之后，Python 的 def、Rust 的 fn、C/C++ 的成员函数就是方法；TS 的方法由节点类型直接判定，不依赖这个标志
  const childInClass = inClass || CONTAINER_BODIES.has(node.type);
  for (const child of node.namedChildren) collectSymbols(child, path, childInClass, out);
}

function parseAndCollect(path: string, content: string, grammar: GrammarName): SymbolInfo[] | undefined {
  const language = grammars.get(grammar);
  if (!parser || !language) return undefined;
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) return undefined;
  const symbols: SymbolInfo[] = [];
  collectSymbols(tree.rootNode, path, false, symbols);
  return symbols;
}

/**
  Vue 单文件组件没有专属语法，但 `<script>` 块本体就是 JS/TS：把块外的行换成空行原地垫出来
  （模板/样式不会误进语法树，块内节点的 `startPosition.row` 天然就是全文件行号），
  再走现有 tsx/js 语法。无语法树可用时返回 undefined，交调用方回落逐行匹配。
*/
function vueScriptSymbols(path: string, content: string): SymbolInfo[] | undefined {
  const lines = content.split("\n");
  const blocks: { start: number; end: number; ts: boolean }[] = [];
  let start: number | undefined;
  let ts = false;
  for (let index = 0; index < lines.length; index += 1) {
    const open = start === undefined ? lines[index].match(/^<script\b([^>]*)>$/) : undefined;
    if (open) { start = index + 1; ts = /lang=["']ts["']/.test(open[1]); continue; }
    if (start !== undefined && /^<\/script>$/.test(lines[index])) {
      blocks.push({ start, end: index, ts });
      start = undefined;
    }
  }
  if (!blocks.length) return [];
  const out: SymbolInfo[] = [];
  for (const block of blocks) {
    // split 出的每行自带换行符，故块前只垫 start-1 个空行；块后补到文件末尾行数，行号全程对齐
    const padded = ["\n".repeat(Math.max(0, block.start - 1)), ...lines.slice(block.start, block.end), "\n".repeat(lines.length - block.end)].join("\n");
    const symbols = parseAndCollect(path, padded, block.ts ? "tsx" : "javascript");
    if (!symbols) return undefined;
    out.push(...symbols);
  }
  return out;
}

/**
  用语法树抽符号。**解析器未就绪或该扩展名没有语法时返回 undefined**（调用方据此回落逐行匹配），
  而不是返回空数组——空数组是「这个文件真没有符号」，两者语义不同。
*/
export function extractSymbolsFromAst(path: string, content: string): SymbolInfo[] | undefined {
  if (!parser) return undefined;
  if (path.endsWith(".vue")) return vueScriptSymbols(path, content);
  const grammar = grammarOf(path);
  if (!grammar) return undefined;
  return parseAndCollect(path, content, grammar);
}
