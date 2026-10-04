import { describe, expect, it } from "vitest";
import type { CourseNode, CourseTree } from "@codebase-tutor/shared";
import type { LlmProvider } from "../llm/provider.js";
import { refineCourseMap } from "./llm-refine.js";

/** 可编程 fake provider：按调用序返回预设文本；元素为 Error 实例时该次调用抛错。 */
function fakeProvider(responses: (string | Error)[]): { provider: LlmProvider; users: string[]; systems: string[] } {
  const users: string[] = [];
  const systems: string[] = [];
  let index = 0;
  const provider = {
    name: "fake-provider",
    modelVersion: "fake-model",
    async complete(input: { system: string; user: string }) {
      users.push(input.user);
      systems.push(input.system);
      const step = responses[index];
      index += 1;
      if (step instanceof Error) throw step;
      return { text: step, usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" };
    }
  } as unknown as LlmProvider;
  return { provider, users, systems };
}

function leaf(id: string, title: string, kind: CourseNode["kind"] = "implementation"): CourseNode {
  return { id, title, kind, summary: `${title} 的模板摘要。`, anchors: [], children: [] };
}

function treeWith(...microChildren: CourseNode[]): CourseTree {
  return {
    repositoryId: "r1",
    modelVersion: "test",
    generatedAt: new Date().toISOString(),
    root: {
      id: "overview",
      title: "代码库全景",
      kind: "overview",
      summary: "全景摘要",
      anchors: [],
      children: [
        {
          id: "workflows",
          title: "从入口理解执行路径",
          kind: "overview",
          summary: "执行路径分组",
          anchors: [],
          children: [
            {
              id: "workflow:src/app.ts",
              title: "src/app.ts",
              kind: "workflow",
              summary: "入口摘要",
              anchors: [],
              children: [
                { id: "workflow:src/app.ts->src/config.ts", title: "src/config.ts", kind: "module", summary: "依赖摘要", anchors: [], children: [] }
              ]
            }
          ]
        },
        { id: "micro", title: "微观精读", kind: "overview", summary: "函数级细节", anchors: [], children: microChildren }
      ]
    }
  };
}

describe("refineCourseMap", () => {
  it("深度 ≤3 的节点（含 workflow 依赖子节点与 implementation）都被改名，usage 聚合", async () => {
    const { provider, users } = fakeProvider([
      JSON.stringify([
        { key: "workflow:src/app.ts", title: "应用启动链路", summary: "从入口装配依赖并启动服务。" },
        { key: "workflow:src/app.ts->src/config.ts", title: "配置加载", summary: "读取并校验启动配置。" },
        { key: "implementation:u1", title: "doThing 解析输入", summary: "被 app 调用，负责参数解析。" }
      ])
    ]);
    const tree = treeWith(leaf("implementation:u1", "doThing()"));
    const refinement = await refineCourseMap(tree, provider);
    expect(refinement.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(users).toHaveLength(1);

    const workflows = refinement.course.root.children[0].children[0];
    expect(workflows.title).toBe("应用启动链路");
    expect(workflows.children[0].title).toBe("配置加载"); // 深度 3：workflow 的依赖子节点
    const micro = refinement.course.root.children[1].children[0];
    expect(micro.title).toBe("doThing 解析输入"); // 深度 2：implementation 节点
    // 结构与锚点不被触碰
    expect(workflows.id).toBe("workflow:src/app.ts");
    expect(micro.id).toBe("implementation:u1");
    expect(micro.anchors).toEqual([]);
  });

  it("超过 40 个节点时分批调用，两批改名都生效", async () => {
    const nodes = Array.from({ length: 45 }, (_, index) => leaf(`implementation:u${index}`, `fn${index}()`));
    const batchOne = Array.from({ length: 40 }, (_, index) => ({ key: `implementation:u${index}`, title: `函数${index}`, summary: "职责一。" }));
    const batchTwo = Array.from({ length: 5 }, (_, index) => ({ key: `implementation:u${40 + index}`, title: `函数${40 + index}`, summary: "职责二。" }));
    const { provider, users } = fakeProvider([JSON.stringify(batchOne), JSON.stringify(batchTwo)]);
    const refinement = await refineCourseMap(treeWith(...nodes), provider);
    expect(users).toHaveLength(2);
    const micro = refinement.course.root.children[1];
    expect(micro.children[0].title).toBe("函数0");
    expect(micro.children[39].title).toBe("函数39");
    expect(micro.children[40].title).toBe("函数40"); // 第二批首个
    expect(micro.children[44].title).toBe("函数44");
    expect(refinement.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("单批失败只丢该批：第二批照常应用，不整体回退", async () => {
    const nodes = Array.from({ length: 45 }, (_, index) => leaf(`implementation:u${index}`, `fn${index}()`));
    const batchTwo = Array.from({ length: 5 }, (_, index) => ({ key: `implementation:u${40 + index}`, title: `尾部${index}`, summary: "职责。" }));
    const { provider } = fakeProvider([new Error("timeout"), JSON.stringify(batchTwo)]);
    const refinement = await refineCourseMap(treeWith(...nodes), provider);
    const micro = refinement.course.root.children[1];
    expect(micro.children[0].title).toBe("fn0()"); // 第一批失败，保持模板命名
    expect(micro.children[44].title).toBe("尾部4"); // 第二批成功
    expect(refinement.usage).toEqual({ inputTokens: 10, outputTokens: 5 }); // 只计成功批
  });

  it("全部批次失败时原样返回输入树", async () => {
    const { provider } = fakeProvider([new Error("no provider")]);
    const tree = treeWith(leaf("implementation:u1", "doThing()"));
    const refinement = await refineCourseMap(tree, provider);
    expect(refinement.course).toBe(tree);
    expect(refinement.usage).toBeUndefined();
  });

  it("LLM 返回不合法 JSON 时原样返回输入树", async () => {
    const { provider } = fakeProvider(["这不是 JSON"]);
    const tree = treeWith(leaf("implementation:u1", "doThing()"));
    const refinement = await refineCourseMap(tree, provider);
    expect(refinement.course).toBe(tree);
  });

  it("超长标题不再从中间切断：标识符原样保留，散文按边界收并加省略号", async () => {
    const prose = "Grafana 大盘 provisioning/dashboards 定义与抓取配置总览";
    const symbol = "buildIndexSettingsAndMappingForElasticsearch()";
    const { provider } = fakeProvider([JSON.stringify([
      { key: "implementation:u1", title: prose, summary: "s" },
      { key: "implementation:u2", title: symbol, summary: "s" }
    ])]);
    const tree = treeWith(leaf("implementation:u1", "one()"), leaf("implementation:u2", "two()"));
    const refinement = await refineCourseMap(tree, provider);
    const children = refinement.course.root.children.find((node) => node.id === "micro")!.children;
    // 旧口径 `.slice(0, 18)` 会切出 `Grafana 大盘 provisi` / `buildIndexSettingsA`——半截词比超长难读得多
    expect(children[0].title).toBe("Grafana 大盘 provisioning…");
    expect(children[1].title).toBe(symbol);
  });

  it("标题口径写给「不懂本仓库业务的学习者」，并禁止只写工具名", async () => {
    const { provider, systems } = fakeProvider(["[]"]);
    await refineCourseMap(treeWith(leaf("implementation:u1", "doThing()")), provider);
    expect(systems[0]).toContain("对它做的业务一无所知");
    expect(systems[0]).toContain("禁止只写产品名/工具名/目录名");
    // 长度上限也写在提示词里，改了常量必须同步提示词，否则模型还在按旧上限产出
    expect(systems[0]).toContain("≤24 字");
  });
});
