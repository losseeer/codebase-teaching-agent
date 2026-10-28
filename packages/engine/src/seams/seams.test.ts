import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FileEntry, SeamReport } from "@codebase-tutor/domain";

import { clearSeamMemo, seamReportFor, type SeamRepository } from "./seams.js";

/**
  跨仓接缝配对：两个临时小仓当 fixture（Vue/TS 前端形态 + Spring 后端形态）。
  覆盖：配得上、方向不混、后缀匹配单独标出。
*/

function repo(name: string, files: Record<string, string>): SeamRepository {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `tutor-seams-${name}-`)));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(root, path), content, "utf8");
  }
  const entries: FileEntry[] = Object.entries(files).map(([path, content]) => ({
    path, extension: `.${path.split(".").pop()}`, bytes: content.length, lines: content.split("\n").length
  }));
  return { repositoryId: `${name}-id`, path: root, files: entries, versionStamp: "v1" };
}

const frontend = () => repo("front", {
  "src/api/ping.ts": "export const ping = () => request.get('/probe/ping');\nexport const viaGateway = () => request.get('/api/probe/health');\n"
});
const backend = () => repo("back", {
  "src/main/java/com/demo/PingController.java": [
    "package com.demo;",
    "",
    "@RestController",
    "@RequestMapping(\"/probe\")",
    "public class PingController {",
    "    @GetMapping(\"/ping\")",
    "    public String ping() { return \"ok\"; }",
    "    @GetMapping(\"/health\")",
    "    public String health() { return \"ok\"; }",
    "}"
  ].join("\n")
});

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearSeamMemo();
});

describe("跨仓 HTTP 接缝", () => {
  it("前端调用串配上后端注解：方向、整段相等、落点行号都对", () => {
    const consumer = frontend();
    const provider = backend();
    roots.push(consumer.path, provider.path);
    const report = seamReportFor(consumer, provider);
    expect(report.outbound.matched).toBe(2);
    expect(report.outbound.links.filter((link) => link.via === "exact").map((link) => link.route)).toEqual(["/probe/ping"]);
    // 带网关前缀的只能后缀匹配，标成 suffix
    expect(report.outbound.links.filter((link) => link.via === "suffix").map((link) => `${link.route}→${link.provider.path}`)).toEqual(["/api/probe/health→src/main/java/com/demo/PingController.java"]);
    expect(report.outbound.links[0].provider.line).toBe(6);
    // 后端没有调用串，反向为空
    expect(report.inbound.scanned).toBe(0);
    expect(report.inbound.links).toEqual([]);
  });

  it("清单 memo 的键含 versionStamp：同戳内不重读磁盘，重新分析（换戳）当场生效", () => {
    const consumer = frontend();
    const provider = backend();
    roots.push(consumer.path, provider.path);
    expect(seamReportFor(consumer, provider).outbound.matched).toBe(2);

    // 磁盘改了但戳没变：读的仍是内存里那份清单
    writeFileSync(join(provider.path, "src/main/java/com/demo/PingController.java"), "package com.demo;\n\npublic class Gone {\n}\n", "utf8");
    expect(seamReportFor(consumer, provider).outbound.matched).toBe(2);
    // 换戳即重新分析，立刻按新内容重算
    expect(seamReportFor(consumer, { ...provider, versionStamp: "v2" }).outbound.matched).toBe(0);
  });
});

/** 清单文本每行带「文件:行」，匹配方式照实标。 */
describe("formatSeamReport", () => {
  it("列出双向落点、后缀匹配与歧义，filter 能收窄", async () => {
    const { formatSeamReport } = await import("./seams.js");
    const report: SeamReport = {
      repositoryId: "a", otherRepositoryId: "b",
      outbound: { scanned: 2, matched: 2, ambiguous: 1, links: [
        { route: "/api/shop/save", via: "exact", ambiguousWith: 1, consumer: { route: "/api/shop/save", path: "src/api.ts", line: 12, raw: "/api/shop/save" }, provider: { route: "/api/shop/save", path: "ShopController.java", line: 24, framework: "spring" } },
        { route: "/api/user/{*}", via: "suffix", ambiguousWith: 2, consumer: { route: "/api/user/{*}", path: "src/user.ts", line: 8, raw: "/user/{id}" }, provider: { route: "/user/{*}", path: "UserController.java", line: 31, framework: "spring" } }
      ] },
      inbound: { scanned: 0, matched: 0, ambiguous: 0, links: [] }
    };
    const text = formatSeamReport("backend", report);
    expect(text).toContain("ShopController.java:24");
    expect(text).toContain("发起方 src/api.ts:12");
    expect(text).toContain("按后缀配上");
    expect(text).toContain("2 个落点");
    expect(text).toContain("「backend」调用本仓：没有配对");
    expect(formatSeamReport("backend", report, "shop").split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });
});
