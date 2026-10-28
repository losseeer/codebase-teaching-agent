import { LANGUAGE_CAPABILITIES, type FileEntry, type RouteConsumer, type RouteLink, type RouteProvider } from "@codebase-tutor/domain";

import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

/**
  跨语言路由接缝：HTTP 路由字符串是前后端共享的标识符，不产生语法级依赖边。
  输入「路径 → 文件内容」，输出「谁调了哪条路由、落在哪个文件」。
  参数一律折成 `{*}`；后缀匹配单独标 `via: "suffix"`，与整段相等分作两档证据。
*/

const PARAMETER = "{*}";

/** 路由归一化：补前导斜杠、去查询串与片段、折参数、折重复斜杠、去末尾斜杠。 */
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
/** 后缀匹配：提供方整段落在消费方尾部，不做子串匹配。 */
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
      if (!literals.length) continue;
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

/** 消费方：抓绝对路径形态的字符串字面量，保留原始值。 */
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
  参与接缝判定的扩展名，取自共享能力表。
  提供方与消费方的分派、读文件的闸门都用这两组。
*/
const providerExtensions = new Set([...LANGUAGE_CAPABILITIES.java.extensions, ...LANGUAGE_CAPABILITIES.python.extensions]);
const consumerExtensions = new Set([...LANGUAGE_CAPABILITIES.typescript.extensions, ...LANGUAGE_CAPABILITIES.vue.extensions]);
/** 需要为接缝读取的扩展名。 */
export const routeFileExtensions: readonly string[] = [...providerExtensions, ...consumerExtensions];

/** 从一批文件内容里抽出提供方（Java + Python）与消费方（JS 家族）。 */
export function extractRouteEndpoints(contents: Map<string, string>): { providers: RouteProvider[]; consumers: RouteConsumer[] } {
  const providers: RouteProvider[] = [];
  const consumers: RouteConsumer[] = [];
  for (const [path, content] of contents) {
    const extension = extname(path).toLowerCase();
    if (extension === ".java") providers.push(...springProviders(path, content));
    else if (extension === ".py") providers.push(...pythonProviders(path, content));
    else if (consumerExtensions.has(extension)) consumers.push(...jsConsumers(path, content));
  }
  return { providers, consumers };
}

/** 配对：整段相等优先，配不上再看后缀；每条边带 `via` 与歧义数。 */
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

/** 读文件版入口：仓路径加索引到的文件清单。 */
export function routeEndpointsOfFiles(repositoryPath: string, files: FileEntry[]): { providers: RouteProvider[]; consumers: RouteConsumer[] } {
  const handled = new Set(routeFileExtensions);
  const contents = new Map<string, string>();
  for (const file of files) {
    if (!handled.has(file.extension)) continue;
    try {
      contents.set(file.path, readFileSync(join(repositoryPath, file.path), "utf8"));
    } catch {
      // 读失败的文件跳过，不中断配对
    }
  }
  return extractRouteEndpoints(contents);
}

