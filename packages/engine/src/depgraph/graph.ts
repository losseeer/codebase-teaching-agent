import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, normalize } from "node:path";
import type { CallEdge, DependencyGraphData, FileEntry, ImpactResult, SourceAnchor, SymbolInfo, TypeDispatchEdge } from "@codebase-tutor/shared";
import { LANGUAGE_CAPABILITIES, languageOfExtension } from "@codebase-tutor/shared";
import { extractMultilineTemplateLines, extractSymbolsFromAst, parseBackendStatus, type ParseBackendStatus } from "./parser.js";
import { isTestPath } from "./roles.js";

export interface DependencyGraph {
  imports: Map<string, string[]>;
  /**
    文件 → 它 import 了但仓内解析不到的裸包名（图上「边界之外」那一栏）。
    刻意与 `imports` 分家：这里没有一个字是边，`impactRadius`、角色分层、出题缓存键都不看它。
    没采到外部名的语言（Rust 的 `use serde::` 与 C/C++ 的 `<...>` 头）不写键，读侧按「未采集」处理。
  */
  externals: Map<string, string[]>;
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

/**
  图认哪些扩展名 = 能力表各条目的 `extensions` 汇总，不在这里另抄一份清单。
  */
export const graphExtensions: readonly string[] = [...new Set(Object.values(LANGUAGE_CAPABILITIES).flatMap((entry) => entry.extensions))];
/**
  建图时真正的那道后缀闸门（`buildDependencyGraph` 与语言画像共用）。
  它区分大小写，这是刻意不收紧的已知局限：`.TS` 这类大写后缀在图这一层一致排除，
  单点改成小写匹配只会造出「符号按 TS 语法解析、边却连不出来」的半状态。
  它与索引层的闸门不是一条：索引器先 lowercase 再比，所以 `App.TS` 进得了索引清单、进不了图。
  语言画像必须按这道闸门报数，否则会把「进了索引、没进图」说成「都在图里」。
  */
export const handledExtensions = new Set(graphExtensions);

/**
  裸说明符（TS 的 `./util`、`./util.js`）允许落到哪些扩展名：按发起文件的语言收尾。
  拿全表 19 个扩展名挨个试的话，同目录里 TS 的 `./util` 能连到 `util.py`、`util.go`，
  而能力表给 typescript 的 `dependencyEdge: exact` 就不再成立。
  收尾后 `typescript` / `vue` 一族互连（SFC 的 `<script>` 里 `./util` 落的就是 `.ts`），其余语言各自只试自己的扩展名。
  */
const SCRIPT_FAMILY = ["typescript", "vue"] as const;

/** ES/CJS/JSX 的后缀各对应哪份 TS 源文件（NodeNext 的固定对子）。 */
const nodeNextTargets: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"]
};

/**
  「按 TypeScript 那一族的写法处理」的判据，取自能力表而不是手写正则（手写会漏 `.mts`/`.cts`）。
  这一族不含 `.vue`：回落抽出的符号因此标成 `other` 而不是伪装成 typescript，也不给 `.vue` 探 TS 语言服务。
  不含它不意味着回落时 `.vue` 不被那条 JS/TS 正则扫：SFC 的 `<script>` 块里扫得出的都是真符号
  （模板里的 `{{ }}` 撞不上 `function`/`const … =>`/`class` 三种形状）。
  刻意不收紧成「非本族就不抽符号」：那样 wasm 一挂，`.vue`/`.java` 连回落符号都没有，比标错语言更糟。
  */
const tsFamilyExtensions = new Set(LANGUAGE_CAPABILITIES.typescript.extensions);

