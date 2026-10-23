import type { SourceAnchor } from "@codebase-tutor/shared";
import { extractMultilineTemplateLines } from "./parser.js";

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

export function detectNodeEntrypoints(contents: Map<string, string>): SourceAnchor[] {
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
