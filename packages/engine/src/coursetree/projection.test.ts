import { describe, expect, it } from "vitest";
import type { CourseNode, CourseTree, FileRole, RepositoryIndex } from "@codebase-tutor/shared";
import { annotateModuleTiers, courseChildren, courseOverview } from "./projection.js";

const tree: CourseTree = {
  repositoryId: "repo_test",
  modelVersion: "fixture-v1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  root: {
    id: "overview",
    title: "代码库全景",
    kind: "overview",
    summary: "overview",
    anchors: [],
    children: [{
      id: "modules",
      title: "模块地图",
      kind: "overview",
      summary: "modules",
      anchors: [],
      children: Array.from({ length: 35 }, (_, index) => ({ id: `module:${index}`, title: `模块 ${index}`, kind: "module" as const, summary: "module", anchors: [], children: [] }))
    }]
  }
};

const index: RepositoryIndex = {
  repositoryId: "repo_test",
  repositoryPath: "/repo",
  scannedAt: "2026-01-01T00:00:00.000Z",
  totalFiles: 5000,
  totalLines: 250000,
  files: [],
  fileTree: [],
  hotspots: [{ path: "src/main.ts", changes: 12 }]
};

const node = (id: string, paths: string[], children: CourseNode[] = []): CourseNode => ({
  id, title: id, kind: "module", summary: "", anchors: paths.map((path) => ({ path, line: 1, label: path })), children
});

