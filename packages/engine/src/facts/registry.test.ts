import { describe, expect, it } from "vitest";
import { analyzeFileRegistry } from "./registry.js";

/**
  两个方向：
  1. 配置值不能进产物（`.tutor/` 是盘上明文）。
  2. 「没认出来」不能说成「没有」：认不出来的登记可以不写条目，但不能反过来编一条。
*/

const registry = (path: string, code: string[]): string[] => {
  const fact = analyzeFileRegistry(path, code.join("\n"), path.endsWith(".java") ? "java" : "typescript", true);
  return fact.entries.map((entry) => `${entry.kind}:${entry.name}${entry.target ? `→${entry.target}` : ""}`);
};

describe("注册与配置索引", () => {
  it("Spring：组件声明、字段注入、构造注入、@Bean 工厂方法都进表", () => {
    const rows = registry("OrderController.java", [
      "@RestController",
      "@RequestMapping(\"/order\")",
      "public class OrderController {",
      "  @Autowired",
      "  private OrderService orderService;",
      "  private final ShopService shopService;",
      "",
      "  public OrderController(CacheService cache, ShopService shop) {",
      "    this.shopService = shop;",
      "  }",
      "",
      "  @GetMapping(\"/list\")",
      "  public String list() { return \"\"; }",
      "}"
    ]);
    expect(rows).toContain("registration:OrderController");
    expect(rows).toContain("di-binding:OrderService→orderService");
    expect(rows).toContain("di-binding:CacheService");
    expect(rows).toContain("di-binding:ShopService");
    expect(rows.some((row) => row.startsWith("route:"))).toBe(true);
  });

  it("C#：AddScoped<I, X>() 记成接口→实现的绑定", () => {
    const fact = analyzeFileRegistry("Program.cs", [
      "builder.Services.AddScoped<IOrderRepo, OrderRepo>();",
      "builder.Services.AddSingleton<Cache>();"
    ].join("\n"), "csharp", true);
    expect(fact.entries.map((entry) => `${entry.kind}:${entry.name}→${entry.target ?? ""}`)).toEqual([
      "di-binding:IOrderRepo→OrderRepo",
      "di-binding:Cache→"
    ]);
  });

  it("前端与 Go 的登记动作都收：app.use、http.HandleFunc", () => {
    expect(registry("server.ts", ["const app = express();", "app.use(cors);", "app.use('/api', router);"]).length).toBeGreaterThanOrEqual(2);
    const go = analyzeFileRegistry("main.go", "package main\n\nfunc main() {\n    http.HandleFunc(\"/health\", ping)\n}", "go", true);
    expect(go.entries.some((entry) => entry.name === "/health")).toBe(true);
  });

  it("配置文件只记键名：值里有口令也不会进产物", () => {
    const fact = analyzeFileRegistry("src/main/resources/application.properties", "spring.datasource.url=jdbc:mysql://inside.host:3306/db\nspring.datasource.password=S3cr3t-DoNot-Leak\n# 注释行不算键", "unknown", false);
    const text = JSON.stringify(fact);
    expect(fact.entries.map((entry) => entry.name)).toEqual(["spring.datasource.url", "spring.datasource.password"]);
    expect(text, "产物里不能出现任何配置值").not.toContain("S3cr3t");
    expect(text).not.toContain("jdbc:mysql");
    expect(text).not.toContain("注释行");
  });

  it("yml 的键按缩进拼回全名：只记叶子会把两个不同段的 password 混成一个", () => {
    const fact = analyzeFileRegistry("src/main/resources/application.yml", "spring:\n  datasource:\n    password: S3cr3t-DoNot-Leak\nserver:\n  password: another-secret\n  port: 8080\n", "unknown", false);
    expect(fact.entries.map((entry) => entry.name)).toEqual(["spring", "spring.datasource", "spring.datasource.password", "server", "server.password", "server.port"]);
    const text = JSON.stringify(fact);
    expect(text, "值一个字都不进产物").not.toContain("S3cr3t");
    expect(text).not.toContain("another-secret");
    expect(text).not.toContain("8080");
  });

  it("SPI 清单：文件名是接口，每行是实现", () => {
    const fact = analyzeFileRegistry("src/main/resources/META-INF/services/com.demo.Renderer", "com.demo.PngRenderer\n# 注释\ncom.demo.SvgRenderer", "unknown", false);
    expect(fact.entries.map((entry) => `${entry.name}→${entry.target}`)).toEqual([
      "com.demo.Renderer→com.demo.PngRenderer",
      "com.demo.Renderer→com.demo.SvgRenderer"
    ]);
  });

  it("构建清单：模块名与源码根进表，不猜构建范围", () => {
    const pom = analyzeFileRegistry("pom.xml", "<project>\n  <modules>\n    <module>common</module>\n    <module>web</module>\n  </modules>\n</project>", "unknown", false);
    expect(pom.entries.filter((entry) => entry.via === "pom 子模块").map((entry) => entry.name)).toEqual(["common", "web"]);
    const gomod = analyzeFileRegistry("go.mod", "module github.com/demo/shop\n\ngo 1.22", "unknown", false);
    expect(gomod.entries.some((entry) => entry.name === "github.com/demo/shop")).toBe(true);
  });

  it("包清单脚本只记名字，命令体不抄", () => {
    const fact = analyzeFileRegistry("package.json", '{\n  "name": "shop",\n  "scripts": {\n    "start": "node server.js --token=abc",\n    "build": "tsc"\n  }\n}', "unknown", false);
    const text = JSON.stringify(fact);
    expect(text).not.toContain("node server.js");
    expect(text).not.toContain("abc");
    expect(fact.entries.some((entry) => entry.name === "start")).toBe(true);
  });
});
