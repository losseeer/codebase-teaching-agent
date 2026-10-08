import { describe, expect, it } from "vitest";
import type { CourseNode, ImplementationUnit } from "@codebase-tutor/shared";
import { buildCourseTree, groupImplementationsByModule } from "./build.js";

function unit(path: string, name: string): ImplementationUnit {
  const line = 3;
  return {
    id: `symbol:${path}:${name}:${line}`,
    symbol: { id: `symbol:${path}:${name}:${line}`, name, kind: "function", path, line, endLine: 8, parameters: [], language: "typescript" },
    summary: `${name} 的实现细节。`,
    inputs: [], output: "无", invariants: [], boundaries: [], traps: [], verification: []
  };
}

function microOf(tree: ReturnType<typeof buildCourseTree>): CourseNode {
  return tree.root.children.find((node) => node.id === "micro")!;
}

describe("course tree", () => {
  it("binds generated workflow lessons to source anchors", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [{ path: "src/main.ts", extension: ".ts", bytes: 30, lines: 2 }],
      summaries: [{ path: "src/main.ts", summary: "应用入口。", role: "core", roleSource: "structure", coverage: { checked: 0, mentioned: 0, low: false }, cached: false }],
      graph: { imports: new Map([["src/main.ts", []]]), calls: [], dispatch: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [{ path: "src/main.ts", line: 1, label: "script: dev" }], parseBackend: "regex" }
    });
    const workflow = tree.root.children[0].children[0];
    expect(workflow.anchors).toEqual([{ path: "src/main.ts", line: 1, label: "script: dev" }]);
    expect(tree.root.summary).toContain("入口");
  });

  it("仓内 fixture/demo 目录不作为执行路径入口", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [
        { path: "src/main.ts", extension: ".ts", bytes: 30, lines: 2 },
        { path: "test-fixtures/frozen-demo-repo/src/main.js", extension: ".js", bytes: 30, lines: 2 }
      ],
      summaries: [{ path: "src/main.ts", summary: "应用入口。", role: "core", roleSource: "structure", coverage: { checked: 0, mentioned: 0, low: false }, cached: false }],
      graph: {
        imports: new Map([["src/main.ts", ["test-fixtures/frozen-demo-repo/src/main.js"]]]),
        calls: [], dispatch: [],
        symbols: [],
        semanticBackend: "static",
        lspStatus: [],
        entrypoints: [
          { path: "src/main.ts", line: 1, label: "script: dev" },
          { path: "test-fixtures/frozen-demo-repo/src/main.js", line: 1, label: "script: start" }
        ],
        parseBackend: "regex"
      }
    });
    const workflowPaths = tree.root.children[0].children.map((node) => node.anchors[0]?.path);
    expect(workflowPaths).toEqual(["src/main.ts"]); // fixture 入口被过滤，真实入口保留
    // fixture 文件仍作为依赖子节点出现（它是被 import 的对象，只是不当入口讲）
    expect(tree.root.children[0].children[0].children.some((child) => child.title.includes("frozen-demo-repo"))).toBe(true);
  });

  it("没有入口的仓库（库/轮子）明示事实，不拿首个文件伪造假入口", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [{ path: "src/lib.ts", extension: ".ts", bytes: 30, lines: 2 }],
      summaries: [{ path: "src/lib.ts", summary: "工具函数。", role: "tool", roleSource: "structure", coverage: { checked: 0, mentioned: 0, low: false }, cached: false }],
      graph: { imports: new Map([["src/lib.ts", []]]), calls: [], dispatch: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [], parseBackend: "regex" }
    });
    const workflows = tree.root.children[0];
    expect(workflows.children).toHaveLength(1);
    expect(workflows.children[0].id).toBe("workflow:no-entry");
    expect(workflows.children[0].anchors).toEqual([]); // 无锚点 → 不进推荐入口候选池
    expect(tree.root.summary).toContain("未检测到可执行入口");
  });

  it("微观节点按锚点目录归组回模块，重复执行是幂等的", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [
        { path: "src/main.ts", extension: ".ts", bytes: 30, lines: 10 },
        { path: "src/db/store.ts", extension: ".ts", bytes: 30, lines: 10 }
      ],
      summaries: [],
      graph: { imports: new Map(), calls: [], dispatch: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [{ path: "src/main.ts", line: 1, label: "script: dev" }], parseBackend: "regex" },
      implementations: [unit("src/main.ts", "boot"), unit("src/db/store.ts", "load"), unit("src/db/store.ts", "save")]
    });
    expect(microOf(tree).children).toHaveLength(3); // 归组前：三条平行清单
    const grouped = groupImplementationsByModule(tree);
    expect(microOf(grouped).children).toEqual([]);
    expect(microOf(grouped).summary).toContain("已按其所在目录归入");
    const modules = grouped.root.children.find((node) => node.id === "modules")!;
    const mainModule = modules.children.find((node) => node.id === "module:src")!;
    const dbModule = modules.children.find((node) => node.id === "module:src/db")!;
    expect(mainModule.children.map((node) => node.id)).toEqual(["symbol:src/main.ts:boot:3"]);
    expect(dbModule.children.map((node) => node.id)).toEqual(["symbol:src/db/store.ts:load:3", "symbol:src/db/store.ts:save:3"]);
    expect(groupImplementationsByModule(grouped)).toBe(grouped); // 幂等：对已归组的树原样返回
  });

  it("小目录合并：顶层功能区的单文件子目录合成一个模块，源码根下的包各自保留", () => {
    const file = (path: string) => ({ path, extension: path.slice(path.lastIndexOf(".")), bytes: 10, lines: 2 });
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [
        file("observability/grafana/dashboards/board.json"),
        file("observability/grafana/provisioning/dashboards/x.yaml"),
        file("observability/prometheus/prometheus.yml"),
        file("src/main/java/com/hmdp/entity/User.java"),
        file("src/main/java/com/hmdp/repository/UserRepository.java"),
        file("docs/design.md")
      ],
      summaries: [],
      graph: { imports: new Map(), calls: [], dispatch: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [], parseBackend: "regex" }
    });
    const ids = tree.root.children.find((node) => node.id === "modules")!.children.map((node) => node.id);
    // 真仓就是这里碎掉的：observability 下三个子目录各 1 个文件 → 三个几乎同名的 chip
    expect(ids).toContain("module:observability");
    expect(ids.filter((id) => id.startsWith("module:observability/"))).toEqual([]);
    // 源码根下面不跨包合并：entity / repository 是有语义的边界，合成 src/main 就是大杂烩
    expect(ids).toContain("module:src/main/java/com/hmdp/entity");
    expect(ids).toContain("module:src/main/java/com/hmdp/repository");
    // 落单的小目录不为了整齐硬挂到区域名下
    expect(ids).toContain("module:docs");
  });

  it("区域名本身也是模块时，合并桶不许吃掉它自己的文件", () => {
    const file = (path: string) => ({ path, extension: path.slice(path.lastIndexOf(".")), bytes: 10, lines: 2 });
    const files = [
      file("observability/check-queries.py"),
      file("observability/docker-compose.yml"),
      file("observability/README.md"),
      file("observability/grafana/dashboards/board.json"),
      file("observability/prometheus/alerts.yml")
    ];
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files,
      summaries: [],
      graph: { imports: new Map(), calls: [], dispatch: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [], parseBackend: "regex" }
    });
    const modules = tree.root.children.find((node) => node.id === "modules")!.children;
    const observability = modules.find((node) => node.id === "module:observability")!;
    expect(observability.summary, "区域名与目录名同名时，原写法用合并结果覆盖了整个模块").toContain("包含 5 个可分析文件");
    // 这条是「文件不会凭空消失」的总闸：dianping 实测丢了 observability 的三个直属文件（156 个索引文件只剩 153 有归属）
    const claimed = modules.reduce((sum, node) => sum + Number(/包含 (\d+) 个可分析文件/.exec(node.summary)?.[1] ?? 0), 0);
    expect(claimed, "每个索引文件都必须有模块归属").toBe(files.length);
  });

  it("合并后的模块仍接得住子目录里的函数节点（逐级上溯，不产孤儿）", () => {
    const file = (path: string) => ({ path, extension: ".ts", bytes: 10, lines: 2 });
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [file("observability/grafana/dashboards/render.ts"), file("observability/prometheus/rules.ts")],
      summaries: [],
      graph: { imports: new Map(), calls: [], dispatch: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [], parseBackend: "regex" },
      implementations: [unit("observability/grafana/dashboards/render.ts", "render"), unit("observability/prometheus/rules.ts", "evaluate")]
    });
    const grouped = groupImplementationsByModule(tree);
    const merged = grouped.root.children.find((node) => node.id === "modules")!.children.find((node) => node.id === "module:observability")!;
    expect(merged.children.map((node) => node.title)).toEqual(["render()", "evaluate()"]);
    expect(microOf(grouped).children).toEqual([]);
  });
});
