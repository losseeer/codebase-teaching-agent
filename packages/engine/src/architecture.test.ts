import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
  分层守卫：把 import 方向规则写成测试。
  结清的债判成恒为 0；没结清的记成只许下调的在册预算。
*/

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

const PIPELINES = new Set(["diagram", "exercises", "seams", "summarizer", "implementation", "turn", "indexer", "learner", "source"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "fixtures") continue;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** 一条 import 边；`typeOnly` = 编译期擦除的依赖。 */
interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
}

function edgesOf(path: string): Edge[] {
  const out: Edge[] = [];
  for (const match of readFileSync(path, "utf8").matchAll(/^\s*(?:import|export)([^;\n]*?)from\s+"([^"]+)";?/gm)) {
    const clause = match[1] ?? "";
    const specifier = match[2];
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(path), specifier).replace(/\.js$/, ".ts");
    if (!target.startsWith(SRC)) continue;
    out.push({ from: path, to: target, typeOnly: /^\s*type\b/.test(clause) });
  }
  return out;
}

const files = sourceFiles(SRC);
const allEdges = files.flatMap(edgesOf);
const valueEdges = allEdges.filter((edge) => !edge.typeOnly);

const short = (path: string): string => path.slice(SRC.length + 1);
const topOf = (path: string): string => short(path).split("/")[0] ?? "";
const list = (edges: Edge[]): string[] => edges.map((edge) => `${short(edge.from)} → ${short(edge.to)}`).sort();

/** 三条「不许指向应用层」的规则共用这一格放行判据：口子只开到 `application/port/` 为止。 */
const isPortEdge = (to: string): boolean => to.startsWith("application/port/");

