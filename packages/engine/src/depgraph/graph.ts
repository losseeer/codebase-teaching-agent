import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, normalize } from "node:path";
import type { CallEdge, DependencyGraphData, FileEntry, ImpactResult, SourceAnchor, SymbolInfo, TypeDispatchEdge } from "@codebase-tutor/shared";
import { extractSymbolsFromAst, parseBackendStatus, type ParseBackendStatus } from "./parser.js";
import { isTestPath } from "./roles.js";

export interface DependencyGraph {
  imports: Map<string, string[]>;
  calls: CallEdge[];
  /** 类型派发边（Java/C# 的 extends/implements 落点）；详见 shared 的 `TypeDispatchEdge` 注释。 */
  dispatch: TypeDispatchEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: DependencyGraphData["lspStatus"];
  /** 符号抽取走的哪条路（`ast` 准确 / `regex` 回落）；回落原因见 `parseBackendReason`。 */
  parseBackend: ParseBackendStatus["backend"];
  parseBackendReason?: string;
}

const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".vue"];
/** C/C++ 一族的扩展名（cpp 语法同时覆盖纯 C）。 */
const cppExtensionPattern = /\.(c|h|cc|cpp|cxx|hpp|hh)$/;
const ignoredCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "require", "import"]);
/** TS/JS 的说明符一律带引号；Python 与 Java 的 import 没有引号，各走 extractPythonSpecifiers / extractJavaSpecifiers。 */
const tsSpecifierPattern = /(?:from\s+|import\s*\(?\s*|require\s*\()\s*["']([^"']+)["']/g;

/**
 * Produces an import graph plus project-local call graph. The static analyzer is
 * deliberately complete enough for the fallback path; LSP availability is surfaced
 * separately so callers never mistake a degraded result for semantic certainty.
 */
export function buildDependencyGraph(repositoryPath: string, files: FileEntry[]): DependencyGraph {
  const available = new Set(files.map((file) => file.path));
  const packages = collectWorkspacePackages(repositoryPath, files);
  const symbols: SymbolInfo[] = [];
  const contents = new Map<string, string>();
  for (const file of files) {
    if (!extensions.includes(file.extension)) continue;
    const content = readFileSync(join(repositoryPath, file.path), "utf8");
    contents.set(file.path, content);
    symbols.push(...extractSymbols(file.path, content));
  }
  // Java 的 import 指向「全限定类名」、Go 的 import 指向「包目录」、C# 的 using 指向「命名空间」，
  // 都要先建全仓索引才能落点，故内容先读全再解析依赖
  const javaTypes = collectJavaTypes(contents);
  const goModules = collectGoModules(repositoryPath, files);
  const goFilesByDir = collectGoFiles(files);
  const csNamespaces = collectCSharpNamespaces(contents);
  const aliases = collectPathAliases(repositoryPath);
  const imports = new Map<string, string[]>();
  for (const [path, content] of contents) {
    imports.set(path, resolveFileImports(path, content, { available, packages, javaTypes, goModules, goFilesByDir, csNamespaces, aliases }));
  }
  const calls = extractCalls(contents, symbols, imports, javaTypes);
  const dispatch: TypeDispatchEdge[] = [];
  for (const [path, content] of contents) {
    if (path.endsWith(".java")) dispatch.push(...extractJavaDispatch(path, content, javaTypes));
  }
  const lspStatus = detectLspStatus(files);
  const parseStatus = parseBackendStatus();
  return {
    imports,
    calls,
    dispatch,
    symbols,
    entrypoints: detectEntrypoints(repositoryPath, files, contents),
    semanticBackend: lspStatus.some((item) => item.status === "available") ? "lsp" : "static",
    lspStatus,
    parseBackend: parseStatus.backend,
    ...(parseStatus.reason ? { parseBackendReason: parseStatus.reason } : {})
  };
}

export function serializeGraph(graph: DependencyGraph): DependencyGraphData {
  return {
    imports: Object.fromEntries([...graph.imports.entries()]),
    calls: graph.calls,
    dispatch: graph.dispatch,
    symbols: graph.symbols,
    entrypoints: graph.entrypoints,
    semanticBackend: graph.semanticBackend,
    lspStatus: graph.lspStatus,
    parseBackend: graph.parseBackend,
    ...(graph.parseBackendReason ? { parseBackendReason: graph.parseBackendReason } : {})
  };
}

export function impactRadius(graph: DependencyGraph, changedPaths: string[]): ImpactResult {
  const reverse = new Map<string, { from: string; kind: "import" | "call" }[]>();
  for (const [from, targets] of graph.imports) {
    for (const to of targets) reverse.set(to, [...(reverse.get(to) ?? []), { from, kind: "import" }]);
  }
  for (const call of graph.calls) {
    reverse.set(call.calleePath, [...(reverse.get(call.calleePath) ?? []), { from: call.callerPath, kind: "call" }]);
  }
  const impacted = new Set(changedPaths);
  const pending = [...changedPaths];
  const edges: ImpactResult["edges"] = [];
  while (pending.length) {
    const target = pending.shift()!;
    for (const edge of reverse.get(target) ?? []) {
      edges.push({ from: edge.from, to: target, kind: edge.kind });
      if (!impacted.has(edge.from)) {
        impacted.add(edge.from);
        pending.push(edge.from);
      }
    }
  }
  return { changedPaths, impactedPaths: [...impacted].sort(), edges };
}

export function graphFromData(data: DependencyGraphData): DependencyGraph {
  return {
    imports: new Map(Object.entries(data.imports)),
    calls: data.calls,
    // 旧产物的图里没有这一类关系（那时只有 import 与 call 两条路），按空表处理，别硬造
    dispatch: data.dispatch ?? [],
    symbols: data.symbols,
    entrypoints: data.entrypoints,
    semanticBackend: data.semanticBackend,
    lspStatus: data.lspStatus,
    // 旧数据没有该字段（那时只有逐行匹配一条路），按 regex 认，别假装是语法树结果
    parseBackend: data.parseBackend ?? "regex",
    ...(data.parseBackendReason ? { parseBackendReason: data.parseBackendReason } : {})
  };
}

/**
  符号抽取：优先语法树；解析器未就绪或该扩展名没有语法时回落逐行匹配。
  两条路都给同一份 `SymbolInfo` 结构，`endLine` 都是「最后一行（含）」。
*/
function extractSymbols(path: string, content: string): SymbolInfo[] {
  return extractSymbolsFromAst(path, content) ?? extractSymbolsWithRegex(path, content);
}

function extractSymbolsWithRegex(path: string, content: string): SymbolInfo[] {
  const language = path.endsWith(".py") ? "python" : /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) ? "typescript" : "other";
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = language === "python"
      ? line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/)
      : line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>|^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (!match) continue;
    const name = match[1] ?? match[3] ?? match[5];
    const rawParameters = match[2] ?? match[4] ?? "";
    const kind: SymbolInfo["kind"] = match[5] ? "class" : "function";
    symbols.push({ id: `symbol:${path}:${name}:${index + 1}`, name, kind, path, line: index + 1, endLine: findEndLine(lines, index, language), parameters: rawParameters.split(",").map((value) => value.trim()).filter(Boolean), language });
  }
  return symbols;
}