describe("course projections", () => {
  it("keeps the overview shallow and pages descendants", () => {
    const overview = courseOverview(tree, index);
    expect(overview.root.children).toHaveLength(1);
    expect(overview.root.children[0]).toMatchObject({ id: "modules", childCount: 35, children: [] });

    const firstPage = courseChildren(tree, "modules", 0, 30)!;
    expect(firstPage).toMatchObject({ total: 35, offset: 0, nextOffset: 30 });
    expect(firstPage.items).toHaveLength(30);
    const secondPage = courseChildren(tree, "modules", firstPage.nextOffset!, 30)!;
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.nextOffset).toBeUndefined();
  });

  it("tiers modules by the structural roles of their visible files", () => {
    const branches: CourseTree = {
      ...tree,
      root: {
        ...tree.root,
        children: [
          { id: "workflows", title: "执行路径", kind: "overview", summary: "", anchors: [], children: [node("flow:1", ["src/App.java"])] },
          { id: "modules", title: "模块地图", kind: "overview", summary: "", anchors: [], children: [
            node("module:a", ["src/App.java"]),
            node("module:b", ["src/config/RedisConfig.java"]),
            node("module:c", ["src/service/OrderService.java"]),
            node("module:d", ["grafana/dashboards/board.json", "README.md"]),
            node("module:e", ["docs/design.md"], [node("module:e/impl", ["src/App.java"])]),
            node("module:f", [])
          ] }
        ]
      }
    };
    const roles = new Map([
      ["src/App.java", "core" as const],
      ["src/config/RedisConfig.java", "infra" as const],
      ["src/service/OrderService.java", "support" as const],
      ["grafana/dashboards/board.json", "tool" as const],
      ["README.md", "tool" as const],
      ["docs/design.md", "tool" as const]
    ]);
    const tiered = annotateModuleTiers(branches, roles);
    const modules = tiered.root.children.find((item) => item.id === "modules")!;
    expect(modules.children.map((item) => `${item.id}=${item.tier}`)).toEqual([
      "module:a=core",
      "module:b=facility",
      "module:c=facility",
      "module:d=periphery",
      // 主干占可见文件的一半：占比过 1/4 的门槛，所以仍算主干
      "module:e=core",
      "module:f=periphery"
    ]);
    // 依据随档一起给出，界面才能把「为什么这么分」露出来
    expect(modules.children[0]?.tierEvidence).toMatchObject({ visibleFiles: 1, coreFiles: 1, coreShare: 1 });
    expect(modules.children[1]?.tierEvidence?.reason).toContain("够不上 1/4");
    // 只动 modules 分支：流程节点不该被挂上 tier，也不该被复制成新对象
    expect(tiered.root.children[0]).toBe(branches.root.children[0]);
    const branchless: CourseTree = { ...tree, root: { ...tree.root, children: [branches.root.children[0]!] } };
    expect(annotateModuleTiers(branchless, roles)).toBe(branchless);
  });

  it("占比门槛与入口优先：一个主干文件撑不起 66 个文件的模块，但含入口就直通主干", () => {
    const many = Array.from({ length: 20 }, (_, index) => `src/notify/Topic${index}.java`);
    const branches: CourseTree = {
      ...tree,
      root: {
        ...tree.root,
        children: [{
          id: "modules", title: "模块地图", kind: "overview", summary: "", anchors: [], children: [
            node("module:big", [many[0]!, ...many.slice(1)]),
            node("module:withEntry", ["src/notify/Entry.java", ...many]),
            node("module:unmapped", ["src/nowhere.py"])
          ]
        }]
      }
    };
    // 20 个可见文件里只有 1 个主干：旧判据会把它抬成主干，现判据按占比降回设施
    const roles = new Map<string, FileRole>([
      ...many.map((path): [string, FileRole] => [path, "support"]),
      [many[0]!, "core"],
      ["src/notify/Entry.java", "core"]
    ]);
    const modules = annotateModuleTiers(branches, roles, [{ path: "src/notify/Entry.java", line: 1, label: "HTTP 路由 (Spring MVC)：/notify" }]).root.children.find((item) => item.id === "modules")!.children;
    expect(modules.map((item) => `${item.id}=${item.tier}`)).toEqual(["module:big=facility", "module:withEntry=core", "module:unmapped=periphery"]);
    expect(modules[0]?.tierEvidence).toMatchObject({ visibleFiles: 20, coreFiles: 1, coreShare: 0.05, decidingPath: "src/notify/Topic0.java" });
    // 只有路径、图里没有任何角色的模块 = 没有代码证据 = 外围。这里刻意不与 `roleOf` 的 support 回落统一（理由见 projection.ts）
    expect(modules[2]?.tierEvidence?.visibleFiles).toBe(1);
    // 不传入口集合时（旧引擎响应）判据只剩占比那一档：2/21 过不了 1/4，含入口的那个也落回设施
    const noEntry = annotateModuleTiers(branches, roles).root.children.find((item) => item.id === "modules")!.children;
    expect(noEntry.map((item) => item.tier)).toEqual(["facility", "facility", "periphery"]);
  });

  it("脚本型入口只说明「能自己跑」：既不把模块顶成主干，也不计入主干证据", () => {
    // 照搬 10-06 的 dianping 实测形状：可观测性模块 4 个可见文件，其中 Grafana 自动加载用的运维脚本是入口（角色 core）
    const branches: CourseTree = {
      ...tree,
      root: {
        ...tree.root,
        children: [{
          id: "modules", title: "模块地图", kind: "overview", summary: "", anchors: [], children: [
            node("module:observability", ["observability/check-queries.py", "observability/grafana/dashboards/overview.json", "observability/prometheus/alerts/alerts.yml", "observability/docker-compose.yml"]),
            node("module:order", ["controller/OrderController.java", "service/IOrderService.java", "service/impl/OrderServiceImpl.java", "service/OrderMapper.java"])
          ]
        }]
      }
    };
    const roles = new Map<string, FileRole>([
      ["observability/check-queries.py", "core"],
      ["observability/grafana/dashboards/overview.json", "infra"],
      ["observability/prometheus/alerts/alerts.yml", "infra"],
      ["observability/docker-compose.yml", "infra"],
      ["controller/OrderController.java", "core"],
      ["service/IOrderService.java", "core"],
      ["service/impl/OrderServiceImpl.java", "core"],
      ["service/OrderMapper.java", "support"]
    ]);
    const entrypoints = [
      { path: "observability/check-queries.py", line: 1, label: "脚本主入口" },
      { path: "controller/OrderController.java", line: 1, label: "HTTP 路由 (Spring MVC)：/order" }
    ];
    const modules = annotateModuleTiers(branches, roles, entrypoints).root.children.find((item) => item.id === "modules")!.children;
    expect(modules[0]?.tier).toBe("facility");
    expect(modules[0]?.tierEvidence).toMatchObject({ visibleFiles: 4, coreFiles: 0, entryFiles: 0 });
    // 下单模块 3/4 都过门槛，且含对外入口，两条判据同时成立
    expect(modules[1]?.tier).toBe("core");
    expect(modules[1]?.tierEvidence?.reason).toContain("对外服务入口");
  });
});
