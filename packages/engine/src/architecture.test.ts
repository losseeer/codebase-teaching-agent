import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
  分层守卫。它管的不是风格，而是这一轮重构**唯一会无声回退**的东西。
  我们把服务与组合根从 `server.ts` 搬出去（`services.ts` / `application/**` / `http/**`），
  靠的是一条方向规则：谁都不许 import 回 `server.ts`。这条规则以前只写在提交信息里——
  下一个人为了拿单例把 `import { importer } from "../server.js"` 写回去，类型不红、行为测试也不红，
  分层当天就没了。所以把它写成测试，跟 771 条行为测试一起跑（零新依赖，CI 一行都不用改）。

  还没做到的那条（管线只认端口、不直接落库）不假装存在：用一个**只能下调的预算**记在账上，
  而不是抄一份 45 行的边清单——逐边清单会因为一次 import 换行就误报，那种测试第一天就没人信。
*/

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

/** 离线脚本与评测夹具允许走自己的路：它们不是产品运行路径，也不参与分层。 */
const IGNORED_TOP = new Set(["scripts", "mcp", "eval"]);

const PIPELINES = new Set(["flows", "coursetree", "diagram", "exercises", "depgraph", "summarizer", "implementation", "quality", "changes", "scopechat", "harness", "text", "indexer", "learner", "source"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "scripts" || entry === "fixtures") continue;
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

const files = sourceFiles(SRC).filter((file) => !IGNORED_TOP.has(file.slice(SRC.length + 1).split("/")[0] ?? ""));
const allEdges = files.flatMap(edgesOf);
const valueEdges = allEdges.filter((edge) => !edge.typeOnly);

const short = (path: string): string => path.slice(SRC.length + 1);
const topOf = (path: string): string => short(path).split("/")[0] ?? "";
const list = (edges: Edge[]): string[] => edges.map((edge) => `${short(edge.from)} → ${short(edge.to)}`).sort();

/**
  注释剥掉再比字符串。这一条不是讲究：这个仓的块注释续行**不以 `*` 开头**（是缩进正文），
  按行首猜会把「文档里提到某个函数名」当成调用——`store/database.ts` 的缓存说明正好中招过。
*/
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
    已知这笔债，用「条数」记而不是「逐条清单」记：管线模块还在直接落 `store/`（拿句柄类型、读覆盖层、
    写摘要表）。理想形态是这些一律由参数把端口传进来。逐条清单会因为一次换行就误报、进而没人信这份测试，
    所以这里钉的是**条数恰好等于登记值**：改掉一条就把数字调小（变大与变小都会被拦下来，
    数字因此始终是真实债务的读数，不会悄悄过期）。
    */
  const STORE_DEBT_LINES = 12;

  it(`管线直接落到 store/ 的依赖恰好等于在册条数（现 ${STORE_DEBT_LINES} 条，只能变小）`, () => {
    const found = list(allEdges.filter((edge) => PIPELINES.has(topOf(edge.from)) && topOf(edge.to) === "store"));
    expect(found.length, found.length > STORE_DEBT_LINES ? `管线直接落 store 的依赖涨了（${STORE_DEBT_LINES} → ${found.length}）：\n${found.join("\n")}` : `债少了 ${STORE_DEBT_LINES} → ${found.length}，把在册数字改小：\n${found.join("\n")}`).toBe(STORE_DEBT_LINES);
  });
});