function findEndLine(lines: string[], start: number, language: SymbolInfo["language"]): number {
  if (language === "python") {
    const indentation = lines[start].match(/^\s*/)?.[0].length ?? 0;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index].trim() && (lines[index].match(/^\s*/)?.[0].length ?? 0) <= indentation) return index;
    }
    return lines.length;
  }
  let balance = 0;
  for (let index = start; index < Math.min(lines.length, start + 200); index += 1) {
    balance += (lines[index].match(/{/g) ?? []).length - (lines[index].match(/}/g) ?? []).length;
    if (index > start && balance <= 0) return index + 1;
  }
  return Math.min(lines.length, start + 1);
}

/**
  Java 的「接收者类型名 → 仓内文件」可见表：`import` 带进来的（含通配）加上**同包**——
  Java 里同包的类不需要 import 就能用，这一路引擎原先完全没有（10-05 的符号级参照实测：
  dianping 漏 5 条、Xingyan 漏 6 条，全部是同包调用）。

  同源码根才算可见（`src/main` 与 `src/test` 是两个编译范围）：主源码看不见测试源码里的类，
  这条收窄是在参考档踩过一次「测试类被当成主源码可 import 的目标」之后补的。
*/
function javaVisibleTypes(path: string, content: string, javaTypes: Map<string, string>): Map<string, string> {
  const packagePart = (fqn: string): string => fqn.slice(0, fqn.lastIndexOf("."));
  const ownPackage = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/m.exec(content)?.[1];
  const ownRoot = javaSourceRootOf(path);
  const visible = new Map<string, string>();
  /**
    `sameRootOnly` 只对「靠包名猜」的两条路成立（通配 import、同包可见）：多模块仓里
    `sl-common/src/main/java/com/x/util` 与 `sl-jump/src/main/java/com/x/util` 是**两个不同的编译单元**，
    按包名把它们互相可见就会连出假边。而**显式 import 是确定的**，跨模块也照收——把它一起收窄会误伤
    （10-05 实测：Xingyan 的跨文件调用边一度从 136 掉到 125，就是因为测试根与跨模块的显式 import 被误挡）。
    */
  const add = (target: string | undefined, requireSameRoot: boolean): void => {
    if (!target || target === path) return;
    if (requireSameRoot && javaSourceRootOf(target) !== ownRoot) return;
    visible.set(basename(target, ".java"), target);
  };
  for (const item of extractJavaSpecifiers(content)) {
    if (item.wildcard) {
      for (const [fqn, target] of javaTypes) if (packagePart(fqn) === item.specifier) add(target, true);
      continue;
    }
    add(resolveJavaImport(item.specifier, javaTypes), false);
  }
  if (ownPackage) for (const [fqn, target] of javaTypes) if (packagePart(fqn) === ownPackage) add(target, true);
  return visible;
}

/**
  注释按等长空格抹掉、import 整行抹掉，**行数与字符偏移都不变**：
  类声明可能出现在 javadoc 的示例里，注释里的 `implements` 不是证据，但行号还得对得上原文。
*/
function stripJavaNoise(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length))
    .replace(/^[ \t]*import[ \t][^\n]*$/gm, (line) => " ".repeat(line.length));
}

/** 反复剥掉最内层尖括号：`Map<String, Order>` 与 `<T extends Base>` 里的名字都不是父类型。 */
function stripJavaGenerics(head: string): string {
  let previous = head;
  for (;;) {
    const next = previous.replace(/<[^<>]*>/g, " ");
    if (next === previous) return next;
    previous = next;
  }
}

