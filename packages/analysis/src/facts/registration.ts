import type { RegistryEntry, RegistryFileFact, RegistryKind } from "@codebase-tutor/domain";

import { extractRouteEndpoints } from "../entrypoints/url-routes.js";
import { FACTS_VERSION } from "./version.js";

/**
  注册与配置索引：运行时才连上的关系（注解注入、`app.use`、SPI 清单）。
  配置文件只记键名，不记值。
  路由判据复用 `entrypoints/url-routes.ts`，每条带 `via` 说明识别来源。
*/

const MAX_ENTRIES = 200;

/** 表示「容器接管此类或方法」的注解。 */
const SPRING_COMPONENT = /@(Service|Component|Repository|Controller|RestController|Configuration|Mapper|FeignClient|Aspect)\b/;
const SPRING_INJECT = /@(Autowired|Resource|Inject|Qualifier)\b/;
const DI_CALL = /\.Add(Scoped|Singleton|Transient|KeyedScoped|KeyedSingleton|KeyedTransient)\s*(?:<([^>]+)>)?\s*\(([^)]*)\)/g;
const JS_REGISTER = /\b(?:app|server|router|instance|fastify|koa|express)\s*\.\s*(use|register|plugin|route|mount)\s*\(\s*(?:["'`]([^"'`]*)["'`])?([^)]{0,40})/g;
const GO_REGISTER = /\b(?:http\.HandleFunc|http\.Handle|(?:mux|router|r|e|engine|group)\.(Get|Post|Put|Delete|Patch|Handle|Any|Group))\s*\(\s*["'`]([^"'`]*)["'`]/g;
const PY_REGISTER = /\b(?:app|router|blueprint)\s*\.\s*(register_blueprint|include_router|add_url_rule|mount)\s*\(\s*([A-Za-z_][\w.]*)/g;
const RUST_REGISTER = /\.(?:route|layer|nest)\s*\(\s*["'`]([^"'`]*)["'`]/g;

/** 清单与配置文件白名单：仅这些非源码文件进注册索引。 */
const MANIFEST_KEYS: Record<string, { pattern: RegExp; kind: RegistryKind; via: string; group: number }[]> = {
  "package.json": [
    { pattern: /^\s{2}"(main|module|type|bin|exports|workspaces)"\s*:/, kind: "manifest", via: "package.json 字段名", group: 1 },
    { pattern: /^\s{4}"([\w:.-]+)"\s*:\s*"/, kind: "manifest", via: "package.json 脚本名（命令体不抄）", group: 1 }
  ],
  "tsconfig.json": [
    { pattern: /^\s{4}"([^"]+)"\s*:/, kind: "manifest", via: "tsconfig 键（paths 别名与源码范围）", group: 1 }
  ],
  "pom.xml": [
    { pattern: /<module>([^<]+)<\/module>/, kind: "manifest", via: "pom 子模块", group: 1 },
    { pattern: /<(artifactId|groupId|packaging)>/, kind: "manifest", via: "pom 坐标字段名（值不抄）", group: 1 }
  ],
  "build.gradle": [{ pattern: /srcDirs?\s*=?\s*\[?['"]([^'"]+)['"]/, kind: "manifest", via: "gradle 源码目录", group: 1 }],
  "settings.gradle": [{ pattern: /include\s+['"]([^'"]+)['"]/, kind: "manifest", via: "gradle 子项目", group: 1 }],
  "go.mod": [{ pattern: /^\s*module\s+(\S+)/, kind: "manifest", via: "go.mod 模块路径（划仓内边界的依据）", group: 1 }],
  "Cargo.toml": [
    { pattern: /^\s*\[\s*(lib|workspace)\b/, kind: "manifest", via: "Cargo 段", group: 1 },
    { pattern: /^\s*name\s*=\s*"([^"]+)"/, kind: "manifest", via: "Cargo 目标名", group: 1 }
  ],
  "pyproject.toml": [{ pattern: /^\s*\[\s*(project|build-system|tool\.\w+)\]/, kind: "manifest", via: "pyproject 段", group: 1 }],
  "requirements.txt": [{ pattern: /^\s*([A-Za-z0-9_.-]+)/, kind: "manifest", via: "依赖声明行（只取包名）", group: 1 }],
};

/** 是否进注册索引：代码文件与清单文件都要。 */
export function registryEligible(path: string, inGraph: boolean): boolean {
  return inGraph || isManifest(path);
}

function push(rows: RegistryEntry[], entry: RegistryEntry): void {
  if (rows.length >= MAX_ENTRIES) return;
  if (rows.some((item) => item.kind === entry.kind && item.name === entry.name && item.line === entry.line)) return;
  rows.push(entry);
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim().replace(/^["'`]|["'`]$/g, "").replace(/[,{]\s*$/, "");
  return trimmed && trimmed.length <= 120 ? trimmed : undefined;
};

/** Java/C# 的字段注入与构造注入：接口名映射到字段名。 */
function injectionEntries(lines: string[], language: string): RegistryEntry[] {
  const rows: RegistryEntry[] = [];
  const declaration = language === "java"
    ? /^\s*(?:private|protected|public)?\s*(?:final\s+)?([A-Z][\w<>, .]*?)\s+([a-z]\w*)\s*[;=]/
    : /^\s*(?:private|protected|public|internal)?\s*(?:readonly\s+)?([A-Z][\w<>, .]*?)\s+([A-Z]\w*)\s*[;{=]/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (SPRING_INJECT.test(line)) {
      for (let next = index + 1; next <= Math.min(lines.length - 1, index + 3); next += 1) {
        const body = lines[next] ?? "";
        if (!/\S/.test(body) || SPRING_INJECT.test(body)) continue;
        const match = declaration.exec(body);
        const type = clean(match?.[1]);
        if (type) {
          push(rows, { kind: "di-binding", name: type.split("<")[0].trim(), target: clean(match?.[2]), via: "字段注入注解", line: next + 1 });
          if (type.includes("<")) push(rows, { kind: "di-binding", name: type.replace(/^[^<]*</, "").replace(/>.*$/, "").trim(), target: clean(match?.[2]), via: "字段注入注解的泛型实参", line: next + 1 });
        }
        break;
      }
    }
    const constructor = /^\s*(?:public|protected|private)?\s*([A-Z]\w*)\s*\(([^)]*)\)\s*\{?\s*$/.exec(line);
    if (constructor && constructor[1] === (lines.slice(0, index).map((item) => /(?:class|interface|record|enum)\s+(\w+)/.exec(item)?.[1]).filter(Boolean).pop() ?? "")) {
      for (const param of (constructor[2] ?? "").split(",")) {
        const type = clean(param.replace(/@\w+(\([^)]*\))?\s*/g, "").split(/\s+/).filter(Boolean)[0]);
        if (type && /^[A-Z]/.test(type)) push(rows, { kind: "di-binding", name: type, via: "构造注入", line: index + 1 });
      }
    }
  }
  return rows;
}

/** yml 键按缩进把父级拼回全名。 */
function yamlKeys(lines: string[]): RegistryEntry[] {
  const rows: RegistryEntry[] = [];
  const stack: { indent: number; key: string }[] = [];
  lines.forEach((line, offset) => {
    if (/^\s*#/.test(line) || !/\S/.test(line)) return;
    const match = /^(\s*)([\w.[\]-]+)\s*:(?![\w.])/u.exec(line) ?? /^(\s*)([\w.[\]-]+)\s*:(\s|$)/u.exec(line);
    if (!match) return;
    const indent = match[1].length;
    const key = match[2];
    while (stack.length && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
    push(rows, { kind: "config-key", name: [...stack.map((item) => item.key), key].join("."), via: "配置键（值不进产物）", line: offset + 1 });
    // 冒号后为空表示父级，下一层缩进的键挂在它下面
    if (!line.slice(match[0].length).trim()) stack.push({ indent, key });
  });
  return rows;
}

/** 清单与配置文件：只取键与结构名。 */
function manifestEntries(path: string, lines: string[]): RegistryEntry[] {
  const rows: RegistryEntry[] = [];
  const tail = path.split("/").pop() ?? path;
  const table = [
    ...(MANIFEST_KEYS[tail] ?? []),
    ...(/\.csproj$/.test(tail) ? [{ pattern: /<(ProjectReference|PackageReference)\s+Include="([^"]+)"/, kind: "manifest" as const, via: "csproj 引用", group: 2 }] : []),
    ...(/\.sln$/.test(tail) ? [{ pattern: /^Project\("[^"]*"\)\s*=\s*([^,]+),/, kind: "manifest" as const, via: "解决方案项目", group: 1 }] : []),
    ...(/\.properties$/.test(tail) ? [{ pattern: /^\s*([\w.[\]-]+)\s*[:=]/, kind: "config-key" as const, via: "配置键（值不进产物）", group: 1 }] : []),
    ...(tail === "spring.factories" ? [{ pattern: /^\s*([\w.$]+)\s*=/, kind: "di-binding" as const, via: "spring.factories 键", group: 1 }] : [])
  ];
  lines.forEach((line, offset) => {
    if (/^\s*#/.test(line)) return;
    for (const rule of table) {
      const match = rule.pattern.exec(line);
      const name = clean(match?.[rule.group]);
      if (name) push(rows, { kind: rule.kind, name, via: rule.via, line: offset + 1 });
    }
  });
  if (/\.(yml|yaml)$/.test(tail)) rows.push(...yamlKeys(lines));
  if (path.includes("META-INF/services/")) {
    lines.forEach((line, offset) => {
      if (/^\s*#/.test(line)) return;
      const impl = clean(line);
      if (impl) push(rows, { kind: "di-binding", name: tail, target: impl, via: "SPI 清单（ServiceLoader）", line: offset + 1 });
    });
  }
  return rows;
}

/** 清单类文件名：MANIFEST_KEYS 的键加按后缀识别的几类。 */
function isManifest(path: string): boolean {
  const tail = path.split("/").pop() ?? path;
  return path.includes("META-INF/services/") || Object.hasOwn(MANIFEST_KEYS, tail) || /\.(csproj|sln)$/.test(tail) || (/\.(yml|yaml|properties)$/.test(tail) && /^(application|config|bootstrap)/.test(tail));
}

/** 一个文件的注册与配置索引；清单文件没有语法树，`backend` 记为 `none`。 */
export function analyzeFileRegistry(path: string, content: string, language: string, isCode: boolean): RegistryFileFact {
  const lines = content.split("\n");
  const entries: RegistryEntry[] = [];
  if (isCode) {
    const endpoints = extractRouteEndpoints(new Map([[path, content]]));
    for (const provider of endpoints.providers) push(entries, { kind: "route", name: provider.route, via: `${provider.framework} 路由声明`, line: provider.line });
    for (const consumer of endpoints.consumers) push(entries, { kind: "route-consumer", name: consumer.route, target: consumer.raw, via: "前端调用点", line: consumer.line });
    if (language === "java" || language === "csharp") {
      for (const entry of injectionEntries(lines, language)) push(entries, entry);
      lines.forEach((line, offset) => {
        const component = SPRING_COMPONENT.exec(line);
        if (component) {
          const owner = lines.slice(0, offset + 6).reverse().find((item) => /(?:class|interface|enum|record)\s+(\w+)/.test(item));
          const name = /(?:class|interface|enum|record)\s+(\w+)/.exec(owner ?? "")?.[1];
          if (name) push(entries, { kind: "registration", name, via: `@${component[1]} 组件声明`, line: offset + 1 });
        }
        const bean = /@Bean\b/.exec(line);
        if (bean) {
          const method = lines.slice(offset + 1, offset + 4).map((item) => /^\s*(?:public\s+)?[\w<>, .]+\s+(\w+)\s*\(/.exec(item)?.[1]).find(Boolean);
          if (method) push(entries, { kind: "registration", name: method, via: "@Bean 工厂方法", line: offset + 1 });
        }
        const scan = /@(ComponentScan|MapperScan|EnableAutoConfiguration|SpringBootApplication)\b/.exec(line);
        if (scan) push(entries, { kind: "config-key", name: `@${scan[1]}`, via: "扫描开关", line: offset + 1 });
      });
      for (const match of content.matchAll(DI_CALL)) {
        const index = content.slice(0, match.index ?? 0).split("\n").length;
        // 两种写法：`AddScoped<I, X>()`（实现在尖括号里）与 `AddScoped<I>(sp => sp.GetRequiredService<X>())`
        const [first, second] = (match[2] ?? "").split(",").map((part) => clean(part));
        const argument = clean((match[3] ?? "").split(/[,=]/)[0]);
        push(entries, { kind: "di-binding", name: first ?? argument ?? "?", target: second ?? (first ? argument : undefined), via: `Add${match[1]} 注册`, line: index });
      }
    }
    for (const [pattern, via] of [[JS_REGISTER, "app.use / register 调用"], [GO_REGISTER, "Go 路由登记"], [PY_REGISTER, "Python 蓝图/路由登记"], [RUST_REGISTER, "Rust 路由/层登记"]] as [RegExp, string][]) {
      for (const match of content.matchAll(new RegExp(pattern.source, "g"))) {
        const index = content.slice(0, match.index ?? 0).split("\n").length;
        const name = clean(match[2]) ?? clean(match[1]) ?? clean(match[3]);
        if (!name) continue;
        const kind: RegistryKind = /^\/|\w+\/\w/.test(name) && via !== "app.use / register 调用" ? "route" : "registration";
        push(entries, { kind, name, via, line: index });
      }
    }
    lines.forEach((line, offset) => {
      const apps = /^\s*(INSTALLED_APPS|MIDDLEWARE)\s*=\s*\[/;
      if (apps.test(line)) push(entries, { kind: "config-key", name: line.match(/\w+(?=\s*=)/)?.[0] ?? "", via: "Django 设置项", line: offset + 1 });
    });
  }
  for (const entry of manifestEntries(path, lines)) push(entries, entry);
  return {
    path,
    language,
    backend: isCode ? "ast" : "none",
    version: FACTS_VERSION,
    entries: entries.sort((left, right) => left.line - right.line),
    ...(entries.length >= MAX_ENTRIES ? { skipped: [{ name: path, reason: `登记条目达到 ${MAX_ENTRIES} 条上限，只留前面这些` }] } : {})
  };
}

