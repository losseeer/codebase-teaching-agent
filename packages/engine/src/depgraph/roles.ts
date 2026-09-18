import type { CallEdge, FileRole, SourceAnchor, SymbolInfo } from "@codebase-tutor/shared";

/**
  文件角色的结构分类：只用符号表、调用边、import 边与入口清单，**不调模型**。

  为什么不让模型来分：角色要落进缓存、要被流程证据与课程树同时引用，若它的来源随配置变
  （配了模型一套、没配另一套），同一个仓库会得到两套角色，缓存与对比都失去意义。
  模型该做的是「这个文件在讲什么」（职责摘要），不是「它在图上处在哪个位置」——后者是结构问题。

  口径（按顺序判定，先命中先用）：
  1. 测试路径 → test
  2. 入口文件 → core
  3. 名字/路径命中设施类词（配置、存储、缓存、日志、可观测、网络客户端、队列、部署…）→ infra
  4. 被任一入口直接依赖（import 或调用）→ core
  5. 既不依赖别人、也不被别人依赖 → tool
  6. 其余 → support
*/

export interface FileStructure {
  /** 仓库内被索引的文件（用路径与行数）。 */
  files: { path: string; lines: number }[];
  symbols: SymbolInfo[];
  calls: CallEdge[];
  imports: Record<string, string[]>;
  /** 全部入口：角色按「被任一入口依赖」判，因此与「这次看的是哪个入口」无关。 */
  entrypoints: SourceAnchor[];
}

/**
  文件级依赖双向表：import 边 **加上** 跨文件调用边。
  调用边能补上 import 边看不见的关系（例如 Python 同包内的隐式引用），
  两条边都算「依赖」是为了让「谁依赖谁」这一问在同一口径下回答。
*/
export function buildFileEdges(structure: Pick<FileStructure, "imports" | "calls">): {
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
} {
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, key: string, value: string): void => {
    if (key === value) return;
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  for (const [from, targets] of Object.entries(structure.imports)) {
    for (const to of targets) {
      link(dependencies, from, to);
      link(dependents, to, from);
    }
  }
  // 跨文件调用也是依赖：只算文件级，同文件内的调用不构成文件间关系
  for (const call of structure.calls) {
    link(dependencies, call.callerPath, call.calleePath);
    link(dependents, call.calleePath, call.callerPath);
  }
  return { dependencies, dependents };
}

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "testing", "e2e"]);

/**
  设施类词：命中即认作「与外部世界或运行环境打交道」。
  这是粗分类，宁可漏判也不要把业务逻辑误判成设施——所以只收公认的设施名，不收 `core`/`util` 这类泛词。
*/
const INFRA_HINTS = [
  "config", "setting", "env", "credential", "secret",
  "database", "db", "store", "storage", "sql", "mysql", "postgres", "redis", "mongo",
  "cache", "queue", "kafka", "mq", "scheduler",
  "log", "logging", "observability", "telemetry", "metric", "monitor",
  "http", "client", "sdk", "gateway", "proxy", "webhook",
  "docker", "deploy", "bootstrap", "conftest"
];

export function isTestPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const base = segments[segments.length - 1];
  if (segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment))) return true;
  return base === "conftest.py" || /^test_.*\.py$/.test(base) || /_test\.(py|go|rb)$/.test(base) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

function hasInfraHint(path: string): boolean {
  const lower = path.toLowerCase();
  return INFRA_HINTS.some((hint) => lower.includes(hint));
}

export function classifyFileRoles(structure: FileStructure): Map<string, FileRole> {
  const { dependencies, dependents } = buildFileEdges(structure);
  const entryPaths = new Set(structure.entrypoints.map((anchor) => anchor.path));
  const entryDependencies = new Set<string>();
  for (const entry of entryPaths) {
    for (const target of dependencies.get(entry) ?? []) entryDependencies.add(target);
  }

  const roles = new Map<string, FileRole>();
  for (const file of structure.files) {
    const path = file.path;
    if (isTestPath(path)) roles.set(path, "test");
    else if (entryPaths.has(path)) roles.set(path, "core");
    else if (hasInfraHint(path)) roles.set(path, "infra");
    else if (entryDependencies.has(path)) roles.set(path, "core");
    else if (!dependencies.get(path)?.size && !dependents.get(path)?.size) roles.set(path, "tool");
    else roles.set(path, "support");
  }
  return roles;
}

/** 某个文件的角色；不在索引里的一律按 support 处理（调用方不必再判空）。 */
export function roleOf(roles: Map<string, FileRole>, path: string): FileRole {
  return roles.get(path) ?? "support";
}

/**
  从索引文件清单与依赖图拼出结构输入。
  单独收在这里是因为 `DependencyGraph.imports` 是 Map、而结构输入要普通对象——
  这层转换若散在各调用点，早晚会有一处漏转或转错。
*/
export function fileStructureOf(
  files: FileStructure["files"],
  graph: { symbols: SymbolInfo[]; calls: CallEdge[]; imports: Map<string, string[]>; entrypoints: SourceAnchor[] }
): FileStructure {
  return {
    files,
    symbols: graph.symbols,
    calls: graph.calls,
    imports: Object.fromEntries(graph.imports),
    entrypoints: graph.entrypoints
  };
}
