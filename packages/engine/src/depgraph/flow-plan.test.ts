import { describe, expect, it } from "vitest";
import { buildFlowPlan, FLOW_LIMITS } from "@codebase-tutor/shared";
import type { CallEdge, RepositoryAnalysis, SymbolInfo } from "@codebase-tutor/shared";

/**
  `buildFlowPlan` 定义在 shared（GUI 流程视图用，engine 侧以后也可以拿它当「过程事实」的原料）。
  本仓库只有 engine 配了 vitest，所以纯函数测试落在这一侧，不额外给 GUI 引测试环境。
  */
function symbol(path: string, name: string, line: number): SymbolInfo {
  return { id: `symbol:${path}:${name}:${line}`, name, kind: "function", path, line, endLine: line + 4, parameters: [], language: path.endsWith(".py") ? "python" : "typescript" };
}

function call(caller: SymbolInfo, callee: SymbolInfo, line: number): CallEdge {
  return { callerPath: caller.path, callerSymbol: caller.id, calleePath: callee.path, calleeSymbol: callee.id, line };
}

function analysisOf(symbols: SymbolInfo[], calls: CallEdge[], entryPath = "main.py"): RepositoryAnalysis {
  return {
    repositoryId: "test",
    generatedAt: "2026-09-16T00:00:00.000Z",
    graph: {
      imports: {},
      calls,
      symbols,
      entrypoints: [{ path: entryPath, line: 1, label: "conventional entrypoint" }],
      semanticBackend: "static",
      lspStatus: []
    },
    implementations: [],
    quality: { generatedAt: "2026-09-16T00:00:00.000Z", micro: [], macro: [] },
    versionStamp: "v"
  };
}

const chain = (depth: number): { symbols: SymbolInfo[]; calls: CallEdge[] } => {
  const symbols = Array.from({ length: depth + 1 }, (_, index) => symbol(index === 0 ? "main.py" : `lib/step${index}.py`, `step${index}`, 1));
  const calls = symbols.slice(0, -1).map((current, index) => call(current, symbols[index + 1], 3 + index));
  return { symbols, calls };
};

describe("buildFlowPlan（流程视图的纯函数）", () => {
  it("从入口文件的跨文件调用展开，同文件调用只计数不展开", () => {
    const main = symbol("main.py", "main", 1);
    const helper = symbol("main.py", "helper", 20);
    const runA = symbol("lib/a.py", "run_a", 1);
    const runB = symbol("lib/b.py", "run_b", 1);
    const plan = buildFlowPlan(
      analysisOf([main, helper, runA, runB], [call(main, runA, 5), call(main, helper, 6), call(runA, runB, 9)]),
      { path: "main.py", line: 1, label: "conventional entrypoint" }
    );
    expect(plan.steps.map((step) => [step.order, step.title, step.path])).toEqual([
      [1, "main", "main.py"],
      [2, "run_a", "lib/a.py"],
      [3, "run_b", "lib/b.py"]
    ]);
    expect(plan.steps[0].sameFileCalls).toBe(1);
    expect(plan.steps[0].branches).toBe(1);
    expect(plan.steps[1].from).toEqual({ title: "main", path: "main.py", line: 5 });
    expect(plan.steps[1].language).toBe("python");
    expect(plan.truncated).toBe(false);
    expect(plan.omitted).toBe(0);
  });

  it("优先展开还能继续往下走的分支，叶子调用不挤占主线", () => {
    const main = symbol("main.py", "main", 1);
    const helper = symbol("main.py", "helper", 20);
    const leaf = symbol("lib/leaf.py", "leaf", 1);
    const deep = symbol("lib/deep.py", "deep", 1);
    const tail = symbol("lib/tail.py", "tail", 1);
    // 目录序上 lib/deep.py 在 lib/leaf.py 之前，这里刻意把 leaf 放在调用次序前面，
    // 用来验证排序依据是「还能走多长」而不是调用先后或路径字母序。
    const plan = buildFlowPlan(
      analysisOf([main, helper, leaf, deep, tail], [call(helper, leaf, 5), call(helper, deep, 9), call(deep, tail, 4)]),
      { path: "main.py", line: 1, label: "entry" }
    );
    // 同一步的分支按「还能走多长」排序、连续编号，各自的下游排在其后；
    // 所以是 deep（能继续走）先于 leaf（叶子），tail 排在两者之后。
    expect(plan.steps.map((step) => step.title)).toEqual(["main", "deep", "leaf", "tail"]);
    expect(plan.steps[1].from).toEqual({ title: "helper", path: "main.py", line: 9 });
  });

  it("区分环（回到自己的上游）与复用（共享下游）", () => {
    const main = symbol("main.py", "main", 1);
    const runA = symbol("lib/a.py", "run_a", 1);
    const runB = symbol("lib/b.py", "run_b", 1);
    const shared = symbol("lib/shared.py", "shared", 1);
    const cycle = buildFlowPlan(
      analysisOf([main, runA, runB], [call(main, runA, 5), call(runA, runB, 7), call(runB, runA, 3)]),
      { path: "main.py", line: 1, label: "entry" }
    );
    expect(cycle.steps.map((step) => step.title)).toEqual(["main", "run_a", "run_b"]);
    expect(cycle.steps[2].loops).toEqual([2]);
    expect(cycle.steps[2].revisits).toEqual([]);

    const reuse = buildFlowPlan(
      analysisOf([main, runA, runB, shared], [call(main, runA, 5), call(main, shared, 6), call(runA, shared, 7)]),
      { path: "main.py", line: 1, label: "entry" }
    );
    const first = reuse.steps.find((step) => step.title === "run_a");
    const sharedStep = reuse.steps.find((step) => step.title === "shared");
    // shared 已经由入口直接展开过，run_a 里的那次调用只记「已展开于 #n」，不重复展开、也不算环
    expect(first?.revisits).toEqual([sharedStep?.order]);
    expect(first?.loops).toEqual([]);
    expect(reuse.steps.filter((step) => step.title === "shared")).toHaveLength(1);
  });

  it("触到深度上限就截断，并把未展开的数量报出来", () => {
    const { symbols, calls } = chain(10);
    const plan = buildFlowPlan(analysisOf(symbols, calls), { path: "main.py", line: 1, label: "entry" });
    expect(plan.steps).toHaveLength(FLOW_LIMITS.maxDepth + 1);
    expect(plan.truncated).toBe(true);
    expect(plan.omitted).toBe(1);
    expect(plan.steps.at(-1)?.depth).toBe(FLOW_LIMITS.maxDepth);
  });

  it("没有调用边时退化成只有入口的骨架，不编造环节", () => {
    const main = symbol("main.py", "main", 1);
    const plan = buildFlowPlan(analysisOf([main], []), { path: "main.py", line: 1, label: "entry" });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("entry");
    expect(plan.truncated).toBe(false);
  });

  it("结论与 calls 数组的先后次序无关（排序稳定）", () => {
    const { symbols, calls } = chain(6);
    const entry = { path: "main.py", line: 1, label: "entry" };
    const forward = buildFlowPlan(analysisOf(symbols, calls), entry);
    const reversed = buildFlowPlan(analysisOf(symbols, [...calls].reverse()), entry);
    expect(reversed.steps.map((step) => step.title)).toEqual(forward.steps.map((step) => step.title));
    expect(reversed.omitted).toBe(forward.omitted);
  });
});
