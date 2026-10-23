import type { ImpactResult } from "@codebase-tutor/shared";
import type { DependencyGraph } from "./graph.js";

/**
  改这些文件会波及谁：沿 import 边与跨文件调用边反向往上走。
  同文件内的调用不算波及关系：图里同文件调用边是常态，不过滤的话每个改动文件都会给自己
  贡献一条「X 影响 X」的边，影响范围的箭头清单被自环占满。
  与 `roles.ts` 的 `buildFileEdges` 同一条口径（那里是 `key === value` 直接不建）。
*/
export function impactRadius(graph: DependencyGraph, changedPaths: string[]): ImpactResult {
  const reverse = new Map<string, { from: string; kind: "import" | "call" }[]>();
  for (const [from, targets] of graph.imports) {
    for (const to of targets) {
      if (to === from) continue;
      reverse.set(to, [...(reverse.get(to) ?? []), { from, kind: "import" }]);
    }
  }
  for (const call of graph.calls) {
    if (call.callerPath === call.calleePath) continue;
    reverse.set(call.calleePath, [...(reverse.get(call.calleePath) ?? []), { from: call.callerPath, kind: "call" }]);
  }
  const impacted = new Set(changedPaths);
  const pending = [...changedPaths];
  const edges: ImpactResult["edges"] = [];
  while (pending.length) {
    const target = pending.shift()!;
    for (const edge of reverse.get(target) ?? []) {
      edges.push({ from: edge.from, to: target, kind: edge.kind });
      if (!impacted.has(edge.from)) {
        impacted.add(edge.from);
        pending.push(edge.from);
      }
    }
  }
  return { changedPaths, impactedPaths: [...impacted].sort(), edges };
}