/**
  Java 类头里的 `extends` / `implements` 落点：这是「接口与实现」唯一的静态证据。

  为什么值得单独建一类边：Spring 的控制器注入的是**接口**，实现类在源码里没有任何调用行，
  import 边走到接口就断，于是 service/impl 与它下面的 mapper 整片在图上失联
  （2026-10-05 实测 dianping：45 个 Controller/Service/Mapper 文件里 30 个从任何入口都走不到）。
  落点复用 `javaVisibleTypes`：接口要么显式 import、要么同包，Java 没有第三种可能，所以这条判据不缺证据。
  代价照实说：同名类型（多个模块各有一个 `IUserService`）可能指错，所以它是 A1 级近似证据。
*/
function extractJavaDispatch(path: string, content: string, javaTypes: Map<string, string>): TypeDispatchEdge[] {
  const visible = javaVisibleTypes(path, content, javaTypes);
  const body = stripJavaNoise(content);
  const edges: TypeDispatchEdge[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)([^{;]*)/g)) {
    const head = stripJavaGenerics(match[2] ?? "");
    const implementsAt = /\bimplements\b/.exec(head);
    const extendsAt = /\bextends\b/.exec(head);
    const line = body.slice(0, match.index ?? 0).split("\n").length;
    const clauses: { kind: TypeDispatchEdge["kind"]; text: string }[] = [];
    if (extendsAt) {
      const from = extendsAt.index + "extends".length;
      const to = implementsAt && implementsAt.index > extendsAt.index ? implementsAt.index : head.length;
      clauses.push({ kind: "extends", text: head.slice(from, to) });
    }
    if (implementsAt) clauses.push({ kind: "implements", text: head.slice(implementsAt.index + "implements".length) });
    for (const clause of clauses) {
      for (const raw of clause.text.split(",")) {
        const name = raw.trim();
        if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) continue;
        const simple = name.split(".").pop()!;
        if (simple === match[1]) continue;
        const target = (name.includes(".") ? resolveJavaImport(name, javaTypes) : undefined) ?? visible.get(simple);
        if (!target || target === path) continue;
        const key = `${clause.kind}:${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ subtypePath: path, supertypePath: target, kind: clause.kind, line });
      }
    }
  }
  return edges;
}

/**
  接收者名 → 它可能有的声明类型（一个名字可以有多个）：字段、方法参数、局部变量三种声明形状。
  `private final OrderMapper mapper`、`void write(ErrorCode errorCode)`、`StringBuilder sb = new ...`。

  为什么值得解到这个程度：Spring 代码里的调用几乎全是 `service.query(...)` 这种**小写变量接收者**，
  只认类名接收者就等于看不见它们；而 10-06 实测「只解字段」会让 Xingyan 丢掉 `errorCode.getMessage()`
  这类经方法参数进来的真边，所以三类声明一起解才算完整。
  为什么一个名字要留多个类型：同一个变量名在不同方法里声明成不同类型是真事
  （dianping 的 `status` 既可能是 `OrderStatus` 也可能是 `PayType`），只留最后一个会凭空丢边。
  解不出类型的接收者照旧走裸名匹配（`this.foo()`、链式中间段都不挡）。
*/
function javaReceiverTypes(content: string): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  const patterns = [
    // 字段：访问修饰符开头，名字后面跟 `=` 或 `;`（`(` 是方法声明，不能算字段）
    /^\s*(?:private|protected|public)\s+(?:static\s+|final\s+|transient\s+|volatile\s+)*([A-Z]\w*)(?:<[^>]*>)?\s+([a-z_]\w*)\s*[=;]/gm,
    // 方法参数：括号与逗号之间「类型 名字」
    /[(,]\s*([A-Z]\w*)(?:<[^>]*>)?\s+([a-z_]\w*)\s*[,)]/g,
    // 局部变量声明：行首是类型 + 名字 + `=`
    /^\s*(?:final\s+)?([A-Z]\w*)(?:<[^>]*>)?\s+([a-z_]\w*)\s*=/gm
  ];
  const add = (name: string, type: string): void => {
    const list = declared.get(name) ?? [];
    if (!list.includes(type)) list.push(type);
    declared.set(name, list);
  };
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) add(match[2], match[1]);
  }
  return declared;
}

function extractCalls(contents: Map<string, string>, symbols: SymbolInfo[], imports: Map<string, string[]>, javaTypes: Map<string, string>): CallEdge[] {
  const byName = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol]);
  const edges: CallEdge[] = [];
  for (const [path, content] of contents) {
    const localSymbols = symbols.filter((symbol) => symbol.path === path);
    const imported = new Set(imports.get(path) ?? []);
    // 只有 Java 走接收者判定：这门语言有「类名=文件名」的强约定，而且符号级参照也只覆盖了它
    const isJava = path.endsWith(".java");
    /**
      Java 的调用扫描读「抹掉注释与 import 行」的正文：注释里的 `voucherOrderService.handle(orderId)`
      是一句说明，不是调用证据（2026-10-06 复审在 dianping 实测到 16 条跨文件调用边的落点行就是注释，
      `PaymentServiceImpl` 的 javadoc 流程图甚至给 `PayLog` 连了三条）。
      `stripJavaNoise` 用等长空格替换，所以行号与原文一一对应。
      其他语言的注释（`#`、`--`）暂不抹：符号级参照只覆盖了 Java，改动无法用参照校验，宁缺毋滥。
    */
    const body = isJava ? stripJavaNoise(content) : content;
    const receivers = isJava ? javaVisibleTypes(path, content, javaTypes) : undefined;
    const declaredTypes = receivers ? javaReceiverTypes(body) : undefined;
    const lines = body.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:const|let|var)\b.*=>|^\s*(?:async\s+)?def\b|^\s*func\b|^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:unsafe\s+)?(?:async\s+)?fn\b/.test(line)) continue;
      // Java 方法/构造器声明行也含「名字(」——不跳过会产生自我调用边
      if (/^\s*(?:@\w+\s*)?(?:(?:public|private|protected|static|final|abstract|synchronized|default|native)\s+)+[\w<>\[\],.?\s]+\(/.test(line)) continue;
      for (const match of line.matchAll(/\b(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        const receiver = match[1];
        const name = match[2];
        if (ignoredCalls.has(name)) continue;
        const candidates = byName.get(name) ?? [];
        let target: SymbolInfo | undefined;
        // 接收者先换成声明类型：大写的本身就是类型；小写的要靠字段 / 参数 / 局部变量声明换
        // （`mapper.insert(` → `OrderMapper`）。换不出就走裸名老路，`this.foo()` 与链式中间段都不挡。
        const receiverTypes = receiver ? (/^[A-Z]/.test(receiver) ? [receiver] : declaredTypes?.get(receiver)) : undefined;
        const typedTargets: SymbolInfo[] = [];
        if (receivers && receiverTypes?.length) {
          // 接收者是仓内可见类型 ⇒ 只认它声明的那个方法。找不到就**不退回裸名匹配**：
          // 继承来的方法会因此漏一条，但把「另一个文件里撞名的方法」当成调用落点是更坏的结果
          const typedFiles = new Set(receiverTypes.map((type) => receivers.get(type)).filter((file): file is string => Boolean(file)));
          typedTargets.push(...candidates.filter((symbol) => typedFiles.has(symbol.path)));
          if (!typedTargets.length) continue;
          target = typedTargets[0];
        } else {
          target = candidates.find((symbol) => symbol.path === path) ?? candidates.find((symbol) => imported.has(symbol.path));
        }
        if (!target) continue;
        const caller = [...localSymbols].reverse().find((symbol) => symbol.line <= index + 1 && symbol.endLine >= index + 1);
        for (const callee of (typedTargets.length ? typedTargets : [target])) {
          edges.push({ callerPath: path, callerSymbol: caller?.id, calleePath: callee.path, calleeSymbol: callee.id, line: index + 1 });
        }
      }
    }
  }
  return dedupeCalls(edges);
}

