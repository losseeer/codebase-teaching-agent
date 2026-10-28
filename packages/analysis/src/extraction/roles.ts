import type { CallEdge, FileRole, SourceAnchor, SymbolInfo, TypeDispatchEdge } from "@codebase-tutor/domain";

/**
  文件角色的结构分类：只用符号表、调用边、import 边、类型派发边与入口清单，不调模型。
  判定顺序见 classifyFileRoles：设施词判在入口依赖之前。
*/

export interface FileStructure {
  /** 被索引的文件。 */
  files: { path: string; lines: number }[];
  symbols: SymbolInfo[];
  calls: CallEdge[];
  imports: Record<string, string[]>;
  /** 全部入口；角色判定与当前所选入口无关。 */
  entrypoints: SourceAnchor[];
  /** 类型派发边（实现/子类 → 接口/父类）；缺省表示没有这一类关系。 */
  dispatch?: TypeDispatchEdge[];
}

/** 文件级依赖双向表：import 边与调用边都算依赖，类型派发边单独走 `dispatches`。 */
export function buildFileEdges(structure: Pick<FileStructure, "imports" | "calls" | "dispatch">): {
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
  /** 接口 / 父类文件 → 它的实现 / 子类文件。 */
  dispatches: Map<string, Set<string>>;
  /** 出现在任一类型派生关系里的文件（两头都算）。 */
  dispatchTouches: Set<string>;
} {
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const dispatches = new Map<string, Set<string>>();
  const dispatchTouches = new Set<string>();
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
  for (const call of structure.calls) {
    link(dependencies, call.callerPath, call.calleePath);
    link(dependents, call.calleePath, call.callerPath);
  }
  for (const edge of structure.dispatch ?? []) {
    link(dispatches, edge.supertypePath, edge.subtypePath);
    dispatchTouches.add(edge.subtypePath);
    dispatchTouches.add(edge.supertypePath);
  }
  return { dependencies, dependents, dispatches, dispatchTouches };
}

/** 入口的直接依赖集合，含类型派发透传；透传可连续，不沿普通依赖延伸。 */
export function entryDependenciesOf(structure: Pick<FileStructure, "imports" | "calls" | "dispatch" | "entrypoints">): Set<string> {
  const { dependencies, dispatches } = buildFileEdges(structure);
  const reached = new Set<string>();
  const pending: string[] = [];
  const push = (path: string): void => {
    if (reached.has(path)) return;
    reached.add(path);
    pending.push(path);
  };
  for (const entry of structure.entrypoints) {
    for (const target of dependencies.get(entry.path) ?? []) push(target);
  }
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    for (const subtype of dispatches.get(pending[cursor]) ?? []) push(subtype);
  }
  return reached;
}

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "test-fixtures", "fixtures", "spec", "specs", "testing", "e2e"]);

/**
  设施类词：命中文件名词元即认作与外部世界或运行环境打交道。
  只收公认的设施名，不收 `core`/`util` 这类泛词。
*/
export const INFRA_HINTS = [
  "config", "setting", "env", "credential", "secret",
  "database", "db", "store", "storage", "sql", "mysql", "postgres", "redis", "mongo",
  "cache", "queue", "kafka", "mq", "scheduler",
  "log", "logging", "observability", "telemetry", "metric", "monitor",
  "http", "client", "sdk", "gateway", "proxy", "webhook",
  "docker", "deploy", "bootstrap", "conftest"
];

/** 以设施词开头但另有业务含义的词元，命中时不算设施。 */
const INFRA_FALSE_TOKENS = new Set(["login", "logins", "logout", "logouts", "logic", "logical"]);

export function isTestPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const base = segments[segments.length - 1];
  if (segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment))) return true;
  return base === "conftest.py" || /^test_.*\.py$/.test(base) || /_test\.(py|go|rb)$/.test(base) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/** 文件名切词元：先按分隔符，再按驼峰边界。 */
function fileNameTokens(path: string): string[] {
  const base = path.split("/").pop() ?? path;
  return base.split(/[^A-Za-z0-9]+/).flatMap((segment) => segment.split(/(?=[A-Z])/)).map((token) => token.toLowerCase()).filter(Boolean);
}

/** 设施名按文件名词元匹配，不看目录名。 */
function hasInfraHint(path: string): boolean {
  return infraHintOf(path).hint !== undefined;
}

/** 命中的设施名与文件名词元。 */
export function infraHintOf(path: string): { hint?: string; tokens: string[] } {
  const tokens = fileNameTokens(path);
  return { hint: INFRA_HINTS.find((candidate) => tokens.some((token) => token.startsWith(candidate) && !INFRA_FALSE_TOKENS.has(token))), tokens };
}

export function classifyFileRoles(structure: FileStructure): Map<string, FileRole> {
  const { dependencies, dependents, dispatchTouches } = buildFileEdges(structure);
  const entryPaths = new Set(structure.entrypoints.map((anchor) => anchor.path));
  const entryDependencies = entryDependenciesOf(structure);

  const roles = new Map<string, FileRole>();
  for (const file of structure.files) {
    const path = file.path;
    if (isTestPath(path)) roles.set(path, "test");
    else if (entryPaths.has(path)) roles.set(path, "core");
    else if (hasInfraHint(path)) roles.set(path, "infra");
    else if (entryDependencies.has(path)) roles.set(path, "core");
    else if (!dependencies.get(path)?.size && !dependents.get(path)?.size && !dispatchTouches.has(path)) roles.set(path, "tool");
    else roles.set(path, "support");
  }
  return roles;
}

/** 某个文件的角色；未索引的按 support。 */
export function roleOf(roles: Map<string, FileRole>, path: string): FileRole {
  return roles.get(path) ?? "support";
}

/** 从索引文件清单与依赖图拼出结构输入，含 Map 到普通对象的转换。 */
export function fileStructureOf(
  files: FileStructure["files"],
  graph: { symbols: SymbolInfo[]; calls: CallEdge[]; imports: Map<string, string[]>; entrypoints: SourceAnchor[]; dispatch?: TypeDispatchEdge[] }
): FileStructure {
  return {
    files,
    symbols: graph.symbols,
    calls: graph.calls,
    imports: Object.fromEntries(graph.imports),
    entrypoints: graph.entrypoints,
    ...(graph.dispatch?.length ? { dispatch: graph.dispatch } : {})
  };
}


