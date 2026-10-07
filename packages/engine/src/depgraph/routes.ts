import { LANGUAGE_CAPABILITIES, type FileEntry, type RouteConsumer, type RouteLink, type RouteProvider } from "@codebase-tutor/shared";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

/**
  跨语言接缝（route seam）：**HTTP 路由字符串**是前端与后端之间唯一共享的标识符——它不产生任何语法级依赖边，
  所以整仓依赖图（L0）天生看不见这条链。这一格补的是「点了按钮之后代码在哪」这类问题的最后一公里。

  纯函数、零 LLM、零 I/O（除最后那个读文件的入口）：输入是 `路径 → 文件内容`，输出是「谁调了哪条路由、落在哪个文件」。
  之所以做成纯函数：接缝的判定必须在**没有仓库上下文**的情况下也能被单测钉住（真值来自 fixture 文本，不靠跑真仓看效果）。

  两条刻意保守的口径，都直接影响误判率：
  - **参数一律折成 `{*}`**（`{id}` / `:id` / `${id}` / Django 的 `<int:id>`），否则 `/blog/likes/12` 这类形态永远对不上；
    代价是 `/user/{id}` 与 `/user/code` 在折参后仍然不同（尾段一个是占位一个是字面量），不会互相误配。
  - **后缀匹配单独标 `via: "suffix"`**：网关或 axios 的 baseURL 会给前端路径加 `/api` 这类前缀，
    整段相等判不住。后缀匹配只在「按 / 分段完整落在尾部」时成立，且必须让调用方知道这条边是后缀配上的——
    它是二档证据，不能和整段相等混成一个数。
*/

const PARAMETER = "{*}";

/** 路由归一化：补前导斜杠、去查询串、折参数、折重复斜杠；末尾斜杠去掉（两边都去，避免 /x 与 /x/ 判成两条）。 */
export function normalizeRoute(input: string): string {
  const clean = input.split("?")[0].split("#")[0];
  const withoutParams = clean
    .replace(/\{[^}]*\}/g, PARAMETER)
    .replace(/<[^>]*>/g, PARAMETER)
    .replace(/\$\{[^}]*\}/g, PARAMETER)
    .replace(/\/:\w+/g, `/${PARAMETER}`)
    .replace(/\/+/g, "/");
  const withSlash = withoutParams.startsWith("/") ? withoutParams : `/${withoutParams}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/$/, "") : withSlash;
  return trimmed === "" ? "/" : trimmed;
}

const segments = (route: string): string[] => route.split("/").filter(Boolean);
/** 后缀匹配：提供方按**整段**落在消费方尾部（`/shop/list` 配 `/api/shop/list`），不做子串匹配。 */
function suffixMatched(provider: string, consumer: string): boolean {
  const tail = segments(provider);
  const head = segments(consumer);
  if (!tail.length || tail.length > head.length) return false;
  return tail.every((segment, index) => segment === head[head.length - tail.length + index]);
}

const annotationPattern = /@(Request|Get|Post|Put|Delete|Patch)Mapping\s*\(([^)]*)\)/g;
const stringLiterals = (source: string): string[] => [...source.matchAll(/["`]([^"`]*)["`]/g)].map((match) => match[1]).filter(Boolean);

/** Java/Spring：类上的 `@RequestMapping` 是基路径，方法上的与之相接；同文件多个方法各自成一条。 */
function springProviders(path: string, content: string): RouteProvider[] {
  const lines = content.split("\n");
  const classLine = lines.findIndex((line) => /^\s*(?:@\w+[^\n]*\n\s*)*(?:public\s+|final\s+|abstract\s+)*(?:class|interface|enum|record)\s/.test(line));
  const base = (): string => {
    if (classLine < 0) return "";
    for (let index = Math.max(0, classLine - 8); index <= classLine; index += 1) {
      const text = lines[index] ?? "";
      const match = /@RequestMapping\s*\(([^)]*)\)/.exec(text);
      if (match) {
        const literal = stringLiterals(match[1] ?? "")[0];
        if (literal) return normalizeRoute(literal);
      }
    }
    return "";
  };
  const prefix = base();
  const found: RouteProvider[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    if (classLine >= 0 && index <= classLine) return; // 类级注解本身不构成一条路由
    for (const match of line.matchAll(annotationPattern)) {
      const literals = stringLiterals(match[2] ?? "");
      if (!literals.length) continue; // 不带路径的 `@GetMapping` 落不出具体串，宁可不产也不猜一条基路径出去
      for (const literal of literals) {
        const route = normalizeRoute(`${prefix}${normalizeRoute(literal)}`);
        const key = `${route}@${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ route, path, line: index + 1, framework: "spring" });
      }
    }
  });
  return found;
}

