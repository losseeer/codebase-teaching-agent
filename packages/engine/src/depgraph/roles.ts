import type { CallEdge, FileRole, SourceAnchor, SymbolInfo, TypeDispatchEdge } from "@codebase-tutor/shared";

/**
  文件角色的结构分类：只用符号表、调用边、import 边、类型派发边与入口清单，不调模型。
  角色要落进缓存、被画布边的证据核验引用，来源必须与模型配置无关；
  「这个文件在讲什么」是职责摘要的事，「它在图上处在哪个位置」是结构问题。

  口径（按顺序判定，先命中先用）：
  1. 测试路径 → test
  2. 入口文件 → core
  3. 文件名成词命中设施类词（配置、存储、缓存、日志、可观测、网络客户端、队列、部署…）→ infra
  4. 被任一入口直接依赖（import、调用，或经接口派发到实现这一拍）→ core
  5. 既不依赖别人、也不被别人依赖、也没有类型派生关系 → tool
  6. 其余 → support

  第 3 步排在第 4 步之前是有意的：被服务类用着的配置类仍然是配置，不该因为「入口用到了它」就升成主干。
  这条顺序只在词表误命中时才有影响，防误判靠词形判据与黑名单（见 `hasInfraHint`），不靠换序。
*/

export interface FileStructure {
  /** 仓库内被索引的文件（用路径与行数）。 */
  files: { path: string; lines: number }[];
  symbols: SymbolInfo[];
  calls: CallEdge[];
  imports: Record<string, string[]>;
  /** 全部入口：角色按「被任一入口依赖」判，与「这次看的是哪个入口」无关。 */
  entrypoints: SourceAnchor[];
  /** 类型派发边（实现/子类 → 接口/父类）；缺省表示没有这一类关系。 */
  dispatch?: TypeDispatchEdge[];
}

/**
  文件级依赖双向表：import 边加上跨文件调用边，两条边都算「依赖」，让「谁依赖谁」在同一口径下回答。

  类型派发边不进 `dependencies`/`dependents`：接口与实现之间是运行时派发，不是「谁依赖谁」，
  混进依赖流会把方向说反。它单独走 `dispatches`，只用于入口可达性的透传与孤立性判据。
*/
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

/**
  入口的「直接依赖」集合，含类型派发透传：控制器注入接口、运行时打到实现，
  这一拍在源码里没有调用行，但属于同一次请求，所以接口算一跳、实现下面的 Mapper 仍算二跳。
  透传可以连着走（抽象类再被抽象类继承），但不沿普通依赖延伸——否则整仓都会被拉成主干。
*/
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
  设施类词：命中即认作「与外部世界或运行环境打交道」。粗分类，宁可漏判也不把业务逻辑误判成设施，
  因此只收公认的设施名，不收 `core`/`util` 这类泛词。
  `export` 只为诊断脚本（`src/scripts/tier-diag.ts`）能复算命中位置，生产判据走 `hasInfraHint`。
*/
export const INFRA_HINTS = [
  "config", "setting", "env", "credential", "secret",
  "database", "db", "store", "storage", "sql", "mysql", "postgres", "redis", "mongo",
  "cache", "queue", "kafka", "mq", "scheduler",
  "log", "logging", "observability", "telemetry", "metric", "monitor",
  "http", "client", "sdk", "gateway", "proxy", "webhook",
  "docker", "deploy", "bootstrap", "conftest"
];

/**
  以设施词开头、但在业务代码里另有常见含义的词元：`login`/`logout`（登录登出）、`logic`/`logical`（业务逻辑）。
  `store`（门店 vs 存储）不进这张表——挡了它就等于挡掉真正的存储层，只能留着当已知残留。
*/
const INFRA_FALSE_TOKENS = new Set(["login", "logins", "logout", "logouts", "logic", "logical"]);

export function isTestPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const base = segments[segments.length - 1];
  if (segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment))) return true;
  return base === "conftest.py" || /^test_.*\.py$/.test(base) || /_test\.(py|go|rb)$/.test(base) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/** 文件名切成词元：先按分隔符，再按驼峰边界（`PayLogMapper.java` → pay / log / mapper / java）。 */
function fileNameTokens(path: string): string[] {
  const base = path.split("/").pop() ?? path;
  return base.split(/[^A-Za-z0-9]+/).flatMap((segment) => segment.split(/(?=[A-Z])/)).map((token) => token.toLowerCase()).filter(Boolean);
}

/**
  设施名要成词才算，且只看文件名、不看目录名：
  子串判据会把博客（Blog）、登录（Login）、目录（Catalog）、对话（Dialog）判成日志设施；
  只看词头又挡不住 `PayLog`（流水），而目录名会一次判倒一整摞文件——一个类是不是设施该由它自己的名字说。
  代价：只靠目录表达设施身份的 `.../gateway/HealthCheck.java` 这类漏判（按名字落到支撑）；
  `store`（门店 vs 存储）与 `log`（日志 vs 流水）无法两全，留作已知残留。
*/
function hasInfraHint(path: string): boolean {
  return infraHintOf(path).hint !== undefined;
}

/** 命中在哪个设施名上、文件名有哪些词元；供诊断脚本与生产判据共用同一把度量。 */
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

/** 某个文件的角色；不在索引里的一律按 support 处理（调用方不必再判空）。 */
export function roleOf(roles: Map<string, FileRole>, path: string): FileRole {
  return roles.get(path) ?? "support";
}

/**
  从索引文件清单与依赖图拼出结构输入：`DependencyGraph.imports` 是 Map，结构输入要普通对象，
  这层转换收在一处，免得散在各调用点漏转或转错。
*/
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
