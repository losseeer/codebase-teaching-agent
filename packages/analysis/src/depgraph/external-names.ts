/**
  「仓内解析不到」的说明符 → 边界栏用的包名身份。每种语言按「这个生态里一个包叫什么」来切：
  - python `redis.clients.Redis` → `redis`（PyPI 发行名就是第一段）；
  - java / csharp → 前四段：`org.springframework.data.redis`、`StackExchange.Redis`。
    只切两段会把整个 spring 挤成同一个东西——`spring-data-redis`（数据库）与 `spring-web`（HTTP）
    该不该同栏，差别就在中间这两段；切到类名那一段又会一个类一个身份，四段是最浅的能分开的一层；
  - go 域名式取前三段：`github.com/gin-gonic/gin` 正好三段、原样留下，`github.com/gin-gonic/gin/middleware` → `github.com/gin-gonic/gin`；`fmt` → `fmt`：标准库照实记名，
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

/** Go 的「仓内」判据与 `resolveGoImport` 用同一份 go.mod 前缀，两边口径一致。 */
export function coveredByGoModule(specifier: string, goModules: Map<string, string>): boolean {
  return [...goModules.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
  Java / C# 这一档的「仓内包根」集合：把已知类型全限定名（Java）或已知命名空间（C#）的前 2~3 段收下。
  不含第 1 段：`com` / `org` / `io` / `cn` 是顶级域，不是项目根——收进来会让
  「这个仓的类型在 `org.foo.app` 下」连带把所有 `org.springframework.*` 都说成仓内代码。
  判据不能是「这条 import 能不能落到某个类」：项目自己包根下的类没被索引时照样落不到，
  命中项目自己的包根 = 仓内断链，不记外部名。
*/
export function packageRoots(names: Iterable<string>, separator = "."): Set<string> {
  const roots = new Set<string>();
  for (const name of names) {
    const segments = name.split(separator).filter(Boolean);
    for (let depth = 2; depth <= Math.min(3, segments.length); depth += 1) roots.add(segments.slice(0, depth).join(separator));
  }
  return roots;
}

/** 说明符的前 2~3 段里有任何一个落在仓内包根集合里 = 这是本项目自己的包。 */
export function coveredByPackageRoot(roots: Set<string>, specifier: string): boolean {
  const segments = specifier.split(".").filter(Boolean);
  for (let depth = 2; depth <= Math.min(3, segments.length); depth += 1) if (roots.has(segments.slice(0, depth).join("."))) return true;
  return false;
}