const decoratorPattern = /@\s*(?:app|router|blueprint|bp)\s*\.\s*(route|get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g;

/** Flask/FastAPI：装饰器即路由；文件里若声明了 `url_prefix` / `APIRouter(prefix=...)` 就当作基路径。 */
function pythonProviders(path: string, content: string): RouteProvider[] {
  const prefixLiteral = /(?:url_prefix|prefix)\s*=\s*["']([^"']+)["']/.exec(content)?.[1];
  const prefix = prefixLiteral ? normalizeRoute(prefixLiteral) : "";
  const found: RouteProvider[] = [];
  const seen = new Set<string>();
  content.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(decoratorPattern)) {
      const kind = match[1]?.toLowerCase();
      const route = normalizeRoute(`${prefix}${normalizeRoute(match[2] ?? "")}`);
      const key = `${route}@${path}@${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ route, path, line: index + 1, framework: kind === "route" ? "flask" : "fastapi" });
    }
  });
  return found;
}

const consumerPattern = /(?:fetch|axios(?:\.\w+)?|\brequest(?:\.\w+)?|\.axios|\bget|\bpost|\bput|\bdelete|url)\s*[:(=]?\s*["'`]([^"'`]+)["'`]/g;
const looksLikeRoute = (candidate: string): boolean => candidate.startsWith("/") && candidate.length > 1 && !candidate.startsWith("//") && /\//.test(candidate.slice(1));

/** 消费方（TS/TSX/JS/Vue）：抓「看起来是绝对路径」的字符串字面量，原始值一并留着。 */
function jsConsumers(path: string, content: string): RouteConsumer[] {
  const found: RouteConsumer[] = [];
  content.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(consumerPattern)) {
      const raw = match[1] ?? "";
      if (!looksLikeRoute(raw)) continue;
      found.push({ route: normalizeRoute(raw), path, line: index + 1, raw });
    }
  });
  return found;
}

/**
  哪些扩展名参与接缝判定——**只列一次**，提供方/消费方的分派与读文件的闸门都从这两组派生。
  复审 #121② 点的是这里过去的写法：`extractRouteEndpoints` 里一条 if 链、`routeEndpointsOfFiles` 里另一条正则，
  同一个问题两份清单；加了 Go 的规则却忘了改正则，Go 的路由就永远读不出来，而且没有任何读数会报这件事。
  扩展名本身取自共享能力表（`vue` 也算消费方：SFC 的 `<script>` 里就是 fetch/axios）。
  ⚠️ 这一改顺带把 `.mjs`/`.cjs` 纳进消费方（旧正则漏了）——两仓实测没有这类文件，接缝读数不变。
*/
const providerExtensions = new Set([...LANGUAGE_CAPABILITIES.java.extensions, ...LANGUAGE_CAPABILITIES.python.extensions]);
const consumerExtensions = new Set([...LANGUAGE_CAPABILITIES.typescript.extensions, ...LANGUAGE_CAPABILITIES.vue.extensions]);
/** 值得为接缝打开的文件（其余连读都不读）。 */
export const routeFileExtensions: readonly string[] = [...providerExtensions, ...consumerExtensions];

/** 从一批文件内容里抽出提供方（Java + Python）与消费方（JS 家族）。 */
export function extractRouteEndpoints(contents: Map<string, string>): { providers: RouteProvider[]; consumers: RouteConsumer[] } {
  const providers: RouteProvider[] = [];
  const consumers: RouteConsumer[] = [];
  for (const [path, content] of contents) {
    // 后缀比较与上面闸门同一份集合：路径没后缀时 extname 给空串，两个集合都不含它，自然跳过
    const extension = extname(path).toLowerCase();
    if (extension === ".java") providers.push(...springProviders(path, content));
    else if (extension === ".py") providers.push(...pythonProviders(path, content));
    else if (consumerExtensions.has(extension)) consumers.push(...jsConsumers(path, content));
  }
  return { providers, consumers };
}

/**
  配对：整段相等优先，配不上再看后缀。返回的每条边都带 `via`，
  以及「这条消费方字符串一共配到几个提供方」——歧义数是要报给用户的数，不是内部细节。
*/
export function matchRouteSeams(providers: RouteProvider[], consumers: RouteConsumer[]): RouteLink[] {
  const byRoute = new Map<string, RouteProvider[]>();
  for (const provider of providers) {
    const list = byRoute.get(provider.route);
    if (list) list.push(provider);
    else byRoute.set(provider.route, [provider]);
  }
  const links: RouteLink[] = [];
  for (const consumer of consumers) {
    const exact = byRoute.get(consumer.route) ?? [];
    const suffix = exact.length ? [] : providers.filter((provider) => provider.route !== consumer.route && suffixMatched(provider.route, consumer.route));
    const candidates = exact.length ? exact : suffix;
    for (const provider of candidates) {
      links.push({ route: consumer.route, consumer, provider, via: exact.length ? "exact" : "suffix", ambiguousWith: candidates.length });
    }
  }
  return links;
}

/** 读文件版的入口（与 `buildDependencyGraph` 同一套用法：仓路径 + 索引到的文件清单）。 */
export function routeEndpointsOfFiles(repositoryPath: string, files: FileEntry[]): { providers: RouteProvider[]; consumers: RouteConsumer[] } {
  const handled = new Set(routeFileExtensions);
  const contents = new Map<string, string>();
  for (const file of files) {
    if (!handled.has(file.extension)) continue;
    try {
      contents.set(file.path, readFileSync(join(repositoryPath, file.path), "utf8"));
    } catch {
      // 读不到就当没有：接缝是加分项，任何一支文件缺失都不能让整张图出不来
    }
  }
  return extractRouteEndpoints(contents);
}

export function linkRouteSeams(endpoints: { providers: RouteProvider[]; consumers: RouteConsumer[] }): RouteLink[] {
  return matchRouteSeams(endpoints.providers, endpoints.consumers);
}