function dedupeCalls(calls: CallEdge[]): CallEdge[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.callerPath}:${call.callerSymbol ?? ""}:${call.calleePath}:${call.calleeSymbol ?? ""}:${call.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Python 的 import 语句不带引号、模块名用点号分隔，需要单独提取：
 * `import a.b as c`、`import a, b`、`from a.b import c`、`from . import c`（相对包）。
 * 第三方模块（fastapi、langgraph）也会被提取出来，最终由 resolvePythonImport 按「仓库内是否存在」过滤。
 */
function extractPythonSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.*)$/);
    if (fromMatch) {
      const module = fromMatch[1];
      specifiers.push(module);
      // `from a.b import c` 里的 c 可能是子模块，也可能是符号名 —— 两种都给出，交由可用性判定
      for (const name of readImportedNames(fromMatch[2])) specifiers.push(module.endsWith(".") ? `${module}${name}` : `${module}.${name}`);
      continue;
    }
    const importMatch = trimmed.match(/^import\s+(.*)$/);
    if (importMatch) specifiers.push(...readImportedNames(importMatch[1]));
  }
  return specifiers;
}

/** 从 `a, b.c as d` 里取出模块名（剥掉别名、括号与行尾注释）。 */
function readImportedNames(raw: string): string[] {
  return raw
    .split("#")[0]
    .split(",")
    .map((item) => item.split(/\s+as\s+/)[0].replace(/^\(+/, "").replace(/\)+$/, "").trim())
    .filter((item) => /^[A-Za-z_][\w.]*$/.test(item));
}

/**
 * Java 的 import 语句：`import com.a.B;`、`import static com.a.B.C;`、`import com.a.*;`。
 * 通配符要**留痕**（`wildcard`），因为它落不到具体类：`.*` 剥掉后剩下的是包名，
 * 包名在 `javaTypes` 里没有条目，逐级上溯也落不到——10-05 的 A1 差值实测：
 * dianping 一处 `import com.hmdp.utils.*;` 原本产生**零条边**，连带 13 个 utils 类被误判成孤立文件。
 */
function extractJavaSpecifiers(content: string): { specifier: string; wildcard: boolean }[] {
  const specifiers: { specifier: string; wildcard: boolean }[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^import\s+(?:static\s+)?([A-Za-z_]\w*(?:\.\w+)*)(\.\*)?\s*;/);
    if (match) specifiers.push({ specifier: match[1], wildcard: Boolean(match[2]) });
  }
  return specifiers;
}

/**
  Java 的源码根：`src/main` 与 `src/test`（Maven/Gradle 布局）是两个编译范围，主源码看不见测试源码里的类。
  这条收窄是在参考档踩过「测试类被当成主源码可 import 的目标、凭空造出十条假边」之后补的，
  通配展开与接收者可见表共用它，两处口径必须一致，否则文件级边和调用级边会互相打脸。
*/
function javaSourceRootOf(path: string): string {
  const match = /(^|\/)src\/(main|test)\//.exec(path);
  return match ? `${path.slice(0, match.index)}src/${match[2]}` : path;
}

/**
  通配 import 的落点：只认「这个包里的类名**真的出现在正文里**」的那些。

  为什么不整包展开：`com.hmdp.utils.*` 覆盖十几个类，而一个文件通常只用其中三四个；
  全量入图等于给同一包内的每对文件都连一条边——影响范围会虚胖、流程证据会被无关文件挤掉。
  判据用「标识符集合包含」而不是逐个正则：一次分词就能判完整个包，且天然带词边界（`Keys` 不会被 `Keys2` 蒙对）。
  代价也要如实说：注释里提过的类名会被算进来，所以这类边的强度低于直接 import——它是 A1 实测出来的缺口回补，不是新的权威证据。
  */
function expandJavaWildcard(caller: string, pkg: string, body: string, javaTypes: Map<string, string>): string[] {
  const identifiers = new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const callerRoot = javaSourceRootOf(caller);
  const targets: string[] = [];
  for (const [fqn, path] of javaTypes) {
    const dot = fqn.lastIndexOf(".");
    if (dot < 0 || fqn.slice(0, dot) !== pkg) continue;
    if (javaSourceRootOf(path) !== callerRoot) continue;
    if (!identifiers.has(fqn.slice(dot + 1))) continue;
    targets.push(path);
  }
  return targets;
}

/** 去掉 import 行，只留正文：否则 `import com.a.*;` 与相邻的直接导入会把包名/类名自己喂成命中。 */
const javaBodyOf = (content: string): string => content.replace(/^[ \t]*import[ \t][^\n]*$/gm, "");

/** 全仓「全限定类名 → 文件路径」索引：Java 靠 package 声明 + 文件名（public 类名=文件名约定）建这个映射。 */
function collectJavaTypes(contents: Map<string, string>): Map<string, string> {
  const types = new Map<string, string>();
  for (const [path, content] of contents) {
    if (!path.endsWith(".java")) continue;
    const pkg = content.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m)?.[1];
    if (pkg) types.set(`${pkg}.${basename(path, ".java")}`, path);
  }
  return types;
}

/**
 * 类名精确命中即返回；未命中逐段去掉尾部再试——覆盖静态导入（`a.b.C.member`）与嵌套类（`a.b.C.D`）。
 * 外部依赖（org.springframework、java.util）不会进索引，天然被过滤。
 */
function resolveJavaImport(specifier: string, javaTypes: Map<string, string>): string | undefined {
  let current = specifier;
  for (;;) {
    const hit = javaTypes.get(current);
    if (hit) return hit;
    const cut = current.lastIndexOf(".");
    if (cut < 0) return undefined;
    current = current.slice(0, cut);
  }
}

/** join/normalize 的结果统一成仓库口径的正斜杠路径（win32 下返回反斜杠）。 */
function slash(candidate: string): string {
  return candidate.replaceAll("\\", "/");
}

interface ImportIndex {
  available: Set<string>;
  packages: Map<string, WorkspacePackage>;
  javaTypes: Map<string, string>;
  goModules: Map<string, string>;
  goFilesByDir: Map<string, string[]>;
  csNamespaces: Map<string, string[]>;
  aliases: PathAlias[];
}

