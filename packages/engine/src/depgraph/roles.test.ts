import { describe, expect, it } from "vitest";
import type { CallEdge, SourceAnchor, SymbolInfo } from "@codebase-tutor/shared";
import { classifyFileRoles, fileStructureOf, isTestPath, roleOf, type FileStructure } from "./roles.js";

const ENTRY: SourceAnchor = { path: "main.py", line: 1, label: "入口" };

function structureOf(over: Partial<FileStructure>): FileStructure {
  return { files: [], symbols: [], calls: [], imports: {}, entrypoints: [], ...over };
}

const paths = (...files: string[]): FileStructure["files"] => files.map((path) => ({ path, lines: 10 }));

describe("文件角色分类（结构规则）", () => {
  it("测试路径优先于一切，包括它是入口的直接依赖", () => {
    expect(isTestPath("tests/test_svc.py")).toBe(true);
    expect(isTestPath("svc_test.py")).toBe(true);
    expect(isTestPath("src/__tests__/a.test.ts")).toBe(true);
    expect(isTestPath("conftest.py")).toBe(true);
    expect(isTestPath("src/testing/test_x.py")).toBe(true);
    // 边界：只按「目录段」与明确的文件名约定判，不猜 `testing.py` 这种孤立文件名
    expect(isTestPath("src/testing.py")).toBe(false);
    expect(isTestPath("src/latest.py")).toBe(false);
    const roles = classifyFileRoles(structureOf({
      files: paths("main.py", "tests/test_svc.py"),
      imports: { "main.py": ["tests/test_svc.py"] },
      entrypoints: [ENTRY]
    }));
    expect(roles.get("tests/test_svc.py")).toBe("test");
  });

  it("入口自己、入口的直接依赖都是主干；设施类名字优先判为设施", () => {
    const roles = classifyFileRoles(structureOf({
      files: paths("main.py", "svc.py", "core/config.py", "util.py", "lonely.py"),
      imports: { "main.py": ["svc.py", "core/config.py"], "svc.py": ["util.py"] },
      entrypoints: [ENTRY]
    }));
    expect(roles.get("main.py")).toBe("core");
    expect(roles.get("svc.py")).toBe("core");
    // 被入口依赖不改变「它是设施」这个事实：配置模块该按设施读，不该混进执行主干
    expect(roles.get("core/config.py")).toBe("infra");
    expect(roles.get("util.py")).toBe("support");
    expect(roles.get("lonely.py")).toBe("tool");
  });

  it("跨文件调用也算依赖（import 边看不见的关系）", () => {
    const calls: CallEdge[] = [{ callerPath: "main.py", calleePath: "b.py", line: 3 }];
    const roles = classifyFileRoles(structureOf({
      files: paths("main.py", "b.py"),
      calls,
      entrypoints: [ENTRY]
    }));
    expect(roles.get("b.py")).toBe("core");
  });

  it("设施名要成词才算命中：博客/登录/目录里的 log 不是日志设施", () => {
    const roles = classifyFileRoles(structureOf({
      files: paths("main.py", "entity/Blog.java", "dto/LoginFormDTO.java", "web/CatalogService.java", "web/LogController.java", "svc/logging.py"),
      entrypoints: [ENTRY]
    }));
    // 这三个在 2026-10-05 的 dianping 实测里全被误判成设施
    expect(roles.get("entity/Blog.java")).not.toBe("infra");
    expect(roles.get("dto/LoginFormDTO.java")).not.toBe("infra");
    expect(roles.get("web/CatalogService.java")).not.toBe("infra");
    // 真正叫「日志」的照旧算设施
    expect(roles.get("web/LogController.java")).toBe("infra");
    expect(roles.get("svc/logging.py")).toBe("infra");
  });

  it("接口与实现之间没有调用行：靠类型派发边把实现拉回一跳内，且只有派生关系不算孤立", () => {
    const dispatch = [
      { subtypePath: "svc/OrderServiceImpl.java", supertypePath: "svc/IOrderService.java", kind: "implements" as const, line: 4 },
      { subtypePath: "svc/Standalone.java", supertypePath: "svc/Base.java", kind: "extends" as const, line: 3 }
    ];
    const roles = classifyFileRoles(structureOf({
      files: paths("main.py", "svc/IOrderService.java", "svc/OrderServiceImpl.java", "svc/OrderMapper.java", "svc/Base.java", "svc/Standalone.java"),
      imports: { "main.py": ["svc/IOrderService.java"], "svc/OrderServiceImpl.java": ["svc/OrderMapper.java"] },
      dispatch,
      entrypoints: [ENTRY]
    }));
    expect(roles.get("svc/IOrderService.java")).toBe("core");
    // 控制器注入接口、运行时打到实现：同一拍执行，所以实现算主干
    expect(roles.get("svc/OrderServiceImpl.java")).toBe("core");
    // 实现下面的 Mapper 是第二跳，不算主干（透传只沿派生走，不沿普通依赖延伸）
    expect(roles.get("svc/OrderMapper.java")).toBe("support");
    // Base 与 Standalone 谁都不挨着入口，但这一对不是孤立文件，不能算末端工具
    expect(roles.get("svc/Standalone.java")).toBe("support");
    expect(roles.get("svc/Base.java")).toBe("support");
  });

  it("角色与「这次看的是哪个入口」无关：按全部入口一起判", () => {
    const second: SourceAnchor = { path: "worker.py", line: 1, label: "入口" };
    const withTwo = classifyFileRoles(structureOf({
      files: paths("main.py", "worker.py", "deep_report.py"),
      imports: { "main.py": [], "worker.py": ["deep_report.py"] },
      entrypoints: [ENTRY, second]
    }));
    // deep_report.py 只被第二个入口依赖，仍然算主干
    expect(withTwo.get("deep_report.py")).toBe("core");
  });

  it("索引里没有的路径按支撑处理，调用方不必判空", () => {
    expect(roleOf(classifyFileRoles(structureOf({ files: paths("a.py") })), "nope.py")).toBe("support");
  });

  it("fileStructureOf 把依赖图的 Map 边转成结构输入", () => {
    const symbols: SymbolInfo[] = [];
    const calls: CallEdge[] = [];
    const built = fileStructureOf(paths("a.py"), { symbols, calls, imports: new Map([["a.py", ["b.py"]]]), entrypoints: [ENTRY] });
    expect(built.imports).toEqual({ "a.py": ["b.py"] });
    expect(built.entrypoints).toEqual([ENTRY]);
  });
});
