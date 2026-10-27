import type { CallEdge, SymbolInfo } from "@codebase-tutor/domain";

import { javaVisibleTypes, stripJavaNoise } from "./java-types.js";

const ignoredCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "require", "import"]);

/**
  接收者名 → 它可能有的声明类型（一个名字可以有多个）：字段、方法参数、局部变量三种声明形状，
  `private final OrderMapper mapper`、`void write(ErrorCode errorCode)`、`StringBuilder sb = new ...`。

  要解到这个程度是因为 Spring 代码里的调用几乎全是 `service.query(...)` 这种小写变量接收者，
  只认类名接收者就等于看不见它们；只解字段又会丢掉经方法参数进来的真边，所以三类声明一起解才算完整。
  一个名字留多个类型：同一个变量名在不同方法里声明成不同类型是真事
  （`status` 既可能是 `OrderStatus` 也可能是 `PayType`），只留最后一个会凭空丢边。
  解不出类型的接收者仍走裸名匹配（`this.foo()`、链式中间段都不挡）。
*/
function javaReceiverTypes(content: string): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  const patterns = [
    // 字段：访问修饰符开头，名字后面跟 `=` 或 `;`（`(` 是方法声明，不能算字段）
    /^\s*(?:private|protected|public)\s+(?:static\s+|final\s+|transient\s+|volatile\s+)*([A-Z]\w*)(?:<[^>]*>)?\s+([a-z_]\w*)\s*[=;]/gm,
    // 方法参数：括号与逗号之间「类型 名字」
    /[(,]\s*([A-Z]\w*)(?:<[^>]*>)?\s+([a-z_]\w*)\s*[,)]/g,
    // 局部变量声明：行首是类型 + 名字 + `=`
    /^\s*(?:final\s+)?([A-Z]\w*)(?:<[^>]*>)?\s+([a-z_]\w*)\s*=/gm
  ];
  const add = (name: string, type: string): void => {
    const list = declared.get(name) ?? [];
    if (!list.includes(type)) list.push(type);
    declared.set(name, list);
  };
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) add(match[2], match[1]);
  }
  return declared;
}

export function extractCalls(contents: Map<string, string>, symbols: SymbolInfo[], imports: Map<string, string[]>, javaTypes: Map<string, string>): CallEdge[] {
  const byName = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol]);
  const edges: CallEdge[] = [];
  for (const [path, content] of contents) {
    const localSymbols = symbols.filter((symbol) => symbol.path === path);
    const imported = new Set(imports.get(path) ?? []);
    // 只有 Java 走接收者判定：这门语言有「类名=文件名」的强约定，而且符号级参照也只覆盖了它
    const isJava = path.endsWith(".java");
    /**
      Java 的调用扫描读「清除注释与 import 行」的正文：注释里的 `voucherOrderService.handle(orderId)`
      是一句说明，不是调用证据，javadoc 里的流程图照样能给它连出几条假边。
      `stripJavaNoise` 用等长空格替换，所以行号与原文一一对应。
      其他语言的注释（`#`、`--`）暂不抹：符号级参照只覆盖了 Java，改动无法用参照校验。
    */
    const body = isJava ? stripJavaNoise(content) : content;
    const receivers = isJava ? javaVisibleTypes(path, content, javaTypes) : undefined;
    const declaredTypes = receivers ? javaReceiverTypes(body) : undefined;
    const lines = body.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:const|let|var)\b.*=>|^\s*(?:async\s+)?def\b|^\s*func\b|^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:unsafe\s+)?(?:async\s+)?fn\b/.test(line)) continue;
      // Java 方法/构造器声明行也含「名字(」——不跳过会产生自我调用边
      if (/^\s*(?:@\w+\s*)?(?:(?:public|private|protected|static|final|abstract|synchronized|default|native)\s+)+[\w<>\[\],.?\s]+\(/.test(line)) continue;
      for (const match of line.matchAll(/\b(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        const receiver = match[1];
        const name = match[2];
        if (ignoredCalls.has(name)) continue;
        const candidates = byName.get(name) ?? [];
        let target: SymbolInfo | undefined;
        // 接收者先换成声明类型：大写的本身就是类型；小写的要靠字段 / 参数 / 局部变量声明换
        // （`mapper.insert(` → `OrderMapper`）。换不出就走裸名老路，`this.foo()` 与链式中间段都不挡。
        const receiverTypes = receiver ? (/^[A-Z]/.test(receiver) ? [receiver] : declaredTypes?.get(receiver)) : undefined;
        const typedTargets: SymbolInfo[] = [];
        if (receivers && receiverTypes?.length) {
          // 接收者是仓内可见类型 ⇒ 只认它声明的那个方法。找不到就不退回裸名匹配：
          // 继承来的方法会因此漏一条，但把「另一个文件里撞名的方法」当成调用落点是更坏的结果
          const typedFiles = new Set(receiverTypes.map((type) => receivers.get(type)).filter((file): file is string => Boolean(file)));
          typedTargets.push(...candidates.filter((symbol) => typedFiles.has(symbol.path)));
          if (!typedTargets.length) continue;
          target = typedTargets[0];
        } else {
          target = candidates.find((symbol) => symbol.path === path) ?? candidates.find((symbol) => imported.has(symbol.path));
        }
        if (!target) continue;
        const caller = [...localSymbols].reverse().find((symbol) => symbol.line <= index + 1 && symbol.endLine >= index + 1);
        /**
          声明行自己不算调用。上面两条跳过判据都要 Java 修饰符或声明关键字，管不到接口里的
          `String submit();`（无修饰符）和包私有构造器 `Foo()`——它们在声明行上匹配到「名字(」，
          又在同文件候选里落回自己，于是产出一条「它调用它自己」的假边。
          只挡「函数体左括号之前」那一处：`int f(int n) { return n * f(n - 1); }` 这种单行函数
          的真递归写在 `{` 之后，一刀切按行跳过会把它一起吃掉。
        */
        const bodyStart = line.indexOf("{");
        if (caller && !receiver && caller.line === index + 1 && caller.name === name && (bodyStart === -1 || match.index < bodyStart)) continue;
        for (const callee of (typedTargets.length ? typedTargets : [target])) {
          edges.push({ callerPath: path, callerSymbol: caller?.id, calleePath: callee.path, calleeSymbol: callee.id, line: index + 1 });
        }
      }
    }
  }
  return dedupeCalls(edges);
}

function dedupeCalls(calls: CallEdge[]): CallEdge[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.callerPath}:${call.callerSymbol ?? ""}:${call.calleePath}:${call.calleeSymbol ?? ""}:${call.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
