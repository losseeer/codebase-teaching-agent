/**
  练习沙箱覆盖面探针（刀 0，零 token、只读）：回答「改代码 / 写代码 + 沙箱跑测试」这类题现在能给几门语言出、
  首发哪几门、要不要额外做转译。

  为什么先量这个：判分要真跑代码，就得把「这个单元」连它能解析到的依赖一起写入沙箱。
  一个文件的 import 若全部落在「标准库 ∪ 仓内文件」，挂只读快照 + 该语言的模块解析就够跑；
  只要有一条落在外部包（npm / pip / Maven classpath），跑起来就变成「装依赖」，成本与失败面完全不是一个量级。
  所以这里量的不是「语言支持得好不好」，而是**不装东西能不能跑**。

  分档（自包含 / 仓内闭包 / 需外部包 / 判不准 / 需容器）是**探针口径**：现读文件正文把每条 import 说明符抽出来再分类。
  引擎产物里只存「解析成功的仓内目标」，外部包 import 天生不可见，所以这一层必须自己抽；
  它只用来定首发语言集，不进产品判据。
  曾经还有一档「TS 零依赖纯函数」直接调引擎真判据 `safeInvocationFor`，用来对照现状能出多少题——
  那条判据随 `output_prediction` 于 2026-10-14 退役（当时读数：2 / 1222），此处不再重算。

  只读：DB 以 readOnly 打开，仓库文件只 readFileSync，不写任何产物。
  用法：pnpm sandbox:coverage
*/
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { ImplementationUnit, RepositoryAnalysis, SymbolInfo } from "@codebase-tutor/shared";
import { languageOfExtension } from "@codebase-tutor/shared";

/** 单元上的语言标签（比界面用的 `SupportedLanguage` 少一档 vue/javascript，探针按这一份走，不自造第三套）。 */
type UnitLanguage = SymbolInfo["language"];

/**
  `.vue` 在符号上没有专属标签（`SymbolInfo.language` 那一族里没有 vue），存量产物里一律记成 `other`，
  直接照 tag 分派会把整个 `<script>` 块的 import 抽成空表、判成「什么都不 import」。
  这里按扩展名回查共享能力表那一档真实语言，其它情况照原 tag。
  （`languageOfExtension` 只吃扩展名，喂整条路径它不会自己截尾段，所以在这里截。）
*/
function languageOfUnit(unit: ImplementationUnit): UnitLanguage | string {
  if (unit.symbol.language !== "other") return unit.symbol.language;
  const dot = unit.symbol.path.lastIndexOf(".");
  return dot >= 0 ? languageOfExtension(unit.symbol.path.slice(dot)) ?? "other" : "other";
}

/**
  一个单元所在文件的 import 整体落在哪一档：
  - `self-contained` 除标准库外不 import 任何东西 → 单文件进沙箱就能跑。
  - `closure`        import 全在「标准库 ∪ 仓内文件」→ 快照 + 模块解析能跑。
  - `external`       至少一条落在外部包 → 要装依赖才能跑。
  - `unknown`        有分不出类的说明符且没有确认的外部包 → 探针判不准，不替它乐观。
  另记两维：`callers`（图里有仓内调用方，出题时找得到真实用法）与 `container`
  （所在文件有字段注入或挂在 IoC 容器上，离开容器实例化不出来）。
*/
type Tier = "self-contained" | "closure" | "external" | "unknown";
type Verdict = "stdlib" | "in-repo" | "external" | "unknown";

interface Row {
  language: UnitLanguage;
  units: number;
  tiers: Record<Tier, number>;
  callers: number;
  container: number;
  kinds: Record<string, number>;
  externalPackages: Set<string>;
}

const TIERS: Tier[] = ["self-contained", "closure", "external", "unknown"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "__pycache__", ".venv", "venv", "out", ".next", "coverage", "obj", "bin", "logs"]);
const CONTAINER_MARKERS = /@(?:Autowired|Resource|Inject|Reference|Qualifier|Value)\b/;

function emptyRow(language: UnitLanguage): Row {
  return { language, units: 0, tiers: { "self-contained": 0, closure: 0, external: 0, unknown: 0 }, callers: 0, container: 0, kinds: {}, externalPackages: new Set() };
}

// ==== 仓内路径全集：一次目录扫描，供「说明符落点在不在仓里」用 ====

function walkRepo(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 16) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) { walk(join(dir, entry.name), depth + 1); continue; }
      if (!entry.isFile()) continue;
      out.push(join(dir, entry.name).slice(root.length + 1).split(sep).join("/"));
    }
  };
  walk(root, 0);
  return out;
}