/** 按语言分派「提取说明符 → 落点」。落不了的（stdlib/第三方/系统头）一律丢弃，图里只留仓内依赖。 */
function resolveFileImports(path: string, content: string, index: ImportIndex): string[] {
  const dedupe = (values: Iterable<string>): string[] => [...new Set(values)];
  const kept = (values: (string | undefined)[]): string[] => dedupe(values.filter((value): value is string => Boolean(value)));
  if (path.endsWith(".py")) return kept(extractPythonSpecifiers(content).map((value) => resolvePythonImport(path, value, index.available)));
  if (path.endsWith(".java")) {
    const body = javaBodyOf(content);
    const resolved: (string | undefined)[] = [];
    for (const item of extractJavaSpecifiers(content)) {
      if (item.wildcard) resolved.push(...expandJavaWildcard(path, item.specifier, body, index.javaTypes));
      else resolved.push(resolveJavaImport(item.specifier, index.javaTypes));
    }
    return kept(resolved).filter((value) => value !== path);
  }
  if (path.endsWith(".go")) return dedupe(extractGoSpecifiers(content).flatMap((value) => resolveGoImport(value, index.goModules, index.goFilesByDir)));
  if (path.endsWith(".rs")) return kept(extractRustSpecifiers(content).map((value) => resolveRustImport(path, value, index.available)));
  if (path.endsWith(".cs")) return kept(extractCSharpSpecifiers(content).flatMap((value) => resolveCSharpImport(value, index.csNamespaces)).filter((value) => value !== path));
  if (cppExtensionPattern.test(path)) return dedupe(extractCppIncludes(content).flatMap((value) => resolveCppInclude(path, value, index.available)).filter((value) => value !== path));
  return kept([...content.matchAll(tsSpecifierPattern)].map((match) => resolveImport(path, match[1], index.available, index.packages, index.aliases)));
}

/**
 * Go 的 import 路径指向「包」（目录）而非文件：go.mod 的 `module X` 前缀决定仓内边界，
 * 命中后落点为该目录下全部非测试 .go —— 依赖粒度本来就是整个包。
 */
function collectGoModules(repositoryPath: string, files: FileEntry[]): Map<string, string> {
  const modules = new Map<string, string>();
  for (const file of files) {
    if (basename(file.path) !== "go.mod") continue;
    try {
      const match = readFileSync(join(repositoryPath, file.path), "utf8").match(/^module\s+(\S+)/m);
      if (match) modules.set(match[1], dirname(file.path));
    } catch { /* A malformed go.mod is not fatal to import. */ }
  }
  return modules;
}

function collectGoFiles(files: FileEntry[]): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    if (file.extension !== ".go" || file.path.endsWith("_test.go")) continue;
    const dir = dirname(file.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), file.path]);
  }
  return byDir;
}

/** Go 的 import 两种形态：`import "x"`（可带别名）与 `import ( … )` 分组块。 */
function extractGoSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let inBlock = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!inBlock) {
      const single = trimmed.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"$/);
      if (single) specifiers.push(single[1]);
      if (/^import\s*\($/.test(trimmed)) inBlock = true;
      continue;
    }
    if (trimmed === ")") {
      inBlock = false;
      continue;
    }
    const item = trimmed.match(/^(?:[\w.]+\s+)?"([^"]+)"$/);
    if (item) specifiers.push(item[1]);
  }
  return specifiers;
}

function resolveGoImport(specifier: string, goModules: Map<string, string>, goFilesByDir: Map<string, string[]>): string[] {
  for (const [name, dir] of goModules) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const rest = specifier.slice(name.length).replace(/^\//, "");
    return goFilesByDir.get(slash(normalize(join(dir, rest)))) ?? [];
  }
  return [];
}

/**
 * Rust 的仓内依赖两种：`mod x;`（声明子模块，对应 x.rs 或 x/mod.rs）与 `use crate::a::b;`。
 * `use x::{c, d}` 取路径前缀即可；外部 crate（`use serde::…`）不经 crate/self/super 打头，天然不落点。
 */
function extractRustSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const modMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/);
    if (modMatch) specifiers.push(`mod:${modMatch[1]}`);
    const useMatch = trimmed.match(/^use\s+(crate|self|super)::([\w:]+)/);
    if (useMatch) specifiers.push(`use:${useMatch[1]}:${useMatch[2]}`);
  }
  return specifiers;
}

function resolveRustImport(from: string, specifier: string, available: Set<string>): string | undefined {
  const dir = dirname(from);
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    return [slash(join(dir, `${name}.rs`)), slash(join(dir, name, "mod.rs"))].find((candidate) => available.has(candidate));
  }
  const rest = specifier.slice(4); // `crate:a::b`
  const originEnd = rest.indexOf(":");
  const origin = rest.slice(0, originEnd);
  const chain = rest.slice(originEnd + 1).replace(/:$/, "").replaceAll("::", "/");
  const base = origin === "crate" ? "src" : origin === "self" ? dir : dirname(dir);
  let current = slash(normalize(join(base, chain)));
  for (;;) {
    const hit = [`${current}.rs`, `${current}/mod.rs`].find((candidate) => available.has(candidate));
    if (hit) return hit;
    const cut = current.lastIndexOf("/");
    if (cut <= 0) return undefined;
    current = current.slice(0, cut);
  }
}

/**
 * C# 的 `using A.B.C;` 指向命名空间而非文件：全仓建「命名空间 → 声明它的文件」索引
 * （块式与文件式 `namespace X;` 都收），逐级去尾命中后连到该命名空间下的全部文件。
 */
function extractCSharpSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^using\s+(?:static\s+)?(?:[\w]+\s*=\s*)?([A-Za-z_][\w.]*);/);
    if (match) specifiers.push(match[1]);
  }
  return specifiers;
}

function collectCSharpNamespaces(contents: Map<string, string>): Map<string, string[]> {
  const byNamespace = new Map<string, string[]>();
  for (const [path, content] of contents) {
    if (!path.endsWith(".cs")) continue;
    for (const match of content.matchAll(/^\s*namespace\s+([A-Za-z_][\w.]*)/gm)) {
      const list = byNamespace.get(match[1]) ?? [];
      if (!list.includes(path)) list.push(path);
      byNamespace.set(match[1], list);
    }
  }
  return byNamespace;
}

