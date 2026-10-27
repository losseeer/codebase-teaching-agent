import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
  分层守卫：把 import 方向规则写成测试——谁都不许 import 回 HTTP 装配 `server.ts`，
  应用层不指向传输层，装配层（`infrastructure/`）不指向入站层，管线与持久层单向，跨包不互 import。
  一条债结清就把判据收紧成恒为 0（「管线只认端口、不直接落库」10-27 结清）；
  没结清的记成只许下调的在册预算（「应用层认识具体适配器」37 条）。
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
  it("没有模块 import 回 HTTP 装配 server.ts（这一条撑住整个拆层）", () => {
    expect(list(allEdges.filter((edge) => short(edge.to) === "server.ts"))).toEqual([]);
  });

  it("只有入站适配器与 server.ts 能碰 fastify", () => {
    const offenders = files.filter((file) => !short(file).startsWith("adapter/inbound/") && short(file) !== "server.ts" && codeOnly(readFileSync(file, "utf8")).includes("from \"fastify\"")).map(short);
    expect(offenders, `这些地方不该出现 fastify：${offenders.join(", ")}`).toEqual([]);
  });

  it("应用层不指向入站层，也不指向 HTTP 装配", () => {
    expect(list(allEdges.filter((edge) => short(edge.from).startsWith("application/") && (short(edge.to).startsWith("adapter/inbound/") || short(edge.to) === "server.ts")))).toEqual([]);
  });

  it("装配层（infrastructure/）不指向入站层，也不指向 HTTP 装配", () => {
    // 指向 `adapter/outbound/` 是这一层的本职：端口在这里接到具体适配器
    const offenders = allEdges.filter((edge) => short(edge.from).startsWith("infrastructure/") && (short(edge.to).startsWith("adapter/inbound/") || short(edge.to) === "server.ts"));
    expect(list(offenders), `装配层反过来认识传输层：${list(offenders).join(", ")}`).toEqual([]);
  });

  it("分析管线不指向传输层与应用层，也不指向装配层——只有 application/port 例外（那是内层的接口）", () => {
    const offenders = allEdges.filter((edge) => {
      if (!PIPELINES.has(topOf(edge.from))) return false;
      const to = short(edge.to);
      // 端口是管线自己声明的需求：零依赖、只有接口，引它不等于「管线认识应用层」。
      // 口子只开到这个目录为止，多引一个应用层文件照样红。
      if (to.startsWith("application/port/")) return false;
      return to.startsWith("adapter/inbound/") || to.startsWith("application/") || to.startsWith("infrastructure/") || to === "server.ts";
    });
    expect(list(offenders)).toEqual([]);
  });

  it("持久层不许反过来认识领域（adapter/outbound/persistence 不该 import 管线或应用层）", () => {
    const offenders = allEdges.filter((edge) => short(edge.from).startsWith("adapter/outbound/persistence/") && (PIPELINES.has(topOf(edge.to)) || short(edge.to).startsWith("application/")));
    expect(list(offenders), `持久层反向依赖领域：${list(offenders).join(", ")}`).toEqual([]);
  });

  /**
    出站适配器（`adapter/outbound/`：持久层、模型调用、沙箱、外部工具、来源与密钥筛）是这一轮才落地的目录名，
    这条规则就是让它名副其实的那一格：适配器只被装配层与内层调用，自己谁都不认识——
    实测过零条边，所以判成恒为 0；一旦有适配器 import 回应用层，就是「端口又被人从后面绕进来了」。
    口子与管线那条同一口径：`application/port/` 是内层声明的接口，实现方认它是方向正确的（`provider.ts` 里那几个类要 `implements`）。
    */
  it("出站适配器不认识应用层、入站层与装配层", () => {
    const offenders = allEdges.filter((edge) => {
      if (!short(edge.from).startsWith("adapter/outbound/")) return false;
      const to = short(edge.to);
      if (to.startsWith("application/port/")) return false;
      return to.startsWith("application/") || to.startsWith("adapter/inbound/") || to.startsWith("infrastructure/") || to === "server.ts";
    });
    expect(list(offenders), `适配器反向指向内层：${list(offenders).join(", ")}`).toEqual([]);
  });

  /**
    应用层只该认端口，不该认具体适配器（`adapter/outbound/` 下的持久层、模型调用、沙箱、外部工具、来源与密钥筛）。
    这一条还是**在册预算**而不是恒为 0：28 条边（type-only 也算，多一处定义就多一处失真）散在 16 个文件里，
    结清的方式是一类适配器一类适配器地换成参数注入——`application/port/` 那七个口就是这么长出来的。
    数字只许下调：某片搬完后守卫会主动报「债少了，把数字改小」。
    从组合根（`infrastructure/composition-root.ts`）拿单例不算这笔债：那是装配层交给应用层的入口，不是适配器。
    10-27 三笔下降：端口装配落 `infrastructure/`（43 → 37）；审计线写入口挂到挂载项 `repository.audit` 上（37 → 34，
    `diagrams` / `paid-turn` / `scoped-turn` 三份不再自己按路径 new）；模型调用的协议类型与 `LlmProvider` 接口进
    `application/port/llm-provider.ts`（34 → 28）。留下的 `journal.ts` 边是**读侧**（`readJournal`）与 payload 拼形（`turnTextPayload`），那是两种不同的东西，分开结。
    */
  it("应用层指向具体适配器的边数只能减少（在册预算 28）", () => {
    const found = allEdges.filter((edge) => {
      const from = short(edge.from);
      if (!from.startsWith("application/") || from.startsWith("application/port/")) return false;
      return short(edge.to).startsWith("adapter/outbound/");
    });
    expect(list(found), `应用层还认识这些适配器：\n${list(found).join("\n")}`).toHaveLength(28);
  });

  it("`packages/analysis` 只有一个公共面：不许深路径 import 包内文件", () => {
    // 那句话写在 analysis 的 index.ts 头上，这条测试负责让它是真的：深路径引进来，包内怎么重组都不自由
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

  /**
    这笔债结清了（10-27）：管线模块不再直接落 `adapter/outbound/persistence/`，一律经参数把端口传进来
    （`application/port/` 那五个口：SummaryStore / ExerciseStore / ProgressStore / AuditSink / DiagramStore，
    适配器由装配层在 `pin()` 的范围内构造）。
    所以这条从「恰好等于在册条数、只能变小」升级成恒为 0——再多一条就是回潮，不是记账。
    */
  it("分析管线不直接落持久层（已结清，恒为 0）", () => {
    const found = list(allEdges.filter((edge) => PIPELINES.has(topOf(edge.from)) && short(edge.to).startsWith("adapter/outbound/persistence/")));
    expect(found, `管线还在直接落持久层：\n${found.join("\n")}`).toEqual([]);
  });
});