/**
  点号后缀全集：`src/main/java/com/x/y/Z.java` 产出 `com.x.y.Z`、`x.y.Z`、`y.Z`、`Z`。
  Java 的全限定名与 Python 的点号模块名都靠它认「仓里有没有这个东西」——两边都不该各写一份目录推导。
*/
function dottedSuffixes(paths: string[]): Set<string> {
  const set = new Set<string>();
  for (const path of paths) {
    const withoutExtension = path.replace(/\.[^./]+$/, "");
    const segments = withoutExtension.split("/");
    for (let start = Math.max(0, segments.length - 12); start < segments.length; start += 1) {
      const suffix = segments.slice(start).join(".");
      if (suffix) set.add(suffix);
    }
  }
  return set;
}

// ==== Python 标准库顶层名从本机解释器现取（手写清单一定会过期） ====

function pythonStdlib(): Set<string> {
  const probe = spawnSync("python3", ["-c", "import sys,json;print(json.dumps(sorted(sys.stdlib_module_names)))"], { encoding: "utf8", timeout: 8_000 });
  if (probe.status !== 0) return new Set();
  try { return new Set(JSON.parse(probe.stdout) as string[]); } catch { return new Set(); }
}

const STDLIB_PY = pythonStdlib();
/** javax 只有这几族在 JDK 内；servlet / validation / annotation 都要外部 jar，不能一概算标准库。 */
const JAVA_JAVAX_STDLIB = ["javax.swing", "javax.net", "javax.crypto", "javax.script", "javax.tools", "javax.imageio", "javax.sound", "javax.naming", "javax.sql", "javax.management"];
const CPP_STD_HEADERS = new Set(["algorithm", "array", "atomic", "cassert", "chrono", "cmath", "condition_variable", "cstddef", "cstdint", "cstdio", "cstdlib", "cstring", "deque", "exception", "filesystem", "fstream", "functional", "future", "initializer_list", "iomanip", "iostream", "istream", "iterator", "limits", "list", "map", "memory", "mutex", "numeric", "optional", "ostream", "queue", "random", "ranges", "set", "shared_mutex", "span", "stack", "stdexcept", "string", "string_view", "thread", "tuple", "type_traits", "unordered_map", "unordered_set", "utility", "variant", "vector",
  "assert.h", "ctype.h", "errno.h", "math.h", "stdarg.h", "stdbool.h", "stddef.h", "stdint.h", "stdio.h", "stdlib.h", "string.h", "time.h", "unistd.h"]);

// ==== import 说明符抽取：每语言一条规则，只问「正文写了什么」，不管引擎解析到哪 ====

