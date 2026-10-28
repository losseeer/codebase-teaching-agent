import type { SourceAnchor } from "@codebase-tutor/domain";

import { extractMultilineTemplateLines } from "../extraction/parser.js";

/**
  Node/TS 侧框架入口识别：Express、Fastify、Koa、NestJS。
  只认框架实例名上的 `.get/.post/.listen`；框架名只认 import/require 位置的包名；证据行须是代码。
  每个文件取最先命中的一行证据。
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
    // 语法树不可用时整文件不判，避免把模板串里的示例源码认成入口
    const templates = extractMultilineTemplateLines(path, content);
    if (!templates) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
      if (templates.has(index + 1)) continue;
      // Nest 装饰器需同文件有 @Controller 才算路由
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

/** 被赋成服务实例的名字。 */
function nodeInstanceNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(nodeInstancePattern)) if (match[1]) names.add(match[1]);
  return names;
}

/** 框架名只取 import/require 位置的包名。 */
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