function resolveCSharpImport(specifier: string, namespaces: Map<string, string[]>): string[] {
  let current = specifier;
  for (;;) {
    const hit = namespaces.get(current);
    if (hit) return hit;
    const cut = current.lastIndexOf(".");
    if (cut < 0) return [];
    current = current.slice(0, cut);
  }
}

/** 只认 `#include "x.h"`（引号形，项目内头文件）；尖括号是系统/第三方头，直接不收。 */
function extractCppIncludes(content: string): string[] {
  return [...content.matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm)].map((match) => match[1]);
}

/** 先按当前文件相对解析（编译器首要规则）；未命中再按全仓路径后缀匹配——include 目录各异，多个命中就全连。 */
function resolveCppInclude(from: string, specifier: string, available: Set<string>): string[] {
  const relative = slash(normalize(join(dirname(from), specifier)));
  if (available.has(relative)) return [relative];
  const suffix = `/${specifier.replaceAll("\\", "/")}`;
  return [...available].filter((candidate) => candidate.endsWith(suffix) && candidate !== from);
}

interface WorkspacePackage {
  dir: string;
  main?: string;
}

/** tsconfig `paths` 的一条通配别名：`"@/*": ["src/*"]` → `{ prefix: "@/", dirs: ["src"] }`。 */
interface PathAlias {
  prefix: string;
  dirs: string[];
}

/** 去掉 JSON 里的注释与尾逗号：tsconfig 惯例是带注释的 JSONC，状态机走字符是为了不误伤字符串内的 `//`（如 `http://`）。 */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (char === "\\") { out += source[index + 1] ?? ""; index += 1; }
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === ",") {
      let ahead = index + 1;
      while (ahead < source.length && /\s/.test(source[ahead])) ahead += 1;
      if (source[ahead] === "}" || source[ahead] === "]") continue;
    }
    out += char;
  }
  return out;
}

/**
 * 仓库根 tsconfig 的 `compilerOptions.baseUrl + paths` → 别名前缀表（Vue/TS 项目 `@/x` 这类导入的唯一仓内依据）。
 * 只读根 tsconfig、只收通配条目（`"x/*"`）；exact 别名与 extends 继承的 paths 不在此列，解析不到就照旧丢弃。
 */
function collectPathAliases(repositoryPath: string): PathAlias[] {
  const manifest = join(repositoryPath, "tsconfig.json");
  if (!existsSync(manifest)) return [];
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(manifest, "utf8"))) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> } };
    const paths = raw.compilerOptions?.paths;
    if (!paths) return [];
    const base = typeof raw.compilerOptions?.baseUrl === "string" ? raw.compilerOptions.baseUrl : ".";
    const aliases: PathAlias[] = [];
    for (const [key, value] of Object.entries(paths)) {
      if (!key.endsWith("*") || !Array.isArray(value)) continue;
      const prefix = key.slice(0, -1);
      const dirs = (value as unknown[]).flatMap((item): string[] => (typeof item === "string" ? [slash(normalize(join(base, item.slice(0, -1))))] : []));
      if (prefix && dirs.length) aliases.push({ prefix, dirs });
    }
    return aliases;
  } catch { /* A malformed tsconfig is not fatal to import. */ }
  return [];
}

