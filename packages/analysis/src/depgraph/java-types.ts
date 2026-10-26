import { basename } from "node:path";
import type { TypeDispatchEdge } from "@codebase-tutor/domain";

/**
  Java 的「接收者类型名 → 仓内文件」可见表：`import` 带进来的（含通配）加上同包——
  Java 里同包的类不需要 import 就能用，这一路不能少。

  同源码根才算可见（`src/main` 与 `src/test` 是两个编译范围）：主源码看不见测试源码里的类。
*/
export function javaVisibleTypes(path: string, content: string, javaTypes: Map<string, string>): Map<string, string> {
  const packagePart = (fqn: string): string => fqn.slice(0, fqn.lastIndexOf("."));
  const ownPackage = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/m.exec(content)?.[1];
  const ownRoot = javaSourceRootOf(path);
  const visible = new Map<string, string>();
  /**
    `requireSameRoot` 只对「靠包名猜」的两条路成立（通配 import、同包可见）：多模块仓里
    `module-a/src/main/java/com/x/util` 与 `module-b/src/main/java/com/x/util` 是两个不同的编译单元，
    按包名把它们互相可见就会连出假边。显式 import 是确定的，跨模块也照收——
    把它一起收窄会误挡真边。
    */
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

/**
  注释按等长空格清除、import 整行清除，行数与字符偏移都不变：
  类声明可能出现在 javadoc 的示例里，注释里的 `implements` 不是证据，但行号还得对得上原文。
*/
export function stripJavaNoise(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length))
    .replace(/^[ \t]*import[ \t][^\n]*$/gm, (line) => " ".repeat(line.length));
}

/** 反复剥掉最内层尖括号：`Map<String, Order>` 与 `<T extends Base>` 里的名字都不是父类型。 */
function stripJavaGenerics(head: string): string {
  let previous = head;
  for (;;) {
    const next = previous.replace(/<[^<>]*>/g, " ");
    if (next === previous) return next;
    previous = next;
  }
}

/**
  Java 类头里的 `extends` / `implements` 落点：这是「接口与实现」唯一的静态证据。

  值得单独建一类边：Spring 的控制器注入的是接口，实现类在源码里没有任何调用行，
  import 边走到接口就断，service/impl 与它下面的 mapper 会整片在图上失联。
  落点复用 `javaVisibleTypes`：接口要么显式 import、要么同包，Java 没有第三种可能，所以这条判据不缺证据。
  代价：同名类型（多个模块各有一个 `IUserService`）可能指错，所以它是近似证据、不是权威结论。
*/
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

/**
 * Java 的 import 语句：`import com.a.B;`、`import static com.a.B.C;`、`import com.a.*;`。
 * 通配符要留痕（`wildcard`）：`.*` 剥掉后剩下的是包名，在 `javaTypes` 里没有条目、逐级上溯也落不到，
 * 不留痕就整条丢掉，同包里那些没被显式 import 的类会被误判成孤立文件。
 */
export function extractJavaSpecifiers(content: string): { specifier: string; wildcard: boolean }[] {
  const specifiers: { specifier: string; wildcard: boolean }[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^import\s+(?:static\s+)?([A-Za-z_]\w*(?:\.\w+)*)(\.\*)?\s*;/);
    if (match) specifiers.push({ specifier: match[1], wildcard: Boolean(match[2]) });
  }
  return specifiers;
}

/**
  Java 的源码根：`src/main` 与 `src/test`（Maven/Gradle 布局）是两个编译范围，主源码看不见测试源码里的类。
  通配展开与接收者可见表共用它，两处口径必须一致，否则文件级边和调用级边会互相矛盾。
  认不出 `src/main|test` 的仓返回空串（整个仓算一个编译范围），不是文件自身：
  扁平布局（`com/demo/App.java`、Eclipse 式无 src 的仓）里同包的类本来就互相可见，
  按「每个文件一个根」判会让 `javaSourceRootOf(a) !== javaSourceRootOf(b)` 恒成立，
  于是同包可见与包通配展开整条静默失效。真正的收窄靠包名，这里只负责把 main/test 分开。
*/
export function javaSourceRootOf(path: string): string {
  const match = /(^|\/)src\/(main|test)\//.exec(path);
  return match ? `${path.slice(0, match.index)}src/${match[2]}` : "";
}

/** 全仓「全限定类名 → 文件路径」索引：Java 靠 package 声明 + 文件名（public 类名=文件名约定）建这个映射。 */
export function collectJavaTypes(contents: Map<string, string>): Map<string, string> {
  const types = new Map<string, string>();
  for (const [path, content] of contents) {
    if (!path.endsWith(".java")) continue;
    const pkg = content.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m)?.[1];
    if (pkg) types.set(`${pkg}.${basename(path, ".java")}`, path);
  }
  return types;
}

/**
 * 类名精确命中即返回；未命中逐段去掉尾部再试——覆盖静态导入（`a.b.C.member`）与嵌套类（`a.b.C.D`）。
 * 外部依赖（org.springframework、java.util）不会进索引，天然被过滤。
 */
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