function specifierExtensions(fromPath: string): readonly string[] {
  const language = languageOfExtension(extname(fromPath));
  if (!language) return [];
  if (language === "typescript" || language === "vue") return SCRIPT_FAMILY.flatMap((entry) => LANGUAGE_CAPABILITIES[entry].extensions);
  return LANGUAGE_CAPABILITIES[language].extensions;
}

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
    if (!handledExtensions.has(file.extension)) continue;
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
  const externals = new Map<string, string[]>();
  for (const [path, content] of contents) {
    const resolved = resolveFileImports(path, content, { available, packages, javaTypes, javaRoots: packageRoots(javaTypes.keys()), goModules, goFilesByDir, csNamespaces, csRoots: packageRoots(csNamespaces.keys()), aliases });
    imports.set(path, resolved.paths);
    // 没有外部名的文件不写键：Map 里少一条 = 「这个文件不 import 任何仓外的东西」，是真结论
    if (resolved.externals.length) externals.set(path, resolved.externals);
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
    externals,
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
    externals: Object.fromEntries([...graph.externals.entries()]),
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

/**
  改这些文件会波及谁：沿 import 边与跨文件调用边反向往上走。
  同文件内的调用不算波及关系：图里同文件调用边是常态，不过滤的话每个改动文件都会给自己
  贡献一条「X 影响 X」的边，影响范围的箭头清单被自环占满。
  与 `roles.ts` 的 `buildFileEdges` 同一条口径（那里是 `key === value` 直接不建）。
*/
export function impactRadius(graph: DependencyGraph, changedPaths: string[]): ImpactResult {
  const reverse = new Map<string, { from: string; kind: "import" | "call" }[]>();
  for (const [from, targets] of graph.imports) {
    for (const to of targets) {
      if (to === from) continue;
      reverse.set(to, [...(reverse.get(to) ?? []), { from, kind: "import" }]);
    }
  }
  for (const call of graph.calls) {
    if (call.callerPath === call.calleePath) continue;
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
    // 产物里没有 externals 节点时按「未采集」处理成空表：图读到空表要说「这份产物还没采外部依赖」，
    // 不能说「这个仓不碰任何外部服务」
    externals: new Map(Object.entries(data.externals ?? {})),
    calls: data.calls,
    // 产物里可能只有 import 与 call 两类关系：dispatch 缺省按空表处理，别硬造
    dispatch: data.dispatch ?? [],
    symbols: data.symbols,
    entrypoints: data.entrypoints,
    semanticBackend: data.semanticBackend,
    lspStatus: data.lspStatus,
    // parseBackend 缺省按 regex 认（逐行匹配产出的图），别假装是语法树结果
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
  const extension = extname(path);
  const language = extension === ".py" ? "python" : tsFamilyExtensions.has(extension) ? "typescript" : "other";
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
    const opens = (lines[index].match(/{/g) ?? []).length;
    balance += opens - (lines[index].match(/}/g) ?? []).length;
    if (balance > 0) continue; // 还在函数体里
    // 花括号已归零：要么这行闭合了函数体（签名行开了括号，或已经走到签名行之后），要么是「无花括号」的声明
    if (index > start || opens > 0) return index + 1;
    // 无花括号的声明行（表达式体箭头函数 `const f = (a) => a + b`、单行 `function f(){return 1}`）就到本行为止；
    // 但若本行以 `=>` 收尾，函数体还在下一行（`const f = (a) =>\n  { … }`），不能在此收尾
    if (!/=>\s*$/.test(lines[index])) return start + 1;
  }
  return Math.min(lines.length, start + 1);
}

/**
  Java 的「接收者类型名 → 仓内文件」可见表：`import` 带进来的（含通配）加上同包——
  Java 里同包的类不需要 import 就能用，这一路不能少。

  同源码根才算可见（`src/main` 与 `src/test` 是两个编译范围）：主源码看不见测试源码里的类。
*/
function javaVisibleTypes(path: string, content: string, javaTypes: Map<string, string>): Map<string, string> {
  const packagePart = (fqn: string): string => fqn.slice(0, fqn.lastIndexOf("."));
  const ownPackage = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/m.exec(content)?.[1];
  const ownRoot = javaSourceRootOf(path);
  const visible = new Map<string, string>();
  /**
    `requireSameRoot` 只对「靠包名猜」的两条路成立（通配 import、同包可见）：多模块仓里
    `module-a/src/main/java/com/x/util` 与 `module-b/src/main/java/com/x/util` 是两个不同的编译单元，
    按包名把它们互相可见就会连出假边。显式 import 是确定的，跨模块也照收——
    把它一起收窄会误挡真边。
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
  注释按等长空格清除、import 整行清除，行数与字符偏移都不变：
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

  值得单独建一类边：Spring 的控制器注入的是接口，实现类在源码里没有任何调用行，
  import 边走到接口就断，service/impl 与它下面的 mapper 会整片在图上失联。
  落点复用 `javaVisibleTypes`：接口要么显式 import、要么同包，Java 没有第三种可能，所以这条判据不缺证据。
  代价：同名类型（多个模块各有一个 `IUserService`）可能指错，所以它是近似证据、不是权威结论。
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
  接收者名 → 它可能有的声明类型（一个名字可以有多个）：字段、方法参数、局部变量三种声明形状，
  `private final OrderMapper mapper`、`void write(ErrorCode errorCode)`、`StringBuilder sb = new ...`。

  要解到这个程度是因为 Spring 代码里的调用几乎全是 `service.query(...)` 这种小写变量接收者，
  只认类名接收者就等于看不见它们；只解字段又会丢掉经方法参数进来的真边，所以三类声明一起解才算完整。
  一个名字留多个类型：同一个变量名在不同方法里声明成不同类型是真事
  （`status` 既可能是 `OrderStatus` 也可能是 `PayType`），只留最后一个会凭空丢边。
  解不出类型的接收者仍走裸名匹配（`this.foo()`、链式中间段都不挡）。
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
      Java 的调用扫描读「清除注释与 import 行」的正文：注释里的 `voucherOrderService.handle(orderId)`
      是一句说明，不是调用证据，javadoc 里的流程图照样能给它连出几条假边。
      `stripJavaNoise` 用等长空格替换，所以行号与原文一一对应。
      其他语言的注释（`#`、`--`）暂不抹：符号级参照只覆盖了 Java，改动无法用参照校验。
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
          // 接收者是仓内可见类型 ⇒ 只认它声明的那个方法。找不到就不退回裸名匹配：
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
 *
 * 返回的是「一条 import 语句一组」（`primary` = 语句写的那个模块，`candidates` = 所有可能的落点），
 * 不是一个平铺的说明符数组：`from a.b import c` 会同时给出 `a.b` 与 `a.b.c`（c 可能是子模块也可能是符号名），
 * 平铺之后就判不出「这条语句落不到」，而外部包名这一栏要的正是语句级的失败。
 */
function extractPythonSpecifiers(content: string): { primary: string; candidates: string[] }[] {
  const groups: { primary: string; candidates: string[] }[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.*)$/);
    if (fromMatch) {
      const module = fromMatch[1];
      const candidates = [module];
      // `from a.b import c` 里的 c 可能是子模块，也可能是符号名 —— 两种都给出，交由可用性判定
      for (const name of readImportedNames(fromMatch[2])) candidates.push(module.endsWith(".") ? `${module}${name}` : `${module}.${name}`);
      groups.push({ primary: module, candidates });
      continue;
    }
    const importMatch = trimmed.match(/^import\s+(.*)$/);
    if (importMatch) for (const name of readImportedNames(importMatch[1])) groups.push({ primary: name, candidates: [name] });
  }
  return groups;
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
 * 通配符要留痕（`wildcard`）：`.*` 剥掉后剩下的是包名，在 `javaTypes` 里没有条目、逐级上溯也落不到，
 * 不留痕就整条丢掉，同包里那些没被显式 import 的类会被误判成孤立文件。
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
  通配展开与接收者可见表共用它，两处口径必须一致，否则文件级边和调用级边会互相矛盾。
  认不出 `src/main|test` 的仓返回空串（整个仓算一个编译范围），不是文件自身：
  扁平布局（`com/demo/App.java`、Eclipse 式无 src 的仓）里同包的类本来就互相可见，
  按「每个文件一个根」判会让 `javaSourceRootOf(a) !== javaSourceRootOf(b)` 恒成立，
  于是同包可见与包通配展开整条静默失效。真正的收窄靠包名，这里只负责把 main/test 分开。
*/
function javaSourceRootOf(path: string): string {
  const match = /(^|\/)src\/(main|test)\//.exec(path);
  return match ? `${path.slice(0, match.index)}src/${match[2]}` : "";
}

/**
  通配 import 的落点：只认「这个包里的类名真的出现在正文里」的那些。

  不整包展开：`com.demo.utils.*` 覆盖十几个类，而一个文件通常只用其中三四个；
  全量入图等于给同一包内的每对文件都连一条边——影响范围会虚胖、流程证据会被无关文件挤掉。
  判据用「标识符集合包含」而不是逐个正则：一次分词就能判完整个包，且天然带词边界（`Keys` 不会被 `Keys2` 误配）。
  代价：注释里提过的类名会被算进来，所以这类边的强度低于直接 import，是近似证据而非新的权威证据。
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
  /** javaTypes 的包根前缀（见 `packageRoots`）：判「这是本项目自己的包」用，一次建表反复查。 */
  javaRoots: Set<string>;
  goModules: Map<string, string>;
  goFilesByDir: Map<string, string[]>;
  csNamespaces: Map<string, string[]>;
  csRoots: Set<string>;
  aliases: PathAlias[];
}

