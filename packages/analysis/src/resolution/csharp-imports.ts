/** C# 的 using 指向命名空间：全仓建「命名空间 → 文件」索引，块式与文件式声明都收。 */
export function extractCSharpSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^using\s+(?:static\s+)?(?:[\w]+\s*=\s*)?([A-Za-z_][\w.]*);/);
    if (match) specifiers.push(match[1]);
  }
  return specifiers;
}

export function collectCSharpNamespaces(contents: Map<string, string>): Map<string, string[]> {
  const byNamespace = new Map<string, string[]>();
  for (const [path, content] of contents) {
    if (!path.endsWith(".cs")) continue;
    for (const match of content.matchAll(/^\s*namespace\s+([A-Za-z_][\w.]*)/gm)) {
      const list = byNamespace.get(match[1]) ?? [];
      if (!list.includes(path)) list.push(path);
      byNamespace.set(match[1], list);
    }
  }
  return byNamespace;
}

export function resolveCSharpImport(specifier: string, namespaces: Map<string, string[]>): string[] {
  let current = specifier;
  for (;;) {
    const hit = namespaces.get(current);
    if (hit) return hit;
    const cut = current.lastIndexOf(".");
    if (cut < 0) return [];
    current = current.slice(0, cut);
  }
}

