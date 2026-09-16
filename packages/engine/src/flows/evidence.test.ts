import { describe, expect, it } from "vitest";
import type { CallEdge, RepositoryAnalysis, SymbolInfo } from "@codebase-tutor/shared";
import { buildFlowEvidence, FLOW_EVIDENCE_LIMITS, staticFlow } from "./evidence.js";

/**
  静态证据层：流程视图拿它当 LLM 输入材料，以及 LLM 不可用时的降级视图。
  本仓库只有 engine 配了 vitest，所以纯函数测试落在这一侧。
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

describe("buildFlowEvidence（流程视图的静态证据）", () => {
  it("从入口文件的跨文件调用展开，同文件调用只计数不展开", () => {
    const main = symbol("main.py", "main", 1);
    const helper = symbol("main.py", "helper", 20);
    const runA = symbol("lib/a.py", "run_a", 1);
    const runB = symbol("lib/b.py", "run_b", 1);
    const evidence = buildFlowEvidence(
      analysisOf([main, helper, runA, runB], [call(main, runA, 5), call(main, helper, 6), call(runA, runB, 9)]),
      { path: "main.py", line: 1, label: "conventional entrypoint" }
    );
    expect(evidence.stages.map((stage) => [stage.order, stage.title, stage.path])).toEqual([
      [1, "main", "main.py"],
      [2, "run_a", "lib/a.py"],
      [3, "run_b", "lib/b.py"]
    ]);
    expect(evidence.stages[0].sameFileCalls).toBe(1);
    expect(evidence.stages[0].branches).toBe(1);
    expect(evidence.stages[1].from).toEqual({ title: "main", path: "main.py", line: 5 });
    expect(evidence.stages[1].language).toBe("python");
    expect(evidence.truncated).toBe(false);
    expect(evidence.omitted).toBe(0);
  });

  it("优先展开还能继续往下走的分支，叶子调用不挤占主线", () => {
    const main = symbol("main.py", "main", 1);
    const helper = symbol("main.py", "helper", 20);
    const leaf = symbol("lib/leaf.py", "leaf", 1);
    const deep = symbol("lib/deep.py", "deep", 1);
    const tail = symbol("lib/tail.py", "tail", 1);
    // 目录序上 lib/deep.py 在 lib/leaf.py 之前，这里刻意把 leaf 放在调用次序前面，
    // 用来验证排序依据是「还能走多长」而不是调用先后或路径字母序。
    const evidence = buildFlowEvidence(
      analysisOf([main, helper, leaf, deep, tail], [call(helper, leaf, 5), call(helper, deep, 9), call(deep, tail, 4)]),
      { path: "main.py", line: 1, label: "entry" }
    );
    // 同一步的分支按「还能走多长」排序、连续编号，各自的下游排在其后；
    // 所以是 deep（能继续走）先于 leaf（叶子），tail 排在两者之后。
    expect(evidence.stages.map((stage) => stage.title)).toEqual(["main", "deep", "leaf", "tail"]);
    expect(evidence.stages[1].from).toEqual({ title: "helper", path: "main.py", line: 9 });
  });

  it("区分环（回到自己的上游）与复用（共享下游）", () => {
    const main = symbol("main.py", "main", 1);
    const runA = symbol("lib/a.py", "run_a", 1);
    const runB = symbol("lib/b.py", "run_b", 1);
    const shared = symbol("lib/shared.py", "shared", 1);
    const cycle = buildFlowEvidence(
      analysisOf([main, runA, runB], [call(main, runA, 5), call(runA, runB, 7), call(runB, runA, 3)]),
      { path: "main.py", line: 1, label: "entry" }
    );
    expect(cycle.stages.map((stage) => stage.title)).toEqual(["main", "run_a", "run_b"]);
    expect(cycle.stages[2].loops).toEqual([2]);
    expect(cycle.stages[2].revisits).toEqual([]);

    const reuse = buildFlowEvidence(
      analysisOf([main, runA, runB, shared], [call(main, runA, 5), call(main, shared, 6), call(runA, shared, 7)]),
      { path: "main.py", line: 1, label: "entry" }
    );
    const first = reuse.stages.find((stage) => stage.title === "run_a");
    const sharedStage = reuse.stages.find((stage) => stage.title === "shared");
    // shared 已经由入口直接展开过，run_a 里的那次调用只记「已展开于 #n」，不重复展开、也不算环
    expect(first?.revisits).toEqual([sharedStage?.order]);
    expect(first?.loops).toEqual([]);
    expect(reuse.stages.filter((stage) => stage.title === "shared")).toHaveLength(1);
  });

  it("触到深度上限就截断，并把未展开的数量报出来", () => {
    const { symbols, calls } = chain(10);
    const evidence = buildFlowEvidence(analysisOf(symbols, calls), { path: "main.py", line: 1, label: "entry" });
    expect(evidence.stages).toHaveLength(FLOW_EVIDENCE_LIMITS.maxDepth + 1);
    expect(evidence.truncated).toBe(true);
    expect(evidence.omitted).toBe(1);
    expect(evidence.stages.at(-1)?.depth).toBe(FLOW_EVIDENCE_LIMITS.maxDepth);
  });

  it("没有调用边时退化成只有入口的骨架，不编造环节", () => {
    const main = symbol("main.py", "main", 1);
    const evidence = buildFlowEvidence(analysisOf([main], []), { path: "main.py", line: 1, label: "entry" });
    expect(evidence.stages).toHaveLength(1);
    expect(evidence.stages[0].kind).toBe("entry");
    expect(evidence.truncated).toBe(false);
  });

  it("结论与 calls 数组的先后次序无关（排序稳定）", () => {
    const { symbols, calls } = chain(6);
    const entry = { path: "main.py", line: 1, label: "entry" };
    const forward = buildFlowEvidence(analysisOf(symbols, calls), entry);
    const reversed = buildFlowEvidence(analysisOf(symbols, [...calls].reverse()), entry);
    expect(reversed.stages.map((stage) => stage.title)).toEqual(forward.stages.map((stage) => stage.title));
    expect(reversed.omitted).toBe(forward.omitted);
  });
});

describe("staticFlow（降级视图）", () => {
  it("环节名取自真实符号、每个环节都指向存在的文件，并把降级原因写进 caveats", () => {
    const { symbols, calls } = chain(3);
    const evidence = buildFlowEvidence(analysisOf(symbols, calls), { path: "main.py", line: 1, label: "entry" });
    const flow = staticFlow(evidence, "未配置轻量档 LLM");
    expect(flow.stages.map((stage) => stage.kind)).toEqual(["entry", "stage", "stage", "stage"]);
    expect(flow.stages.map((stage) => stage.files[0].path)).toEqual(["main.py", "lib/step1.py", "lib/step2.py", "lib/step3.py"]);
    expect(flow.caveats).toContain("未配置轻量档 LLM");
    // 降级视图必须自述盲区：回调注册这类编排静态图看不到
    expect(flow.caveats).toContain("回调注册");
  });

  it("把环映射成 loop 环节并指向更早的序号", () => {
    const main = symbol("main.py", "main", 1);
    const runA = symbol("lib/a.py", "run_a", 1);
    const runB = symbol("lib/b.py", "run_b", 1);
    const flow = staticFlow(
      buildFlowEvidence(analysisOf([main, runA, runB], [call(main, runA, 5), call(runA, runB, 7), call(runB, runA, 3)]), { path: "main.py", line: 1, label: "entry" }),
      "原因"
    );
    expect(flow.stages[2].kind).toBe("loop");
    expect(flow.stages[2].loopsTo).toBe(2);
  });
});