const TS_PATTERNS = [
  /^\s*import\s+(?:type\s+)?(?:[^'"(]*?\sfrom\s+)?["']([^"']+)["']/gm,
  /^\s*export\s+(?:type\s+)?(?:[^'"(]*?\sfrom\s+)?["']([^"']+)["']/gm,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
];
const PY_PATTERNS = [/^\s*from\s+((?:\.)+\w*)(?:\s+|\s*import)/gm, /^\s*import\s+(\w+(?:\.\w*)?)/gm];
const JAVA_PATTERN = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*(?:\.\*)?\s*;/gm;
const RUST_PATTERN = /^\s*use\s+((?:::)?[\w:]+)\s*;/gm;
const CS_PATTERN = /^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm;
const CPP_PATTERN = /^\s*#include\s*([<"])([^">]+)[">]/gm;

function matchAll(pattern: RegExp, content: string): string[] {
  const found: string[] = [];
  for (const match of content.matchAll(pattern)) found.push((match[1] ?? "").trim());
  return found.filter(Boolean);
}

function specifiersOf(language: string, content: string, goModule: string | undefined): string[] {
  if (language === "typescript" || language === "javascript" || language === "vue") return [...new Set(TS_PATTERNS.flatMap((pattern) => matchAll(pattern, content)))];
  if (language === "python") return [...new Set(PY_PATTERNS.flatMap((pattern) => matchAll(pattern, content)))];
  if (language === "java") return [...new Set(matchAll(JAVA_PATTERN, content))];
  if (language === "rust") return [...new Set(matchAll(RUST_PATTERN, content))];
  if (language === "csharp") return [...new Set(matchAll(CS_PATTERN, content))];
  if (language === "cpp") return [...new Set(matchAll(CPP_PATTERN, content))];
  if (language === "go") {
    const block = content.match(/\bimport\s*\(([^)]*)\)/s);
    const listed = block ? [...block[1].matchAll(/"([^"\s]+)"/g)].map((match) => match[1]) : [];
    const singles = [...content.matchAll(/^\s*import\s+"([^"\s]+)"/gm)].map((match) => match[1]);
    return [...new Set([...singles, ...listed])]
      .map((specifier) => (goModule && (specifier === goModule || specifier.startsWith(`${goModule}/`)) ? `repo:${specifier.slice(goModule.length + 1) || "."}` : specifier));
  }
  return [];
}

function classify(language: string, specifier: string, filePath: string, fileSet: Set<string>, suffixSet: Set<string>): Verdict {
  const existsWithExtensions = (base: string, extensions: string[]): boolean =>
    fileSet.has(base) || extensions.some((extension) => fileSet.has(`${base}${extension}`)) || extensions.some((extension) => fileSet.has(`${base}/index${extension}`));

  if (language === "typescript" || language === "javascript" || language === "vue") {
    // ESM 的 TS 源码按规矩写 `./foo.js`，磁盘上却是 `foo.ts`：不补这一手，相对导入会整批落进「判不准」。
    const asTypeScript = (base: string): string => base.replace(/\.(js|mjs|cjs|jsx)$/, "");
    if (specifier.startsWith(".")) {
      const base = asTypeScript(join(dirname(filePath), specifier));
      return existsWithExtensions(base, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"]) ? "in-repo" : "unknown";
    }
    if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
      const base = asTypeScript(join("src", specifier.slice(2)));
      return existsWithExtensions(base, [".ts", ".tsx", ".js", ".vue"]) ? "in-repo" : "unknown";
    }
    if (isBuiltin(specifier) || isBuiltin(specifier.replace(/^node:/, ""))) return "stdlib";
    return "external";
  }
  if (language === "python") {
    if (specifier.startsWith(".")) return "in-repo";
    if (STDLIB_PY.has(specifier.split(".")[0] ?? specifier)) return "stdlib";
    return suffixSet.has(specifier) ? "in-repo" : "external";
  }
  if (language === "java") {
    if (specifier.startsWith("java.")) return "stdlib";
    if (JAVA_JAVAX_STDLIB.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}.`))) return "stdlib";
    return suffixSet.has(specifier) ? "in-repo" : "external";
  }
  if (language === "go") {
    if (specifier.startsWith("repo:")) return "in-repo";
    return (specifier.split("/")[0] ?? "").includes(".") ? "external" : "stdlib";
  }
  if (language === "rust") {
    if (/^(?:std|core|alloc)(?::|$)/.test(specifier)) return "stdlib";
    if (/^(?:::?)(?:crate|self|super)(?::|$)/.test(specifier)) return "in-repo";
    return "external";
  }
  if (language === "csharp") return specifier === "System" || specifier.startsWith("System.") ? "stdlib" : "external";
  if (language === "cpp") {
    const base = specifier.split("/").pop() ?? specifier;
    if (CPP_STD_HEADERS.has(base)) return "stdlib";
    return existsWithExtensions(specifier, [".h", ".hpp"]) ? "in-repo" : "unknown";
  }
  return "unknown";
}

function goModuleOf(root: string): string | undefined {
  const file = join(root, "go.mod");
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8").match(/^module\s+(\S+)/m)?.[1];
}

/**
  本机能不能起这门语言的解释器/编译器。「不装依赖就能跑」的前提是这里先有一句「有」——
  否则覆盖率再高也是空谈（Go 在这台机器上就是这个形状：仓内 100% 自包含，可 `go` 根本没装）。
  只跑 `--version`，不执行任何仓内代码。
*/
const TOOLCHAIN: Record<string, { command: string; args: string[] }> = {
  typescript: { command: "node", args: ["--version"] },
  javascript: { command: "node", args: ["--version"] },
  vue: { command: "node", args: ["--version"] },
  python: { command: "python3", args: ["--version"] },
  java: { command: "javac", args: ["-version"] },
  go: { command: "go", args: ["version"] },
  rust: { command: "rustc", args: ["--version"] },
  csharp: { command: "dotnet", args: ["--version"] },
  cpp: { command: "c++", args: ["--version"] }
};

function toolchainStatus(): Record<string, string | undefined> {
  const status: Record<string, string | undefined> = {};
  for (const [language, probe] of Object.entries(TOOLCHAIN)) {
    if (status[language]) continue;
    const result = spawnSync(probe.command, probe.args, { encoding: "utf8", timeout: 8_000 });
    status[language] = result.status === 0 ? (result.stdout || result.stderr).trim().split("\n")[0]?.slice(0, 40) : undefined;
  }
  return status;
}

const TOOLCHAINS = toolchainStatus();

function tierOf(verdicts: Verdict[], specifierCount: number): Tier {
  if (!specifierCount) return "self-contained";
  if (verdicts.includes("external")) return "external";
  if (verdicts.includes("unknown")) return "unknown";
  return verdicts.includes("in-repo") ? "closure" : "self-contained";
}

// ==== 主流程 ====

const registry = resolve(join(homedir(), ".codebase-tutor", "repositories.json"));
const repositories: string[] = existsSync(registry) ? (JSON.parse(readFileSync(registry, "utf8")) as { repositories?: string[] }).repositories ?? [] : process.argv.slice(2);
if (!repositories.length) {
  console.log(`# 练习沙箱覆盖面探针\n\n- **未执行**：找不到 ${registry}，也没给仓库路径参数。`);
  process.exit(0);
}

const perRepo: { repository: string; reason: string; rows: Row[] }[] = [];
for (const repositoryPath of repositories) {
  const label = repositoryPath.split("/").filter(Boolean).pop() ?? repositoryPath;
  const databaseFile = join(repositoryPath, ".tutor", "tutor.db");
  if (!existsSync(databaseFile)) { perRepo.push({ repository: label, reason: "没有 tutor.db（未导入过）", rows: [] }); continue; }
  let analysis: RepositoryAnalysis | undefined;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT analysis_json FROM repository_state WHERE analysis_json IS NOT NULL ORDER BY updated_at DESC").get() as { analysis_json: string } | undefined;
    analysis = row ? (JSON.parse(row.analysis_json) as RepositoryAnalysis) : undefined;
  } finally { db.close(); }
  if (!analysis) { perRepo.push({ repository: label, reason: "产物里没有 graph/implementation（重烧后才有点可测）", rows: [] }); continue; }

  const repoFiles = walkRepo(repositoryPath);
  const fileSet = new Set(repoFiles);
  const suffixSet = dottedSuffixes(repoFiles);
  const goModule = goModuleOf(repositoryPath);
  const contentCache = new Map<string, string | undefined>();
  const readContent = (path: string): string | undefined => {
    if (contentCache.has(path)) return contentCache.get(path);
    let text: string | undefined;
    try { text = readFileSync(join(repositoryPath, path), "utf8").slice(0, 400_000); } catch { text = undefined; }
    contentCache.set(path, text);
    return text;
  };

  /**
    被调用侧的两种形态都收：`calleeSymbol` 在真产物里存的是**符号 id**（`symbol:<path>:<name>:<line>`），
    而实现单元手上同时有 id 和 name。只按 name 拼键会整列判成 0——第一版探针就在 dianping 后端这么漏掉了 1177 条 Java 边。
    */
  const calleeIds = new Set<string>();
  const calleeNames = new Set<string>();
  for (const edge of analysis.graph.calls ?? []) {
    if (!edge.calleeSymbol) continue;
    calleeIds.add(edge.calleeSymbol);
    calleeNames.add(`${edge.calleePath}\u0000${edge.calleeSymbol.split(":").slice(2, -1).join(":") || edge.calleeSymbol}`);
  }

  const rows = new Map<string, Row>();
  for (const unit of analysis.implementations) {
    const language = languageOfUnit(unit);
    const row = rows.get(language) ?? emptyRow(language as UnitLanguage);
    rows.set(language, row);
    row.units += 1;
    row.kinds[unit.symbol.kind] = (row.kinds[unit.symbol.kind] ?? 0) + 1;

    const content = readContent(unit.symbol.path);
    if (content === undefined) { row.tiers.unknown += 1; continue; }
    const specifiers = specifiersOf(language, content, goModule);
    const verdicts = specifiers.map((specifier) => classify(language, specifier, unit.symbol.path, fileSet, suffixSet));
    const tier = tierOf(verdicts, specifiers.length);
    row.tiers[tier] += 1;
    if (tier === "external") for (const [index, verdict] of verdicts.entries()) if (verdict === "external") row.externalPackages.add(specifiers[index]?.split("/")[0]?.split(".")[0] ?? "?");
    if (calleeIds.has(unit.symbol.id) || calleeNames.has(`${unit.symbol.path}\u0000${unit.symbol.name}`) || (unit.symbol.referenceCount ?? 0) > 0) row.callers += 1;
    if (CONTAINER_MARKERS.test(content)) row.container += 1;
  }
  perRepo.push({ repository: label, reason: "", rows: [...rows.values()].sort((left, right) => right.units - left.units) });
}

// ==== 输出 ====

const percent = (part: number, whole: number): string => whole ? `${Math.round((part / whole) * 100)}%` : "—";

console.log("# 练习沙箱覆盖面探针（刀 0，零 token、只读）\n");
console.log(`- 本机解释器：python3 stdlib ${STDLIB_PY.size ? `已取（${STDLIB_PY.size} 个顶层名）` : "**取不到**，Python 的分档全落 unknown"} · node ${process.versions.node}`);
console.log(`- 各语言本机工具链：${Object.entries(TOOLCHAINS).filter(([language]) => language !== "javascript").map(([language, version]) => `${language}=${version ?? "缺"}`).join(" · ")}`);
console.log("- 判据：`self-contained` = 除标准库外不 import 任何东西；`closure` = import 全在「标准库 ∪ 仓内文件」；`external` = 至少一条外部包；`unknown` = 探针判不准。");
console.log("- `sandbox-ready` = self-contained + closure，即**不装依赖就能进沙箱跑**的比例。");
console.log("- 历史一列（已撤）：`safeInvocationFor` 那条 TS 纯函数判据当时只命中 **2 / 1222** 个 TypeScript 单元，该判据随 `output_prediction` 于 2026-10-14 一起退役，所以这里不再重算——读数留在开发日志 §52。\n");

for (const { repository, reason, rows } of perRepo) {
  console.log(`## ${repository}`);
  if (reason) { console.log(`\n- 跳过：${reason}\n`); continue; }
  console.log("");
  console.log("| 语言 | 单元 | 自包含 | 仓内闭包 | 需外部包 | 判不准 | 可进沙箱 | 有调用方 | 需容器 |");
  console.log("| --- | --: | --: | --: | --: | --: | --: | --: | --: |");
  for (const row of rows) {
    const ready = row.tiers["self-contained"] + row.tiers.closure;
    console.log(`| ${row.language} | ${row.units} | ${row.tiers["self-contained"]} | ${row.tiers.closure} | ${row.tiers.external} | ${row.tiers.unknown} | ${percent(ready, row.units)} | ${percent(row.callers, row.units)} | ${percent(row.container, row.units)} |`);
  }
  const external = new Set<string>();
  for (const row of rows) for (const name of row.externalPackages) external.add(name);
  if (external.size) console.log(`\n- 外部包名（前 12 个，去重）：${[...external].slice(0, 12).join("、")}`);
  console.log("");
}

const totals = new Map<string, Row>();
for (const { rows } of perRepo) for (const row of rows) {
  const merged = totals.get(row.language) ?? emptyRow(row.language);
  merged.units += row.units;
  merged.callers += row.callers;
  merged.container += row.container;
  for (const tier of TIERS) merged.tiers[tier] += row.tiers[tier];
  for (const [kind, count] of Object.entries(row.kinds)) merged.kinds[kind] = (merged.kinds[kind] ?? 0) + count;
  totals.set(row.language, merged);
}

console.log("## 全仓合并 + 首发判据\n");
console.log("| 语言 | 单元 | 可进沙箱 | 自包含 | 需外部包 | 判不准 | 本机解释器 | 判读 |");
console.log("| --- | --: | --: | --: | --: | --: | --- | --- |");
for (const row of [...totals.values()].sort((left, right) => right.units - left.units)) {
  const ready = row.tiers["self-contained"] + row.tiers.closure;
  const share = row.units ? ready / row.units : 0;
  const toolchain = TOOLCHAINS[row.language];
  const verdict = !toolchain ? "本机跑不起来（先装工具链才谈得出题）" : share < 0.05 ? "不出代码题" : share < 0.2 ? "只做自包含档" : "可上仓内闭包档";
  console.log(`| ${row.language} | ${row.units} | ${percent(ready, row.units)} | ${percent(row.tiers["self-contained"], row.units)} | ${percent(row.tiers.external, row.units)} | ${percent(row.tiers.unknown, row.units)} | ${toolchain ?? "**缺**"} | ${verdict} |`);
}
console.log("\n- 阈值口径：<5% 不出代码题；5~20% 只做自包含档；>20% 才值得做仓内闭包（快照 + 模块解析）；再往上才考虑装依赖 / 转译。");
console.log("- 判读时注意样本量：单元数 < 20 的语言这一列是噪声，不构成结论。");
console.log("- 「可进沙箱」是**文件级**判据：一个文件只要有一条外部 import 就整档落到「需外部包」，所以工程仓（人人都碰框架）天生压得低。");