/** 一条 import 语句的两类结果：仓内落点（进图的边）与仓外裸包名（进图上「边界之外」那一栏）。 */
interface ResolvedImports {
  paths: string[];
  externals: string[];
}

/**
  按语言分派「提取说明符 → 落点」。落不到的（stdlib/第三方/系统头）不进图，图里只留仓内依赖。
  这里多做的一件事是把落不到的包名身份记进 `externals`，让「这个系统边界之外碰了什么」有确定性数据可答。
  失败按一条 import 语句判，不按单个候选说明符判——`from a.b import c` 落不到才算这条语句用了外部包。
*/
function resolveFileImports(path: string, content: string, index: ImportIndex): ResolvedImports {
  /**
    收尾去重 + 去自环。Go 导入自己所在的包目录、Rust 在 `src/a.rs` 里写 `use crate::a::X`、
    Python 的绝对自导入（`import app.store` 写在 store.py 里）都能指回自己。
    角色层靠 `buildFileEdges` 的 key===value 挡了一下，`impactRadius` 没挡——
    自环进了影响范围就变成「改它影响它自己」这种无效证据，还会进流程与出题的图指纹。判据只留这一处。
    */
  const dedupe = (values: Iterable<string>): string[] => [...new Set(values)].filter((value) => value !== path);
  const finish = (paths: (string | undefined)[], externals: string[]): ResolvedImports => ({
    paths: dedupe(paths.filter((value): value is string => Boolean(value))),
    externals: [...new Set(externals)].sort()
  });

  if (path.endsWith(".py")) {
    const paths: (string | undefined)[] = [];
    const externals: string[] = [];
    for (const group of extractPythonSpecifiers(content)) {
      const hits = group.candidates.map((value) => resolvePythonImport(path, value, index.available));
      if (hits.some(Boolean)) paths.push(...hits);
      // 相对导入（`from . import x`）落不到是「仓内断链」，不是「用了包」
      else if (!group.primary.startsWith(".")) externals.push(packageIdentity("python", group.primary));
    }
    return finish(paths, externals);
  }
  if (path.endsWith(".java")) {
    const body = javaBodyOf(content);
    const paths: (string | undefined)[] = [];
    const externals: string[] = [];
    for (const item of extractJavaSpecifiers(content)) {
      const hits = item.wildcard ? expandJavaWildcard(path, item.specifier, body, index.javaTypes) : [resolveJavaImport(item.specifier, index.javaTypes)];
      if (hits.some(Boolean)) paths.push(...hits);
      // 仓内类型表盖得上的名字不是外部包：`import com.demo.dao.X` 落不到只说明 X 没被收录，
      // 把它记成「边界之外的服务」不准确
      else if (!coveredByPackageRoot(index.javaRoots, item.specifier)) externals.push(packageIdentity("java", item.specifier));
    }
    return finish(paths, externals);
  }
  if (path.endsWith(".go")) {
    const paths: string[] = [];
    const externals: string[] = [];
    for (const specifier of extractGoSpecifiers(content)) {
      const hits = resolveGoImport(specifier, index.goModules, index.goFilesByDir);
      if (hits.length) paths.push(...hits);
      // 仓内 go.mod 前缀盖得上、只是目录下没解析到文件：那也是仓内断链，不算外部
      else if (!coveredByGoModule(specifier, index.goModules)) externals.push(packageIdentity("go", specifier));
    }
    return finish(paths, externals);
  }
  if (path.endsWith(".rs")) {
    // Rust 的外部 crate 名仍采不到：extractRustSpecifiers 只认 `use (crate|self|super)::`，
    // `use serde::Serialize` 不在候选里。要采得改那条正则，属于「给一门语言加采集面」，不在这里。
    return finish(extractRustSpecifiers(content).map((value) => resolveRustImport(path, value, index.available)), []);
  }
  if (path.endsWith(".cs")) {
    const paths: string[] = [];
    const externals: string[] = [];
    for (const specifier of extractCSharpSpecifiers(content)) {
      const hits = resolveCSharpImport(specifier, index.csNamespaces);
      if (hits.length) paths.push(...hits);
      else if (!coveredByPackageRoot(index.csRoots, specifier)) externals.push(packageIdentity("csharp", specifier));
    }
    return finish(paths, externals);
  }
  if (cppExtensionPattern.test(path)) {
    // C/C++ 同理：extractCppIncludes 只取引号形式，`<vector>` 这类系统头不在候选里。
    return finish(dedupe(extractCppIncludes(content).flatMap((value) => resolveCppInclude(path, value, index.available))), []);
  }
  const paths: (string | undefined)[] = [];
  const externals: string[] = [];
  for (const match of [...content.matchAll(tsSpecifierPattern)]) {
    const hit = resolveImport(path, match[1], index.available, index.packages, index.aliases);
    if (hit) paths.push(hit);
    else if (isBarePackageName(match[1], index)) externals.push(packageIdentity("node", match[1]));
  }
  return finish(paths, externals);
}

