import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { Language, Parser, type Tree } from "web-tree-sitter";
import { languageOfExtension, type SymbolInfo } from "@codebase-tutor/domain";

import { traceEngine } from "@codebase-tutor/platform";

/**
  基于语法树的符号抽取：`endLine` 是锚点高亮、调用归属与讲解切片的共同依据。
  解析器或语法不可用时回落逐行匹配，原因写入 `parseBackendReason` 并记一条 `degrade` 日志。
  本层是唯一的语法树出口，控制流图与切片都从这里取树。
*/

export type ParseBackend = "ast" | "regex";

export interface ParseBackendStatus {
  backend: ParseBackend;
  /** 回落原因，`backend === "regex"` 时必有。 */
  reason?: string;
}

/** 依赖图处理的语法与对应 wasm 文件，来自 `@vscode/tree-sitter-wasm`。 */
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

export type GrammarName = keyof typeof GRAMMAR_FILES;

/** 按扩展名选语法：`.jsx` 走 tsx 语法。 */
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

/** 扩展名到语言的映射用共享能力表；`vue` 显式映射为 `other`。 */
function languageOf(path: string): SymbolInfo["language"] {
  const language = languageOfExtension(extname(path));
  if (!language || language === "vue") return "other";
  return language as SymbolInfo["language"];
}

export type SyntaxNode = NonNullable<ReturnType<Parser["parse"]>>["rootNode"];

/** 解析并交出语法树，遍历完立即 `tree.delete()`（WASM 堆内存，GC 收不掉）。 */
export function withSyntaxTrees<T>(path: string, content: string, visit: (root: SyntaxNode, grammar: GrammarName) => T): T[] | undefined {
  if (!parser) return undefined;
  if (path.endsWith(".vue")) {
    const blocks = vueScriptBlocks(content);
    if (!blocks.length) return [];
    const out: T[] = [];
    for (const block of blocks) {
      const tree = parse(block.ts ? "tsx" : "javascript", padVueBlock(content, block));
      if (!tree) return undefined;
      out.push(visit(tree.rootNode, block.ts ? "tsx" : "javascript"));
      tree.delete();
    }
    return out;
  }
  const grammar = grammarOf(path);
  if (!grammar) return undefined;
  const tree = parse(grammar, content);
  if (!tree) return undefined;
  const result = visit(tree.rootNode, grammar);
  tree.delete();
  return [result];
}

function parse(grammar: GrammarName, source: string): Tree | undefined {
  const language = grammars.get(grammar);
  if (!parser || !language) return undefined;
  parser.setLanguage(language);
  return parser.parse(source) ?? undefined;
}

let loading: Promise<ParseBackendStatus> | undefined;
let status: ParseBackendStatus = { backend: "regex", reason: "语法解析器尚未加载" };
const grammars = new Map<GrammarName, Language>();
let parser: Parser | undefined;

export function parseBackendStatus(): ParseBackendStatus {
  return status;
}

/** 加载解析器与语法文件（幂等）；必须在建图前 await 一次。 */
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
      traceEngine("degrade", { component: "parser", reason }, { traceId: null });
    }
    return status;
  })();
  return loading;
}

/** 仅测试用：复位解析器状态。 */
export function resetSymbolParserForTest(): void {
  loading = undefined;
  grammars.clear();
  parser = undefined;
  status = { backend: "regex", reason: "语法解析器尚未加载" };
}

const TS_FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration"]);
const TS_CLASS_NODES = new Set(["class_declaration", "abstract_class_declaration", "record_declaration"]);
/** 接口/类型别名/枚举：非可执行体，仍作为符号收录。 */
const TS_TYPE_NODES = new Set(["interface_declaration", "type_alias_declaration", "enum_declaration"]);
const TS_VARIABLE_NODES = new Set(["lexical_declaration", "variable_declaration"]);
const TS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function"]);

/** 声明节点类型到 kind 的映射，认不出来返回 undefined。 */
function kindOf(type: string, inClass: boolean): SymbolInfo["kind"] | undefined {
  if (TS_FUNCTION_NODES.has(type)) return "function";
  if (TS_CLASS_NODES.has(type)) return "class";
  // Java：方法与构造器是 Java 独有的节点类型
  if (type === "method_declaration" || type === "constructor_declaration") return "method";
  if (type === "method_definition") return "method";
  if (TS_TYPE_NODES.has(type)) return "type";
  if (type === "class_definition") return "class";
  if (type === "function_definition") return inClass ? "method" : "function";
  // Go：type_declaration 的名字在 type_spec 里，由 collectSymbols 展开
  if (type === "struct_declaration") return "class";
  // Rust：impl 无名，体成员由递归收进来并升为 method
  if (type === "function_item") return inClass ? "method" : "function";
  if (type === "struct_item" || type === "union_item") return "class";
  if (type === "trait_item" || type === "enum_item" || type === "mod_item") return "type";
  if (type === "class_specifier" || type === "struct_specifier") return "class";
  if (type === "enum_specifier") return "type";
  return undefined;
}

