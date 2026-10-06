import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "@codebase-tutor/shared";
import { clearSeamMemo, seamReportFor, type SeamRepository } from "./seams.js";

/**
  跨仓接缝配对：两个临时小仓当 fixture（一个是 Vue/TS 前端形态、一个是 Spring 后端形态）。
  钉的是「配得上、方向不混、后缀匹配要标出来」——这三件事任何一件错，界面上就会给出误导性的链。
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
    // 网关前缀那一类只能靠后缀整段匹配，必须标成 suffix，不混进整段相等
    expect(report.outbound.links.filter((link) => link.via === "suffix").map((link) => `${link.route}→${link.provider.path}`)).toEqual(["/api/probe/health→src/main/java/com/demo/PingController.java"]);
    expect(report.outbound.links[0].provider.line).toBe(6);
    // 反向不该有：后端没有调用串
    expect(report.inbound.scanned).toBe(0);
    expect(report.inbound.links).toEqual([]);
  });

  it("清单 memo 的键含 versionStamp：同戳内不重读磁盘，重新分析（换戳）当场生效", () => {
    const consumer = frontend();
    const provider = backend();
    roots.push(consumer.path, provider.path);
    expect(seamReportFor(consumer, provider).outbound.matched).toBe(2);

    // 磁盘上把控制器删空，但戳没变：读的还是内存里那份清单——这是「按需算 + 按内容戳缓存」的既定取舍，
    // 真实链路里删文件会让重新分析翻 versionStamp，不会长期停留在旧清单
    writeFileSync(join(provider.path, "src/main/java/com/demo/PingController.java"), "package com.demo;\n\npublic class Gone {\n}\n", "utf8");
    expect(seamReportFor(consumer, provider).outbound.matched).toBe(2);
    // 换了戳（等于重新分析过一次）：立刻按新内容重算，一条也配不上
    expect(seamReportFor(consumer, { ...provider, versionStamp: "v2" }).outbound.matched).toBe(0);
  });
});
