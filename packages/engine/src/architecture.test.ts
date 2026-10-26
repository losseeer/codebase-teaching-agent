import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
  分层守卫：把 import 方向规则写成测试——谁都不许 import 回 `server.ts`，
  应用层不指向传输层，管线与持久层单向，跨包不互 import。
  尚未达成的那条（管线只认端口、不直接落库）用只能下调的条数预算记在账上。
*/

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

const PIPELINES = new Set(["diagram", "exercises", "depgraph", "summarizer", "implementation", "turn", "indexer", "learner", "source"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "fixtures") continue;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** 一条 import 边：`typeOnly` 区分「编译期就擦掉」的依赖（不构成运行时环，也不算 I-O 耦合）。 */
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

/** 比字符串前先剥注释：本仓块注释续行不以 `*` 开头，按行首粗滤会把注释正文里提到的名字当成代码。 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("分层守卫", () => {
  it("没有模块 import 回组合根 server.ts（这一条撑住整个拆层）", () => {
    expect(list(allEdges.filter((edge) => short(edge.to) === "server.ts"))).toEqual([]);
  });

  it("只有 http 层与 server.ts 能碰 fastify", () => {
    const offenders = files.filter((file) => !short(file).startsWith("http/") && short(file) !== "server.ts" && codeOnly(readFileSync(file, "utf8")).includes("from \"fastify\"")).map(short);
    expect(offenders, `这些地方不该出现 fastify：${offenders.join(", ")}`).toEqual([]);
  });

  it("应用层不指向传输层，也不指向 HTTP 装配", () => {
    expect(list(allEdges.filter((edge) => short(edge.from).startsWith("application/") && (short(edge.to).startsWith("http/") || short(edge.to) === "server.ts")))).toEqual([]);
  });

  it("组合根 services.ts 不指向传输层", () => {
    expect(list(allEdges.filter((edge) => short(edge.from) === "services.ts" && short(edge.to).startsWith("http/")))).toEqual([]);
  });

  it("分析管线不指向传输层，也不指向应用层（管线之间另有在册清单）", () => {
    const offenders = allEdges.filter((edge) => PIPELINES.has(topOf(edge.from)) && (short(edge.to).startsWith("http/") || short(edge.to).startsWith("application/") || short(edge.to) === "services.ts" || short(edge.to) === "server.ts"));
    expect(list(offenders)).toEqual([]);
  });

  it("持久层不许反过来认识领域（store/ 不该 import 管线或应用层）", () => {
    const offenders = allEdges.filter((edge) => topOf(edge.from) === "store" && (PIPELINES.has(topOf(edge.to)) || short(edge.to).startsWith("application/")));
    expect(list(offenders), `持久层反向依赖领域：${list(offenders).join(", ")}`).toEqual([]);
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

  /**
    已知这笔债：管线模块还在直接落 `store/`，理想形态是由参数把端口传进来。
    账按条数记：恰好等于登记值，改掉一条就把数字调小，变大变小都会被拦下。
    */
  const STORE_DEBT_LINES = 6;

  it(`管线直接落到 store/ 的依赖恰好等于在册条数（现 ${STORE_DEBT_LINES} 条，只能变小）`, () => {
    const found = list(allEdges.filter((edge) => PIPELINES.has(topOf(edge.from)) && topOf(edge.to) === "store"));
    expect(found.length, found.length > STORE_DEBT_LINES ? `管线直接落 store 的依赖涨了（${STORE_DEBT_LINES} → ${found.length}）：\n${found.join("\n")}` : `债少了 ${STORE_DEBT_LINES} → ${found.length}，把在册数字改小：\n${found.join("\n")}`).toBe(STORE_DEBT_LINES);
  });
});