/** 收集仓库内各 package.json 的 name → 包目录/入口（monorepo 工作区包，供裸说明符解析）。 */
function collectWorkspacePackages(repositoryPath: string, files: FileEntry[]): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const file of files) {
    if (basename(file.path) !== "package.json") continue;
    try {
      const pkg = JSON.parse(readFileSync(join(repositoryPath, file.path), "utf8")) as { name?: string; main?: string };
      if (typeof pkg.name === "string" && pkg.name) {
        packages.set(pkg.name, { dir: dirname(file.path), main: typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") : undefined });
      }
    } catch { /* A malformed package file is not fatal to import. */ }
  }
  return packages;
}

/**
 * Python 模块名 → 仓库内文件：绝对导入从仓库根起算（`a.b.c` → `a/b/c.py` 或 `a/b/c/__init__.py`），
 * 相对导入以当前文件所在包为基准（`.` = 当前包，`..` 再上溯一层）。
 */
function resolvePythonImport(from: string, specifier: string, available: Set<string>): string | undefined {
  const level = specifier.match(/^\.+/)?.[0].length ?? 0;
  const relative = specifier.slice(level);
  let base = level > 0 ? dirname(from) : "";
  for (let index = 1; index < level; index += 1) base = dirname(base);
  const module = relative.replaceAll(".", "/");
  const target = [base, module].filter(Boolean).join("/");
  if (!target || target === ".") return undefined;
  return [`${target}.py`, `${target}/__init__.py`].find((candidate) => available.has(candidate));
}

function resolveImport(from: string, specifier: string, available: Set<string>, packages: Map<string, WorkspacePackage>, aliases: PathAlias[]): string | undefined {
  if (from.endsWith(".py")) return resolvePythonImport(from, specifier, available);
  const tryResolve = (candidate: string): string | undefined => {
    const normalized = normalize(candidate).replaceAll("\\", "/");
    const direct = [normalized];
    // TypeScript 的 NodeNext 约定：源码里写 .js/.mjs 等后缀，实际文件可能是 .ts/.tsx/.d.ts
    const extension = extname(normalized);
    if ([".js", ".mjs", ".cjs", ".jsx"].includes(extension)) {
      const stripped = normalized.slice(0, -extension.length);
      direct.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.d.ts`);
    }
    const possibilities = [...direct, ...extensions.map((item) => `${normalized}${item}`), ...extensions.map((item) => `${normalized}/index${item}`)];
    return possibilities.find((value) => available.has(value));
  };
  if (specifier.startsWith(".")) return tryResolve(join(dirname(from), specifier));
  // 裸说明符：只解析仓库内 package.json 声明的工作区包（外部依赖不入图）
  const matched = [...packages.entries()].find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
  if (matched) {
    const [name, pkg] = matched;
    if (specifier === name) {
      if (pkg.main) {
        const viaMain = tryResolve(join(pkg.dir, pkg.main));
        if (viaMain) return viaMain;
      }
      return tryResolve(join(pkg.dir, "src/index")) ?? tryResolve(join(pkg.dir, "index"));
    }
    return tryResolve(join(pkg.dir, specifier.slice(name.length + 1)));
  }
  // 工作区包没命中再试 tsconfig paths 别名（`@/stores/user` → `src/stores/user`）；仍未命中就丢弃
  const alias = aliases.find((item) => specifier.startsWith(item.prefix));
  if (!alias) return undefined;
  const rest = specifier.slice(alias.prefix.length);
  return alias.dirs.map((dir) => tryResolve(join(dir, rest))).find((hit) => hit !== undefined);
}

function detectEntrypoints(repositoryPath: string, files: FileEntry[], contents: Map<string, string>): SourceAnchor[] {
  // Spring 仓的入口只写在注解里，常规规则（package.json、惯用文件名）一条都碰不到；注解命中优先入列
  const java = detectJavaEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Go/Rust/C/C# 的 main 函数与 Java 注解同级：确定的启动点，不是文件名猜测
  const mains = detectMainFunctionEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Python 同理：框架约定（Flask/FastAPI/Django）与脚本守卫都是确定的启动点，命中即取代按文件名猜的那条
  const python = detectPythonEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  const authoritativePaths = new Set([...java, ...mains, ...python].map((anchor) => anchor.path));
  const candidates = new Map<string, string>();
  const manifest = join(repositoryPath, "package.json");
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { main?: string; bin?: string | Record<string, string>; scripts?: Record<string, string> };
      if (pkg.main) candidates.set(pkg.main.replace(/^\.\//, ""), "package main");
      const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
      bins.forEach((bin) => candidates.set(bin.replace(/^\.\//, ""), "CLI command"));
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        const match = command.match(/(?:tsx|node|vite|python)\s+([^\s]+)/);
        if (match) candidates.set(match[1].replace(/^\.\//, ""), `script: ${name}`);
      }
    } catch { /* A malformed package file is not fatal to import. */ }
  }
  for (const file of files) {
    const name = basename(file.path, extname(file.path)).toLowerCase();
    if (["main", "server", "app", "index", "cli", "manage"].includes(name)) candidates.set(file.path, "conventional entrypoint");
  }
  // 测试夹具里的 main.py / index.js 不是真入口（实测 fixture 仓的 package.json scripts 会指进去）——
  // 与结构角色用同一套测试路径判定，把这类候选剔除。
  // 注解命中的入口是权威清单（每一个都对应真实的路由/启动点），不能沿用弱启发式的 12 截断——
  // 实测 Spring 仓 15 个入口会在 12 处静默丢掉 UserController。给宽上限只为兜底极端仓。
  const conventional = [...candidates.entries()]
    .filter(([path]) => !isTestPath(path) && !authoritativePaths.has(path) && files.some((file) => file.path === path))
    .map(([path, label]) => ({ path, line: 1, label }));
  return [...java.slice(0, 60), ...mains.slice(0, 60), ...python.slice(0, 60), ...conventional.slice(0, 12)];
}

/**
 * Go/Rust/C/C# 的主函数约定：每个文件只取首个命中，锚点落在声明行。
 * 与 Java 注解同按「权威入口」对待——这是启动点的确定性证据，不是文件名猜测。
 */
function detectMainFunctionEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const rules: { extension: RegExp; pattern: RegExp; label: string }[] = [
    { extension: /\.go$/, pattern: /^[ \t]*func main\(\)/m, label: "Go 主函数" },
    { extension: /\.rs$/, pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?fn main\(\)/m, label: "Rust 主函数" },
    { extension: cppExtensionPattern, pattern: /^[ \t]*(?:signed\s+)?int main\s*\(/m, label: "C/C++ 主函数" },
    { extension: /\.cs$/, pattern: /^[ \t]*(?:(?:public|private|internal|protected|static|unsafe|partial|async)\s+)*(?:void|int|Task)\s+Main(?:Async)?\s*\(/m, label: "C# 主函数" }
  ];
  const anchors: SourceAnchor[] = [];
  for (const [path, content] of contents) {
    const rule = rules.find((item) => item.extension.test(path));
    if (!rule) continue;
    const match = content.match(rule.pattern);
    if (!match) continue;
    anchors.push({ path, line: content.slice(0, match.index ?? 0).split("\n").length, label: rule.label });
  }
  return anchors;
}

/**
 * Python 的入口证据写在框架约定里，文件名基本不带信息：真仓（agent2）靠 `main.py` 才碰巧命中约定名，
 * 而 FastAPI/Flask 的路由常拆在 api/、routers/ 下，Django 的 URL 表在 urls.py——一个都不叫 main/server。
 * 规则表按**证据强度**排序，且**一个文件只取最先命中的那条**（与 Spring「启动类优先于 @Controller」同口径）：
 * 真仓一个 main.py 挂着十几条路由装饰器，逐条标会把入口清单变成路由清单，
 * GUI 的入口下拉与课程树的「执行路径」都会被同一个文件的十几个候选挤满。
 * 误判比漏判更贵：只定义函数的库模块被标成入口后，流程证据从一条不会自己开始执行的链路铺起，
 * 课程树就把工具模块当执行起点讲——所以这里只认框架级语句，不认「看着像在启动进程」的形态
 * （`runner.run(...)`、裸 `main()` 一律不算证据）。
 * 刻意没写的几条：`app.add_url_rule` 命令式登记、Sanic/Starlette/aiohttp 的构造形态、`re_path`/`include`
 * 的二级路由表——test-fixtures/pyframeworkdemo-repo 里没有对应样例，**没有 fixture 就不写规则**。
 */
function detectPythonEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const rules: { pattern: RegExp; label: string }[] = [
    // 应用对象：文件里真的在构造服务实例，最强的启动证据
    { pattern: /^[ \t]*\w[\w.]*[ \t]*=[ \t]*(?:FastAPI|Flask)\s*\(/m, label: "HTTP 应用" },
    // Django 的路由表：每个请求都先过 urlpatterns，锚在表那一行而不是表里指向的某个视图
    { pattern: /^[ \t]*urlpatterns[ \t]*[=:]/m, label: "HTTP 路由表" },
    // 路由声明：挂在 app/router/蓝图对象上的 HTTP 动词装饰器。动词表按 Flask/FastAPI 的公开 API 收全——
    // 误报面是「某个库恰好也叫 `@x.get` 的模块级装饰器」，现实中用这批 HTTP 动词做装饰器的只有路由
    { pattern: /^[ \t]*@\w[\w.]*\.(?:route|get|post|put|patch|delete|head|options)[ \t(]/m, label: "HTTP 路由" },
    // 启动语句：app 在别的模块建、这个文件只负责把它跑起来（runner 那一类）。接收者只收 app 与 uvicorn 两个具名，
    // 不收 `\w+\.run(`——那会把 `self.runner.run()`、`db.run()` 这类普通调用全标成入口
    { pattern: /^[ \t]*(?:app\.run|uvicorn\.run)[ \t]*\(/m, label: "HTTP 服务启动" },
    // 脚本守卫：`python x.py` 真会跑起来的最朴素证据，普通脚本仓的入口全靠它
    { pattern: /^[ \t]*if[ \t]+__name__[ \t]+==[ \t]+["']__main__["'][ \t]*:/m, label: "脚本主入口" }
  ];
  const anchors: SourceAnchor[] = [];
  const taken = new Set<string>();
  const pythonFiles = [...contents].filter(([path]) => path.endsWith(".py"));
  // 外层按规则、内层按文件：证据强的先挑走文件，入口清单自然排在前面（真仓的默认入口取 entrypoints[0]，
  // 排序不是 cosmetics——把 app 对象排在脚本守卫前面，默认入口才是那个真的服务）
  for (const rule of rules) {
    for (const [path, content] of pythonFiles) {
      if (taken.has(path)) continue;
      const match = content.match(rule.pattern);
      if (!match) continue;
      taken.add(path);
      const framework = pythonFrameworkOf(content);
      anchors.push({
        path,
        line: content.slice(0, match.index ?? 0).split("\n").length,
        label: framework ? `${rule.label} (${framework})` : rule.label
      });
    }
  }
  return anchors;
}

/**
 * 框架名只认行首的 import：装饰器分不出框架（`@x.route` 是 Flask 还是 Sanic 都可能），
 * 而 `\b` 顺带挡掉 `flaskshop`、`fastapiapp` 这类同前缀的仓内包名。
 * 认不出就不带框架名——标签宁可少说，别说错。
 */
const pythonFrameworkNames = new Map([["flask", "Flask"], ["fastapi", "FastAPI"], ["django", "Django"]]);
const pythonFrameworkPattern = /^[ \t]*(?:from|import)\s+(flask|fastapi|django)\b/m;
const pythonFrameworkOf = (content: string): string | undefined => pythonFrameworkNames.get(pythonFrameworkPattern.exec(content)?.[1] ?? "");

/**
  这个入口锚点是不是「外部会打到它」那一类：HTTP 路由/路由表/服务启动，或框架启动类。
  `脚本主入口`（Python 的 `if __name__ == "__main__"`）与 `Go/Rust/C/C++/C# 主函数` 都不算——
  它们只说明「这个文件能自己跑」，不说明它在执行流里的位置。
  动因是 10-06 的实测：dianping 的 `observability/check-queries.py`（Grafana 自动加载用的运维脚本）
  因为是脚本主入口，把整个「可观测性」模块抬成了主干；而真正承载下单请求的控制器接口文件只占模块
  可见文件的 1/20 —— 分级判据要保护的是后者。
  ⚠️ 已知残留：整个仓就是一个 CLI（只靠 `main`）拿不到这条特权，只能靠占比那一档兜。
  正解是给 `SourceAnchor` 加一个 `trigger`（http | binary | script），但那字段会进流程 digest
  ⇒ 全部流程重烧，所以这一版按标签判（标签字符串就是本文件产的那几个，两边同源）。
*/
export function isServedEntrypoint(anchor: SourceAnchor): boolean {
  return /HTTP|启动类/.test(anchor.label ?? "");
}

/**
 * Java/Spring 入口识别：启动类看 @SpringBootApplication，HTTP 路由看 @Controller/@RestController。
 * 锚点落在类声明行（跳过注解块），GUI 跳转直达正文；@ControllerAdvice 不算入口（词边界已排除）。
 */
function detectJavaEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const classDecl = /^\s*(?:(?:public|private|protected|final|abstract|sealed|static)\s+)*(?:class|interface|enum|record)\s+\w+/;
  const boot: SourceAnchor[] = [];
  const controllers: SourceAnchor[] = [];
  for (const [path, content] of contents) {
    if (!path.endsWith(".java")) continue;
    const lines = content.split("\n");
    const classLineOf = (from: number): number => {
      for (let index = from; index < lines.length; index += 1) {
        if (classDecl.test(lines[index])) return index + 1;
      }
      return from + 1;
    };
    const bootIndex = lines.findIndex((line) => /^\s*@SpringBootApplication\b/.test(line));
    if (bootIndex >= 0) {
      boot.push({ path, line: classLineOf(bootIndex), label: "Spring Boot 启动类" });
      continue;
    }
    const controllerIndex = lines.findIndex((line) => /^\s*@(?:Rest)?Controller\b/.test(line));
    if (controllerIndex < 0) continue;
    // 类级 @RequestMapping 前缀从注解行扫到类声明为止，路径即视图上可直接报的挂载点
    let prefix = "";
    for (let index = controllerIndex; index < lines.length; index += 1) {
      if (classDecl.test(lines[index])) break;
      const match = lines[index].match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
      if (match) {
        prefix = match[1];
        break;
      }
    }
    controllers.push({ path, line: classLineOf(controllerIndex), label: `HTTP 路由 (Spring MVC)${prefix ? `：${prefix}` : ""}` });
  }
  return [...boot, ...controllers];
}

function detectLspStatus(files: FileEntry[]): DependencyGraphData["lspStatus"] {
  // java 没有接入 LSP（符号来自 tree-sitter），不进探测列表
  const languages = new Set(files.map((file) => file.extension === ".py" ? "python" : /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.extension) ? "typescript" : undefined).filter((value): value is "typescript" | "python" => Boolean(value)));
  return [...languages].map((language) => {
    const command = language === "typescript" ? "typescript-language-server" : "pylsp";
    try {
      const probe = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 600 });
      return probe.status === 0 ? { language, status: "available" as const } : { language, status: "fallback" as const, reason: `${command} 不可用，已使用静态语法分析` };
    } catch {
      return { language, status: "fallback" as const, reason: `${command} 不可用，已使用静态语法分析` };
    }
  });
}
