import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImplementationUnit, SymbolInfo } from "@codebase-tutor/shared";

export function buildImplementationUnits(repositoryPath: string, symbols: SymbolInfo[]): ImplementationUnit[] {
  return symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method").map((symbol) => {
    const lines = readFileSync(join(repositoryPath, symbol.path), "utf8").split("\n");
    const body = lines.slice(symbol.line - 1, symbol.endLine).join("\n");
    const returns = [...body.matchAll(/\breturn\s+([^;\n]+)/g)].map((match) => match[1].trim()).slice(0, 3);
    const throws = [...body.matchAll(/\b(?:throw|raise)\s+([^;\n]+)/g)].map((match) => match[1].trim()).slice(0, 3);
    const guards = lines.slice(symbol.line - 1, symbol.endLine).filter((line) => /\bif\b/.test(line)).slice(0, 3);
    const traps = [
      ...(body.includes("await") ? ["异步调用可能失败或被取消；调用者需要定义恢复策略。"] : []),
      ...(body.includes("JSON.parse") ? ["JSON 解析会因无效输入抛错，应确认上游是否已校验。"] : []),
      ...(body.includes("!") && /if\s*\(/.test(body) ? ["存在条件分支；需要检查空值和边界输入。"] : [])
    ];
    return {
      id: `implementation:${symbol.id}`,
      symbol,
      summary: `${symbol.name} 接收 ${symbol.parameters.length ? symbol.parameters.join("、") : "无显式参数"}，并在 ${symbol.path}:${symbol.line} 到 ${symbol.endLine} 之间完成局部行为。`,
      inputs: symbol.parameters.length ? symbol.parameters : ["无显式参数"],
      output: returns.length ? `返回 ${returns.join("；")}` : "未检测到显式返回值（可能通过副作用完成工作）。",
      invariants: guards.length ? guards.map((guard) => `守卫条件：${guard.trim()}`) : ["源码中未检测到显式守卫；需要结合调用方确认前置条件。"],
      boundaries: throws.length ? throws.map((value) => `异常边界：${value}`) : ["未检测到显式异常抛出；外部依赖仍可能失败。"],
      traps,
      verification: []
    };
  });
}
