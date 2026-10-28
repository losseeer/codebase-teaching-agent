/** 说明符切包名身份：python 第一段、java/csharp 前四段、go 域名式前三段否则第一段、node 首段（scope 两段）。 */
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

/** Go 的仓内判据与 `resolveGoImport` 共用 go.mod 前缀。 */
export function coveredByGoModule(specifier: string, goModules: Map<string, string>): boolean {
  return [...goModules.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** 仓内包根集合：已知全限定名的前 2~3 段，不含顶级域那一段。 */
export function packageRoots(names: Iterable<string>, separator = "."): Set<string> {
  const roots = new Set<string>();
  for (const name of names) {
    const segments = name.split(separator).filter(Boolean);
    for (let depth = 2; depth <= Math.min(3, segments.length); depth += 1) roots.add(segments.slice(0, depth).join(separator));
  }
  return roots;
}

/** 说明符前 2~3 段命中仓内包根，即视为本项目自己的包。 */
export function coveredByPackageRoot(roots: Set<string>, specifier: string): boolean {
  const segments = specifier.split(".").filter(Boolean);
  for (let depth = 2; depth <= Math.min(3, segments.length); depth += 1) if (roots.has(segments.slice(0, depth).join("."))) return true;
  return false;
}

