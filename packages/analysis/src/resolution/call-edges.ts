import type { CallEdge, SymbolInfo } from "@codebase-tutor/domain";

import { javaVisibleTypes, stripJavaNoise } from "./java-types.js";

const ignoredCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "require", "import"]);

/** 接收者名到声明类型的表：字段、方法参数、局部变量三类声明，一个名字可留多个类型。 */
function javaReceiverTypes(content: string): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  const patterns = [
    // 字段：访问修饰符开头，名字后跟 = 或 ;
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
    // 接收者判定只用于 Java
    const isJava = path.endsWith(".java");
    // Java 的扫描正文先清除注释与 import 行，行号与原文一一对应
    // 其他语言的注释不抹：符号级参照只覆盖 Java
    const body = isJava ? stripJavaNoise(content) : content;
    const receivers = isJava ? javaVisibleTypes(path, content, javaTypes) : undefined;
    const declaredTypes = receivers ? javaReceiverTypes(body) : undefined;
    const lines = body.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:const|let|var)\b.*=>|^\s*(?:async\s+)?def\b|^\s*func\b|^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:unsafe\s+)?(?:async\s+)?fn\b/.test(line)) continue;
      // Java 声明行也含「名字(」，不跳过会产出自我调用边
      if (/^\s*(?:@\w+\s*)?(?:(?:public|private|protected|static|final|abstract|synchronized|default|native)\s+)+[\w<>\[\],.?\s]+\(/.test(line)) continue;
      for (const match of line.matchAll(/\b(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        const receiver = match[1];
        const name = match[2];
        if (ignoredCalls.has(name)) continue;
        const candidates = byName.get(name) ?? [];
        let target: SymbolInfo | undefined;
        // 接收者先换成声明类型：大写即类型，小写靠字段/参数/局部变量声明换
        const receiverTypes = receiver ? (/^[A-Z]/.test(receiver) ? [receiver] : declaredTypes?.get(receiver)) : undefined;
        const typedTargets: SymbolInfo[] = [];
        if (receivers && receiverTypes?.length) {
          // 接收者是仓内可见类型时只认它声明的方法，不退回裸名匹配
          const typedFiles = new Set(receiverTypes.map((type) => receivers.get(type)).filter((file): file is string => Boolean(file)));
          typedTargets.push(...candidates.filter((symbol) => typedFiles.has(symbol.path)));
          if (!typedTargets.length) continue;
          target = typedTargets[0];
        } else {
          target = candidates.find((symbol) => symbol.path === path) ?? candidates.find((symbol) => imported.has(symbol.path));
        }
        if (!target) continue;
        const caller = [...localSymbols].reverse().find((symbol) => symbol.line <= index + 1 && symbol.endLine >= index + 1);
        // 声明行不算调用：接口方法与包私有构造器会匹配到「名字(」并落回自己
        // 只挡函数体左括号之前，`{` 之后的真递归要留下
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