/**
  「仓内解析不到」的说明符 → 边界栏用的包名身份。每种语言按「这个生态里一个包叫什么」来切：
  - python `redis.clients.Redis` → `redis`（PyPI 发行名就是第一段）；
  - java / csharp → 前四段：`org.springframework.data.redis`、`StackExchange.Redis`。
    只切两段会把整个 spring 挤成同一个东西——`spring-data-redis`（数据库）与 `spring-web`（HTTP）
    该不该同栏，差别就在中间这两段；切到类名那一段又会一个类一个身份，四段是最浅的能分开的一层；
  - go `github.com/gin-gonic/gin` → `github.com/gin-gonic`（域名式取前三段）；`fmt` → `fmt`：标准库照实记名，
    要不要算「外部」由词典那一层判，不在这里替它做主；
  - node `@fastify/cors/register` → `@fastify/cors`、`axios/lib/x` → `axios`（npm 包名是第一段，scope 例外要两段）。
  只切名字、不判类别、更不猜语义：判类别在 `external-catalog.ts`，而「猜」是模型的事，边界这一栏不许它碰。
*/
export function packageIdentity(language: "python" | "java" | "go" | "csharp" | "node", specifier: string): string {
  if (language === "go") {
    const segments = specifier.split("/").filter(Boolean);
    return (segments[0]?.includes(".") ? segments.slice(0, 3) : segments.slice(0, 1)).join("/");
  }
  if (language === "node") {
    const head = specifier.split("/")[0] ?? specifier;
    return head.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : head;
  }
  const segments = specifier.split(".").filter(Boolean);
  if (language === "python") return segments[0] ?? specifier;
  return segments.slice(0, 4).join(".");
}

