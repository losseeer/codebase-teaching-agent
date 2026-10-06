import { describe, expect, it } from "vitest";
import type { RouteProvider } from "@codebase-tutor/shared";
import { extractRouteEndpoints, matchRouteSeams, normalizeRoute } from "./routes.js";

/**
  接缝判据的单测：真值来自**写死的文本样例**，不靠跑真仓看效果（这条纪律是 §32/§33 反复用过的）。
  重点钉三件容易错的事：参数折叠形态、类级基路径的相接、后缀匹配不能被当成整段相等。
*/

describe("route seam — 归一化", () => {
  it("四种参数写法折成同一个占位", () => {
    expect(normalizeRoute("/blog/likes/12")).toBe("/blog/likes/12");
    expect(normalizeRoute("/blog/likes/${id}")).toBe("/blog/likes/{*}");
    expect(normalizeRoute("/blog/like/{id}")).toBe("/blog/like/{*}");
    expect(normalizeRoute("/blog/:id/detail")).toBe("/blog/{*}/detail");
    expect(normalizeRoute("/blog/<int:id>")).toBe("/blog/{*}");
  });

  it("查询串、锚点、重复与尾部斜杠都不影响判等", () => {
    expect(normalizeRoute("/shop/search/?kw=a&x=1")).toBe("/shop/search");
    expect(normalizeRoute("/shop//search/")).toBe("/shop/search");
    expect(normalizeRoute("shop/search")).toBe("/shop/search");
    expect(normalizeRoute("/")).toBe("/");
  });
});

describe("route seam — 提供方", () => {
  it("Spring：类上的 @RequestMapping 是基路径，方法上的与之相接；不带路径的映射不产出", () => {
    const content = [
      "package com.hmdp.controller;",
      "",
      "@RestController",
      "@RequestMapping(\"/blog\")",
      "public class BlogController {",
      "    @PostMapping(\"/like/{id}\")",
      "    public Result like() { return null; }",
      "    @GetMapping",
      "    public Result root() { return null; }",
      "    @GetMapping(\"/of/follow\")",
      "    public Result follow() { return null; }",
      "}"
    ].join("\n");
    const { providers } = extractRouteEndpoints(new Map([["src/main/java/com/hmdp/controller/BlogController.java", content]]));
    expect(providers.map((item: RouteProvider) => item.route)).toEqual(["/blog/like/{*}", "/blog/of/follow"]);
    expect(providers[0].framework).toBe("spring");
    expect(providers[0].line).toBe(6);
  });

  it("Python：Flask 的 route 与 FastAPI 的 get 都认，APIRouter 的 prefix 当前缀", () => {
    const { providers } = extractRouteEndpoints(new Map([
      ["app/views.py", "from flask import Flask\napp = Flask(__name__)\n\n@app.route(\"/agent/run\", methods=[\"POST\"])\ndef run():\n    pass\n"],
      ["app/api/router.py", "router = APIRouter(prefix=\"/api/v1\")\n\n@router.get(\"/links/{link_id}\")\ndef read(link_id: int):\n    pass\n"]
    ]));
    expect(providers.map((item: RouteProvider) => `${item.route}@${item.framework}`)).toEqual(["/agent/run@flask", "/api/v1/links/{*}@fastapi"]);
  });
});

describe("route seam — 消费方", () => {
  it("抓绝对路径字面量（含模板串），丢掉协议相对与外链", () => {
    const { consumers } = extractRouteEndpoints(new Map([
      ["src/api/blog.ts", "export const like = (id: number) => request.put(`/blog/like/${id}`);\nexport const list = () => request.get('/blog/of/follow');\nexport const ping = () => axios.get('https://example.com/blog');\nexport const bad = () => request.get('//cdn/blog');\n"]
    ]));
    expect(consumers.map((item) => item.route)).toEqual(["/blog/like/{*}", "/blog/of/follow"]);
    expect(consumers[0].raw).toContain("${id}");
  });
});

describe("route seam — 配对", () => {
  const providers: RouteProvider[] = [
    { route: "/shop/search", path: "ShopController.java", line: 10, framework: "spring" },
    { route: "/user/{*}", path: "UserController.java", line: 20, framework: "spring" },
    { route: "/user", path: "UserController.java", line: 24, framework: "spring" }
  ];

  it("整段相等优先，配不上才走后缀（via 必须区分，二者证据强度不同）", () => {
    const consumers = extractRouteEndpoints(new Map([["a.ts", "request.get('/shop/search');\nrequest.get('/api/user');\n"]])).consumers;
    const links = matchRouteSeams(providers, consumers);
    expect(links.map((link) => `${link.route}:${link.via}`)).toEqual(["/shop/search:exact", "/api/user:suffix"]);
    expect(links[1]?.provider.route).toBe("/user");
  });

  it("字面量段与占位段不互配：/user/code 不该配到 /user/{*}", () => {
    const consumers = extractRouteEndpoints(new Map([["a.ts", "request.post('/user/code');\n"]])).consumers;
    expect(matchRouteSeams(providers, consumers)).toEqual([]);
  });

  it("一条消费串配到多个提供方时全部给出并带上歧义数，不静默取第一个", () => {
    const duplicated: RouteProvider[] = [
      { route: "/blog/list", path: "A.java", line: 1, framework: "spring" },
      { route: "/blog/list", path: "B.java", line: 2, framework: "spring" }
    ];
    const consumers = extractRouteEndpoints(new Map([["a.ts", "request.get('/blog/list');\n"]])).consumers;
    const links = matchRouteSeams(duplicated, consumers);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.ambiguousWith === 2)).toBe(true);
  });
});
