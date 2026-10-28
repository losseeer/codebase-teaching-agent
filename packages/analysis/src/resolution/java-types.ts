import { basename } from "node:path";
import type { TypeDispatchEdge } from "@codebase-tutor/domain";

/** 接收者类型名到仓内文件的可见表：显式 import（含通配）加同包可见。 */
export function javaVisibleTypes(path: string, content: string, javaTypes: Map<string, string>): Map<string, string> {
  const packagePart = (fqn: string): string => fqn.slice(0, fqn.lastIndexOf("."));
  const ownPackage = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/m.exec(content)?.[1];
  const ownRoot = javaSourceRootOf(path);
  const visible = new Map<string, string>();
  /** `requireSameRoot` 只约束按包名推断的两条路；显式 import 跨模块也收。 */
  const add = (target: string | undefined, requireSameRoot: boolean): void => {
    if (!target || target === path) return;
    if (requireSameRoot && javaSourceRootOf(target) !== ownRoot) return;
    visible.set(basename(target, ".java"), target);
  };
  for (const item of extractJavaSpecifiers(content)) {
    if (item.wildcard) {
      for (const [fqn, target] of javaTypes) if (packagePart(fqn) === item.specifier) add(target, true);
      continue;
    }
    add(resolveJavaImport(item.specifier, javaTypes), false);
  }
  if (ownPackage) for (const [fqn, target] of javaTypes) if (packagePart(fqn) === ownPackage) add(target, true);
  return visible;
}

/** 注释与 import 按等长空格清除，行数与字符偏移不变。 */
export function stripJavaNoise(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length))
    .replace(/^[ \t]*import[ \t][^\n]*$/gm, (line) => " ".repeat(line.length));
}

/** 反复剥掉最内层尖括号：括号里的名字不是父类型。 */
function stripJavaGenerics(head: string): string {
  let previous = head;
  for (;;) {
    const next = previous.replace(/<[^<>]*>/g, " ");
    if (next === previous) return next;
    previous = next;
  }
}

/** Java 类头的 `extends`/`implements` 落点：接口与实现关系的近似证据。 */
export function extractJavaDispatch(path: string, content: string, javaTypes: Map<string, string>): TypeDispatchEdge[] {
  const visible = javaVisibleTypes(path, content, javaTypes);
  const body = stripJavaNoise(content);
  const edges: TypeDispatchEdge[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)([^{;]*)/g)) {
    const head = stripJavaGenerics(match[2] ?? "");
    const implementsAt = /\bimplements\b/.exec(head);
    const extendsAt = /\bextends\b/.exec(head);
    const line = body.slice(0, match.index ?? 0).split("\n").length;
    const clauses: { kind: TypeDispatchEdge["kind"]; text: string }[] = [];
    if (extendsAt) {
      const from = extendsAt.index + "extends".length;
      const to = implementsAt && implementsAt.index > extendsAt.index ? implementsAt.index : head.length;
      clauses.push({ kind: "extends", text: head.slice(from, to) });
    }
    if (implementsAt) clauses.push({ kind: "implements", text: head.slice(implementsAt.index + "implements".length) });
    for (const clause of clauses) {
      for (const raw of clause.text.split(",")) {
        const name = raw.trim();
        if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) continue;
        const simple = name.split(".").pop()!;
        if (simple === match[1]) continue;
        const target = (name.includes(".") ? resolveJavaImport(name, javaTypes) : undefined) ?? visible.get(simple);
        if (!target || target === path) continue;
        const key = `${clause.kind}:${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ subtypePath: path, supertypePath: target, kind: clause.kind, line });
      }
    }
  }
  return edges;
}

/** Java 的 import 语句：普通、static、通配三种形式，通配留 `wildcard` 标记。 */
export function extractJavaSpecifiers(content: string): { specifier: string; wildcard: boolean }[] {
  const specifiers: { specifier: string; wildcard: boolean }[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^import\s+(?:static\s+)?([A-Za-z_]\w*(?:\.\w+)*)(\.\*)?\s*;/);
    if (match) specifiers.push({ specifier: match[1], wildcard: Boolean(match[2]) });
  }
  return specifiers;
}

/** Java 源码根（`src/main`/`src/test`）；认不出布局时返回空串，整仓算一个编译范围。 */
export function javaSourceRootOf(path: string): string {
  const match = /(^|\/)src\/(main|test)\//.exec(path);
  return match ? `${path.slice(0, match.index)}src/${match[2]}` : "";
}

/** 全仓全限定类名到文件路径的索引，依据 public 类名与文件名一致的约定。 */
export function collectJavaTypes(contents: Map<string, string>): Map<string, string> {
  const types = new Map<string, string>();
  for (const [path, content] of contents) {
    if (!path.endsWith(".java")) continue;
    const pkg = content.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m)?.[1];
    if (pkg) types.set(`${pkg}.${basename(path, ".java")}`, path);
  }
  return types;
}

/** 类名精确命中即返回，未命中逐段去掉尾部再试，覆盖静态导入与嵌套类。 */
export function resolveJavaImport(specifier: string, javaTypes: Map<string, string>): string | undefined {
  let current = specifier;
  for (;;) {
    const hit = javaTypes.get(current);
    if (hit) return hit;
    const cut = current.lastIndexOf(".");
    if (cut < 0) return undefined;
    current = current.slice(0, cut);
  }
}