/** 比字符串前先剥注释：注释正文里的名字不该当成代码。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("分层守卫", () => {
  it("没有模块 import 回 HTTP 装配 server.ts（这一条撑住整个拆层）", () => {
    expect(list(allEdges.filter((edge) => short(edge.to) === "server.ts"))).toEqual([]);
  });

  it("只有入站适配器与 server.ts 能碰 fastify", () => {
    const offenders = files.filter((file) => !short(file).startsWith("adapter/inbound/") && short(file) !== "server.ts" && codeOnly(readFileSync(file, "utf8")).includes("from \"fastify\"")).map(short);
    expect(offenders, `这些地方不该出现 fastify：${offenders.join(", ")}`).toEqual([]);
  });

  /**
    应用层的格子：`use-case/`、`port/`、`orchestration/`（回合流程）、`runtime/`（回合机制）。
    分档判据是换一个入口面还要不要重写一遍；命名后缀照这条读。
    */
  it("应用层不指向入站层，也不指向 HTTP 装配", () => {
    expect(list(allEdges.filter((edge) => short(edge.from).startsWith("application/") && (short(edge.to).startsWith("adapter/inbound/") || short(edge.to) === "server.ts")))).toEqual([]);
  });

  it("装配层（infrastructure/）不指向入站层，也不指向 HTTP 装配", () => {
    // 装配层指向 `adapter/outbound/` 是本职。
    const offenders = allEdges.filter((edge) => short(edge.from).startsWith("infrastructure/") && (short(edge.to).startsWith("adapter/inbound/") || short(edge.to) === "server.ts"));
    expect(list(offenders), `装配层反过来认识传输层：${list(offenders).join(", ")}`).toEqual([]);
  });

  it("分析管线不指向传输层与应用层，也不指向装配层——只有 application/port 例外（那是内层的接口）", () => {
    const offenders = allEdges.filter((edge) => {
      if (!PIPELINES.has(topOf(edge.from))) return false;
      const to = short(edge.to);
      if (isPortEdge(to)) return false;
      return to.startsWith("adapter/inbound/") || to.startsWith("application/") || to.startsWith("infrastructure/") || to === "server.ts";
    });
    expect(list(offenders)).toEqual([]);
  });

  it("持久层不许反过来认识领域（adapter/outbound/persistence 不该 import 管线或应用层的业务代码）", () => {
    // `application/port/` 与管线、出站适配器同一口径。
    const offenders = allEdges.filter((edge) => {
      if (!short(edge.from).startsWith("adapter/outbound/persistence/")) return false;
      const to = short(edge.to);
      if (isPortEdge(to)) return false;
      return PIPELINES.has(topOf(edge.to)) || to.startsWith("application/");
    });
    expect(list(offenders), `持久层反向依赖领域：${list(offenders).join(", ")}`).toEqual([]);
  });

  /**
    出站适配器只被装配层与内层调用，自己谁都不认识；实测零条边，判成恒为 0。
    实现方认端口那一格照常放行。
    */
  it("出站适配器不认识应用层、入站层与装配层", () => {
    const offenders = allEdges.filter((edge) => {
      if (!short(edge.from).startsWith("adapter/outbound/")) return false;
      const to = short(edge.to);
      if (isPortEdge(to)) return false;
      return to.startsWith("application/") || to.startsWith("adapter/inbound/") || to.startsWith("infrastructure/") || to === "server.ts";
    });
    expect(list(offenders), `适配器反向指向内层：${list(offenders).join(", ")}`).toEqual([]);
  });

  /**
    应用层只该认端口，不该认具体适配器；这条是在册预算，边数只许下调。
    结清方式是一类适配器一类换成参数注入；从组合根拿单例不算这笔债。
    */
  it("应用层指向具体适配器的边数只能减少（在册预算 13）", () => {
    const found = allEdges.filter((edge) => {
      const from = short(edge.from);
      if (!from.startsWith("application/") || from.startsWith("application/port/")) return false;
      return short(edge.to).startsWith("adapter/outbound/");
    });
    expect(list(found), `应用层还认识这些适配器：\n${list(found).join("\n")}`).toHaveLength(13);
  });

  it("`packages/analysis` 只有一个公共面：不许深路径 import 包内文件", () => {
    // 不许深路径 import `@codebase-tutor/analysis`。
    const offenders = files.filter((file) => /from "@codebase-tutor\/analysis\//.test(readFileSync(file, "utf8"))).map(short);
    expect(offenders, `绕过 index.ts 的深路径 import：${offenders.join(", ")}`).toEqual([]);
  });

  it("跨包方向：引擎与界面都不许被对方 import", () => {
    const hits = files.filter((file) => /from "@codebase-tutor\/(gui|engine)"/.test(readFileSync(file, "utf8"))).map(short);
    expect(hits, `跨包 import（共享的东西住 shared）：${hits.join(", ")}`).toEqual([]);
  });

  it("L2 缓存键只能由登记过的步骤构造：layerCacheKey 只许在 analysis-step.ts 里被调用", () => {
    const offenders = files.filter((file) => short(file) !== "analysis-step.ts" && codeOnly(readFileSync(file, "utf8")).includes("layerCacheKey(")).map(short);
    expect(offenders, `这些文件在绕过口径登记直接造键：${offenders.join(", ")}`).toEqual([]);
  });

  it("引擎内部没有循环依赖（import type 不算，它编译期就没了）", () => {
    const graph = new Map<string, string[]>(files.map((file) => [file, valueEdges.filter((edge) => edge.from === file).map((edge) => edge.to)]));
    const cycles: string[] = [];
    const visiting: string[] = [];
    const done = new Set<string>();
    const walk = (node: string): void => {
      if (done.has(node)) return;
      if (visiting.includes(node)) {
        cycles.push([...visiting.slice(visiting.indexOf(node)), node].map(short).join(" → "));
        return;
      }
      visiting.push(node);
      for (const next of graph.get(node) ?? []) if (graph.has(next)) walk(next);
      visiting.pop();
      done.add(node);
    };
    for (const file of files) walk(file);
    expect(cycles, `出现循环依赖：${cycles.join(" ｜ ")}`).toEqual([]);
  });

  /** 管线不直接落持久层，一律经参数传端口；这条判成恒为 0。 */
  it("分析管线不直接落持久层（已结清，恒为 0）", () => {
    const found = list(allEdges.filter((edge) => PIPELINES.has(topOf(edge.from)) && short(edge.to).startsWith("adapter/outbound/persistence/")));
    expect(found, `管线还在直接落持久层：\n${found.join("\n")}`).toEqual([]);
  });
});