/** 合法包名的字形：npm / PyPI 的名字里没有空格、尖括号、竖线。脏捕获靠这一条挡掉。 */
const packageNameShape = /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
  「解析不到」不等于「是外部包」，这一关挡掉三类东西：
  - `./missing`、`/abs/path`、命中 tsconfig 别名却没落点的都是仓内意图，只是断链，记成外部服务不准确；
  - 同一个仓里的工作区包（`@codebase-tutor/shared`）：落点算不出是解析能力问题，不是「用了个三方包」；
  - 字形根本不是包名的脏捕获：`tsSpecifierPattern` 在 `.tsx` 里真会吃到 `<div className=`、` | ` 这种串，
    只让 `resolveImport` 返回 undefined 不够，名字要留档就必须先验形。
*/
function isBarePackageName(specifier: string, index: ImportIndex): boolean {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (!packageNameShape.test(specifier)) return false;
  if (index.aliases.some((alias) => specifier.startsWith(alias.prefix))) return false;
  return ![...index.packages.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** Go 的「仓内」判据与 `resolveGoImport` 用同一份 go.mod 前缀，两边口径一致。 */
function coveredByGoModule(specifier: string, goModules: Map<string, string>): boolean {
  return [...goModules.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
  Java / C# 这一档的「仓内包根」集合：把已知类型全限定名（Java）或已知命名空间（C#）的前 2~3 段收下。
  不含第 1 段：`com` / `org` / `io` / `cn` 是顶级域，不是项目根——收进来会让
  「这个仓的类型在 `org.foo.app` 下」连带把所有 `org.springframework.*` 都说成仓内代码。
  判据不能是「这条 import 能不能落到某个类」：项目自己包根下的类没被索引时照样落不到，
  命中项目自己的包根 = 仓内断链，不记外部名。
*/
function packageRoots(names: Iterable<string>, separator = "."): Set<string> {
  const roots = new Set<string>();
  for (const name of names) {
    const segments = name.split(separator).filter(Boolean);
    for (let depth = 2; depth <= Math.min(3, segments.length); depth += 1) roots.add(segments.slice(0, depth).join(separator));
  }
  return roots;
}

/** 说明符的前 2~3 段里有任何一个落在仓内包根集合里 = 这是本项目自己的包。 */
function coveredByPackageRoot(roots: Set<string>, specifier: string): boolean {
  const segments = specifier.split(".").filter(Boolean);
  for (let depth = 2; depth <= Math.min(3, segments.length); depth += 1) if (roots.has(segments.slice(0, depth).join("."))) return true;
  return false;
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

/** 先按当前文件相对解析（编译器首要规则）；未命中再按全仓路径后缀匹配——include 目录各异，多个命中就全连（自环由 `resolveFileImports` 统一去掉）。 */
function resolveCppInclude(from: string, specifier: string, available: Set<string>): string[] {
  const relative = slash(normalize(join(dirname(from), specifier)));
  if (available.has(relative)) return [relative];
  const suffix = `/${specifier.replaceAll("\\", "/")}`;
  return [...available].filter((candidate) => candidate.endsWith(suffix));
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

/** 去掉 JSON 里的注释与尾逗号：tsconfig 惯例是带注释的 JSONC，状态机走字符是为了不错误影响字符串内的 `//`（如 `http://`）。 */
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
 * 只读根 tsconfig、只收通配条目（`"x/*"`）；exact 别名与 extends 继承的 paths 不在此列，解析不到就丢弃。
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

/** 通用说明符解析：只服务走到这里的脚本家族（TS / Vue）。py/java/go/rs/cs/cpp 都在 `resolveFileImports` 里被各自的分派截走，不会到这里。 */
function resolveImport(from: string, specifier: string, available: Set<string>, packages: Map<string, WorkspacePackage>, aliases: PathAlias[]): string | undefined {
  // 落点候选只试发起文件那门语言的扩展名，理由见 `specifierExtensions`
  const candidates = specifierExtensions(from);
  const tryResolve = (candidate: string): string | undefined => {
    const normalized = normalize(candidate).replaceAll("\\", "/");
    const direct = [normalized];
    // TypeScript 的 NodeNext 约定：源码里写的是运行时的后缀，实际文件是 TS 的那一个。
    // 后缀对子是固定的（.js↔.ts、.mjs↔.mts、.cjs↔.cts），所以按表逐项映射，不只写 `.js` 那一支。
    const extension = extname(normalized);
    const rewritten = nodeNextTargets[extension];
    if (rewritten) {
      const stripped = normalized.slice(0, -extension.length);
      direct.push(...rewritten.map((target) => `${stripped}${target}`));
    }
    const possibilities = [...direct, ...candidates.map((item) => `${normalized}${item}`), ...candidates.map((item) => `${normalized}/index${item}`)];
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
  // Node/TS 的框架入口（Express/Fastify/Koa/Nest）：同一类服务级证据
  const node = detectNodeEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  const authoritativePaths = new Set([...java, ...mains, ...python, ...node].map((anchor) => anchor.path));
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
    // 只在这文件进得了依赖图的语言里认约定名：`files` 是索引清单，里面还有 .md/.json/.yml。
    // 不筛的话 `docs/index.md`、`config/app.json` 会顶着「conventional entrypoint」进入口清单，
    // 而入口清单进 `classifyFileRoles`（它把文件抬成 core）又进流程 digest，等于让流程从一份 Markdown 讲起。
    if (!handledExtensions.has(file.extension)) continue;
    const name = basename(file.path, extname(file.path)).toLowerCase();
    if (["main", "server", "app", "index", "cli", "manage"].includes(name)) candidates.set(file.path, "conventional entrypoint");
  }
  // 测试夹具里的 main.py / index.js 不是真入口（package.json 的 scripts 会指进去）——
  // 与结构角色用同一套测试路径判定，把这类候选剔除。
  // 注解命中的入口是权威清单（每一个都对应真实的路由/启动点），不能沿用弱启发式的 12 截断；
  // 给宽上限只为兜底极端仓。
  const conventional = [...candidates.entries()]
    .filter(([path]) => !isTestPath(path) && !authoritativePaths.has(path) && files.some((file) => file.path === path))
    .map(([path, label]) => ({ path, line: 1, label }));
  return [...java.slice(0, 60), ...mains.slice(0, 60), ...python.slice(0, 60), ...node.slice(0, 60), ...conventional.slice(0, 12)];
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
 * Python 的入口证据写在框架约定里，文件名基本不带信息：FastAPI/Flask 的路由常拆在 api/、routers/ 下，
 * Django 的 URL 表在 urls.py，一个都不叫 main/server。
 * 规则表按证据强度排序，且一个文件只取最先命中的那条（与 Spring「启动类优先于 @Controller」同口径）：
 * 一个 main.py 挂着十几条路由装饰器，逐条标会把入口清单变成路由清单，
 * 同一个文件的十几个候选会挤满入口清单。
 * 误判比漏判更贵：只定义函数的库模块被标成入口后，画布会把工具模块当执行起点讲——
 * 所以这里只认框架级语句，不认「看着像在启动进程」的形态
 * （`runner.run(...)`、裸 `main()` 一律不算证据）。
 * 刻意没写的几条：`app.add_url_rule` 命令式登记、Sanic/Starlette/aiohttp 的构造形态、`re_path`/`include`
 * 的二级路由表——test-fixtures/pyframeworkdemo-repo 里没有对应样例，没有 fixture 就不写规则。
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
  // 外层按规则、内层按文件：证据强的先挑走文件，入口清单自然排在前面
  // （默认入口取 entrypoints[0]，所以排序不是外观问题——app 对象排在脚本守卫前面，默认入口才是那个真的服务）
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
 * 而 `\b` 同时挡掉 `flaskshop`、`fastapiapp` 这类同前缀的仓内包名。
 * 认不出就不带框架名——标签宁可少说，别说错。
 */
const pythonFrameworkNames = new Map([["flask", "Flask"], ["fastapi", "FastAPI"], ["django", "Django"]]);
const pythonFrameworkPattern = /^[ \t]*(?:from|import)\s+(flask|fastapi|django)\b/m;
const pythonFrameworkOf = (content: string): string | undefined => pythonFrameworkNames.get(pythonFrameworkPattern.exec(content)?.[1] ?? "");

/**
 * Node/TS 侧的框架入口：Express / Fastify / Koa / NestJS。
 * 只靠文件名约定认不出服务级入口，画布模块块的「含对外服务入口」一档会整仓为空。
 *
 * 四条收紧，都为「误判比漏判更贵」而设：
 *  - 先认出框架实例的名字（`const app = Fastify(...)`、`express()`、`new Koa()`、`NestFactory.create(...)`），
 *    只认这些名字上的 `.get/.post/.listen`。不收「任何标识符.get(字符串)」——那会把前端 axios 的
 *    `api.get("/users")` 与 `map.get("key")` 标成 HTTP 路由：客户端调用与被服务的路由是两件相反的事。
 *  - 框架名只认行首 import / require 位置的包名：文件里出现一个写着 "express" 的字符串不算。
 *  - 第一个参数必须是引号里的路径（TS 泛型实参允许夹在方法名与括号之间）：`app.get(handler)` 那种重载不算登记。
 *  - 证据行必须是代码：行首不能是注释续行，也不能落在跨行模板字符串里面。
 *    判「这一行是不是代码」用语法树（`extractMultilineTemplateLines`），不自己扫引号：
 *    第二套结构判据迟早和解析器打架。
 *
 * 一个文件只取最先命中的那一行证据（与 Python 那条同一口径）：一个 server.ts 挂着上百条路由，
 * 逐条标会把入口清单变成路由清单。
 * 已知漏判：`fastify.register(routes)` 拆到子文件的路由，接收者只是形参名、本地没有构造证据 ⇒ 不标；
 * 补它要跨文件传实例名。
 */
const nodeExtensionPattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const nodeRoutePattern = /^[ \t]*(?:(?:await|return)\s+)?([\w$]+)\s*\.\s*(?:get|post|put|patch|delete|all|route)\s*(?:<[^<]*>)?\s*\(\s*["'`]/;
const nodeListenPattern = /^[ \t]*(?:(?:await|return)\s+)?([\w$]+)\s*\.\s*listen\s*(?:<[^<]*>)?\s*\(/;
const nodeDecoratorPattern = /^[ \t]*@(?:Get|Post|Put|Patch|Delete|All)\s*\(\s*["'`]/;
const nodeControllerPattern = /^[ \t]*@Controller\s*\(/m;
const nodeImportPattern = /^[ \t]*(?:import|export)\b[^\n]*?from\s*["']([^"']+)["']/gm;
const nodeRequirePattern = /require\(\s*["']([^"']+)["']\s*\)/g;
const nodeInstancePattern = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?[^\n]*(?:Fastify|express|Koa|koa|Router|NestFactory)[^\n]*/gm;

function detectNodeEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const anchors: SourceAnchor[] = [];
  for (const [path, content] of contents) {
    if (!nodeExtensionPattern.test(path)) continue;
    const framework = nodeFrameworkOf(content);
    if (!framework) continue;
    const instances = nodeInstanceNames(content);
    const controller = nodeControllerPattern.test(content);
    if (!instances.size && !controller) continue;
    // 语法树没就绪（或这门语言没有语法）就整个文件不判：这个节点没有保守退路——
    // 把「读不出字符串边界」当成「这里没有字符串」，演示数据里那份假源码就会被标成服务入口，
    // 而入口一旦进档，入口清单与画布起点都跟着错。宁可少一条入口（图的 parseBackend 已如实记录降级）。
    const templates = extractMultilineTemplateLines(path, content);
    if (!templates) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
      if (templates.has(index + 1)) continue;
      // Nest 的路由写在方法上；同文件没有 @Controller 就当普通装饰器，不认
      if (controller && nodeDecoratorPattern.test(line)) {
        anchors.push({ path, line: index + 1, label: `HTTP 路由 (${framework})` });
        break;
      }
      const route = nodeRoutePattern.exec(line);
      if (route?.[1] && instances.has(route[1])) {
        anchors.push({ path, line: index + 1, label: `HTTP 路由 (${framework})` });
        break;
      }
      const listen = nodeListenPattern.exec(line);
      if (listen?.[1] && instances.has(listen[1])) {
        anchors.push({ path, line: index + 1, label: `HTTP 服务启动 (${framework})` });
        break;
      }
    }
  }
  return anchors;
}

/** 本文件里被赋成服务实例的名字：`export const app = Fastify({`、`const router = express.Router()`、`const app = await NestFactory.create(...)`。 */
function nodeInstanceNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(nodeInstancePattern)) if (match[1]) names.add(match[1]);
  return names;
}

/**
 * 框架名只认 import / require 位置的包名（与 Python 那条同一口径）：认不出就不带框架名。
 */
const nodeFrameworkNames = new Map([["fastify", "Fastify"], ["express", "Express"], ["koa", "Koa"]]);
const nodeFrameworkDisplay = (specifier: string): string | undefined =>
  specifier.startsWith("@nestjs") ? "NestJS" : nodeFrameworkNames.get(specifier);

function nodeFrameworkOf(content: string): string | undefined {
  for (const match of content.matchAll(nodeImportPattern)) {
    const display = nodeFrameworkDisplay(match[1] ?? "");
    if (display) return display;
  }
  for (const match of content.matchAll(nodeRequirePattern)) {
    const display = nodeFrameworkDisplay(match[1] ?? "");
    if (display) return display;
  }
  return undefined;
}

/**
  这个入口锚点是不是「外部会打到它」那一类：HTTP 路由/路由表/服务启动，或框架启动类。
  `脚本主入口`（Python 的 `if __name__ == "__main__"`）与 `Go/Rust/C/C++/C# 主函数` 都不算——
  它们只说明「这个文件能自己跑」，不说明它在执行流里的位置；把一份自动加载的运维脚本当入口，
  会把它所在的整个模块抬成主干。
  已知残留：整个仓就是一个 CLI（只靠 `main`）拿不到这条特权，只能靠模块占比那一档。
  按标签判而不是给 `SourceAnchor` 加 `trigger`（http | binary | script）字段：
  加字段会进流程 digest、触发全部流程重算；标签字符串就是本文件产的那几个，两边同源。
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
  const languages = new Set(files.map((file) => file.extension === ".py" ? "python" as const : tsFamilyExtensions.has(file.extension) ? "typescript" as const : undefined).filter((value): value is "typescript" | "python" => Boolean(value)));
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
