import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "./graph.js";

const pyFrameworkFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/pyframeworkdemo-repo");

describe("Python 框架入口（fixture 先于规则）", () => {
  it("Flask：入口锚在 app 构造行；同文件的路由与启动语句不再各出一条", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "flaskshop/shop.py", line: 10, label: "HTTP 应用 (Flask)" });
    // 一个文件只有一条锚点：真仓一个 main.py 挂着十几条路由，逐条标会把入口清单变成路由清单
    expect(graph.entrypoints.filter((item) => item.path === "flaskshop/shop.py")).toHaveLength(1);
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("FastAPI：应用对象与路由写在同一文件时锚在构造行", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "fastapiapp/orders.py", line: 10, label: "HTTP 应用 (FastAPI)" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("路由模块：只有装饰器（Flask 蓝图的 .route、FastAPI APIRouter 的 .get）也入围，锚在第一条装饰器", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "flaskshop/reviews.py", line: 12, label: "HTTP 路由 (Flask)" });
    expect(graph.entrypoints).toContainEqual({ path: "fastapiapp/shipments.py", line: 12, label: "HTTP 路由 (FastAPI)" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("启动文件：app.run / uvicorn.run 优先于同文件的脚本守卫；认不出框架名就不带框架名", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    // serve.py 的守卫在 11 行、启动在 12 行；标签不写框架，因为 `from flaskshop.shop` 是仓内包名而不是 flask
    expect(graph.entrypoints).toContainEqual({ path: "flaskshop/serve.py", line: 12, label: "HTTP 服务启动" });
    expect(graph.entrypoints).toContainEqual({ path: "fastapiapp/run.py", line: 14, label: "HTTP 服务启动" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("Django：urlpatterns 是路由表入口，manage.py 从文件名猜测升成权威锚点", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "djangoshop/shop/urls.py", line: 12, label: "HTTP 路由表 (Django)" });
    expect(graph.entrypoints).toContainEqual({ path: "djangoshop/manage.py", line: 21, label: "脚本主入口 (Django)" });
    // manage 本来就在文件名约定里：同一个文件不能既报「脚本主入口」又报「conventional entrypoint」
    expect(graph.entrypoints.filter((item) => item.path === "djangoshop/manage.py")).toHaveLength(1);
    // 路由表指向的视图靠相对导入落点：入口与它要讲的正文之间得有一条边
    expect(graph.imports.get("djangoshop/shop/urls.py")).toContain("djangoshop/shop/views.py");
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("普通脚本：只有 if __name__ 守卫的，锚点落在那一行且不带框架名", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "tools/export_csv.py", line: 16, label: "脚本主入口" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("负例：Django 视图与纯库文件不是入口；整仓入口就是框架证据那九条", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    const paths = graph.entrypoints.map((item) => item.path);
    // 视图由 urls.py 那张表决定谁来调；库文件只有函数定义与非路由装饰器（property/lru_cache）
    expect(paths).not.toContain("djangoshop/shop/views.py");
    expect(paths).not.toContain("library/prices.py");
    expect([...paths].sort()).toEqual([
      "djangoshop/manage.py",
      "djangoshop/shop/urls.py",
      "fastapiapp/orders.py",
      "fastapiapp/run.py",
      "fastapiapp/shipments.py",
      "flaskshop/reviews.py",
      "flaskshop/serve.py",
      "flaskshop/shop.py",
      "tools/export_csv.py"
    ]);
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });
});