/** C 系 function_definition 无 name 字段，名字在 declarator 链末端。 */
function declaratorName(node: SyntaxNode): string | undefined {
  // C 用 identifier，C++ 另有 qualified_identifier、destructor_name 变体
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

/** 进入这些节点后，体内的函数定义算成员方法。 */
const CONTAINER_BODIES = new Set<string>([...TS_CLASS_NODES, "class_definition", "class", "class_specifier", "struct_specifier", "impl_item", "trait_item"]);

/** 参数原文：具名子节点文本原样保留，含类型标注与默认值。 */
function parameterTexts(node: SyntaxNode): string[] {
  const list = node.childForFieldName("parameters");
  if (!list) return [];
  return list.namedChildren.map((child) => child.text.trim()).filter(Boolean);
}

/** TS 的 `export_statement` 与 Python 的 `decorated_definition` 是外壳，声明在内层。 */
function unwrap(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === "export_statement") return node.childForFieldName("declaration") ?? undefined;
  if (node.type === "decorated_definition") return node.childForFieldName("definition") ?? undefined;
  return undefined;
}

/** 声明节点的名字：优先 `name` 字段，缺失则沿 declarator 链查找。 */
export function declarationNameOf(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text.trim() || declaratorName(node);
}

function symbolOf(node: SyntaxNode, path: string, kind: SymbolInfo["kind"]): SymbolInfo | undefined {
  const name = declarationNameOf(node);
  if (!name) return undefined;
  const line = node.startPosition.row + 1;
  return {
    // id 格式是持久化契约，调用边按 calleeSymbol 引用
    id: `symbol:${path}:${name}:${line}`,
    name,
    kind,
    path,
    line,
    // tree-sitter 的 endPosition 落在最后一行（含）
    endLine: node.endPosition.row + 1,
    parameters: parameterTexts(node),
    language: languageOf(path)
  };
}

/** 变量声明指向的函数或类表达式也算符号。 */
function collectVariableDeclarators(node: SyntaxNode, path: string, out: SymbolInfo[]): void {
  for (const declarator of node.namedChildren) {
    if (declarator.type !== "variable_declarator") continue;
    const value = declarator.childForFieldName("value");
    if (!value) continue;
    const kind: SymbolInfo["kind"] | undefined = TS_FUNCTION_VALUES.has(value.type) ? "function" : value.type === "class" ? "class" : undefined;
    if (!kind) continue;
    const name = declarator.childForFieldName("name")?.text.trim();
    if (!name) continue;
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
  // Go 的 type_declaration 是外壳，名字在各自的 type_spec 里
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
  // 进入类体后，Python 的 def、Rust 的 fn、C/C++ 成员函数算方法
  const childInClass = inClass || CONTAINER_BODIES.has(node.type);
  for (const child of node.namedChildren) collectSymbols(child, path, childInClass, out);
}

/** Vue SFC 无专属语法：`<script>` 块按 tsx/js 解析，块外行以空行占位保持行号。 */
function vueScriptBlocks(content: string): { start: number; end: number; ts: boolean }[] {
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
  return blocks;
}

/** 垫 `start - 1` 个空行，`join("\n")` 补齐后块内首行落在原文件行号。 */
function padVueBlock(content: string, block: { start: number; end: number }): string {
  const lines = content.split("\n");
  return ["\n".repeat(Math.max(0, block.start - 1)), ...lines.slice(block.start, block.end), "\n".repeat(lines.length - block.end)].join("\n");
}

/** 跨行模板字符串占用的行号；解析器未就绪或该语言无语法时返回 undefined。 */
export function extractMultilineTemplateLines(path: string, content: string): Set<number> | undefined {
  const lines = new Set<number>();
  const found = withSyntaxTrees(path, content, (root) => {
    // 模板串节点是 `template_string`，普通引号串为单行
    const walk = (node: SyntaxNode): void => {
      if (node.type === "template_string" && node.startPosition.row !== node.endPosition.row) {
        for (let line = node.startPosition.row + 1; line <= node.endPosition.row; line += 1) lines.add(line);
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(root);
  });
  return found ? lines : undefined;
}

/** 语法树抽符号；未就绪或该扩展名无语法时返回 undefined，空数组表示文件确无符号。 */
export function extractSymbolsFromAst(path: string, content: string): SymbolInfo[] | undefined {
  const perTree = withSyntaxTrees(path, content, (root) => {
    const symbols: SymbolInfo[] = [];
    collectSymbols(root, path, false, symbols);
    return symbols;
  });
  return perTree?.flat();
}

