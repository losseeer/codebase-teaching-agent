import { CONTEXT_SHARE, contextShare, contextShareLines } from "../llm/context-window.js";
import type {
  CfgFileFact,
  CfgFunction,
  DataflowFileFact,
  FactKind,
  RegistryEntry,
  RegistryFileFact,
  TypeRelationFileFact
} from "@codebase-tutor/domain";
import { FACT_KINDS } from "@codebase-tutor/domain";

import type { TutorDatabase } from "../store/database.js";
import type { LlmTool } from "../llm/provider.js";
import type { FactsToolContext } from "../source/tool-loop.js";
import { FACTS_VERSION } from "@codebase-tutor/analysis";

/**
  把 `static_fact` 里的四类产物交给模型的只读门。
  - 只读、不计费、不重算：只搬运已算好的读数。
  - 按指针给：`path` 与 `target` 决定给多少，一次最多回这么多字；整仓产物是 2~4 MB，不整份进上下文。
*/

/* 一次查询的预算按窗口份额派生：整仓产物是 2~4 MB，不整份进上下文，但也不该手填一个小数字把读数切没。 */
function budgetChars(): number {
  return contextShare(CONTEXT_SHARE.factsQuery);
}

function budgetLines(): number {
  return contextShareLines(CONTEXT_SHARE.factsQuery);
}

const KINDS = new Set<string>(FACT_KINDS);

function arg(argumentsJson: string, key: string): string {
  try {
    const value = (JSON.parse(argumentsJson || "{}") as Record<string, unknown>)[key];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

const at = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/**
  截断前先声明还剩多少：那条声明是读数的一部分。
  条数只按 `items` 算，表头与尾部提示不占「没列出」的名额。
*/
function emit(heads: string[], items: string[], tails: string[] = []): string {
  const chars = budgetChars();
  const cap = Math.max(1, budgetLines() - heads.length - tails.length);
  const kept = items.slice(0, cap);
  const omitted = items.length - kept.length;
  const lines = [...heads, ...kept, ...(omitted ? [`…另有 ${omitted} 条没列出：换个 path 或 target 再查。`] : []), ...tails];
  const text = lines.join("\n");
  return text.length > chars ? `${text.slice(0, chars)}\n…（本次输出已到 ${chars} 字上限，请缩小查询范围）` : text;
}

function blockLine(functionGraph: CfgFunction): string {
  const notes = [
    functionGraph.truncated ? "块数打满上限（图不完整）" : "",
    ...(functionGraph.notes ?? []).map((note) => `接不上：${note}`)
  ].filter(Boolean);
  return `${functionGraph.name}@${functionGraph.startLine}-${functionGraph.endLine} 复杂度 ${functionGraph.complexity}，块 ${functionGraph.blocks.length}、边 ${functionGraph.edges.length}，出口块 ${functionGraph.exitBlocks.join("/") || "无"}${notes.length ? `；${notes.join("；")}` : ""}`;
}

const skips = (fact: { skipped?: { name: string; reason: string }[] }): string[] =>
  (fact.skipped ?? []).map((item) => `未成图：${item.name} —— ${item.reason}`);

/** 每份产物先报「用什么算的」：backend 为 none 时后面的空读数是「没算出来」，不是「仓库里没有」。 */
const head = (fact: { language: string; backend: string; skipped?: { reason: string }[] }): string =>
  `语言 ${fact.language}，backend ${fact.backend}${fact.backend === "none" && fact.skipped ? `（${fact.skipped.map((item) => item.reason).join("；")}）` : ""}`;

interface Named {
  name: string;
}

/** 先按名字全等，再退到包含：模型报的名字常常是 `handle` 而产物里是 `handleOrder`。 */
const pick = <T extends Named>(items: T[], target: string): T | undefined =>
  target ? items.find((item) => item.name === target) ?? items.find((item) => item.name.toLowerCase().includes(target.toLowerCase())) : undefined;

const notInFile = (items: Named[], target: string): string => `这个文件里没有名字含「${target}」的函数体；有的：${items.map((item) => item.name).join(" / ") || "无"}`;

function dataflowLine(variable: DataflowFileFact["functions"][number]["variables"][number]): string {
  const defs = variable.defs.map((site) => `${site.line}(${site.role})`).join(" ");
  const uses = variable.uses.slice(0, 8).map((use) => `${use.line}←[${use.reaches.join(",")}]`).join(" ");
  return `${variable.name}：定义 ${defs || "无"}｜读到 ${variable.uses.length} 次 ${uses}${variable.uses.length > 8 ? ` …另 ${variable.uses.length - 8} 次` : ""}`;
}

const relationLine = (owner: string, edge: TypeRelationFileFact["types"][number]["relations"][number]): string =>
  `${owner} -${edge.kind}-> ${edge.to}${edge.toFile ? `（${edge.toFile}）` : ""}${edge.ambiguous ? `（同名多解：${edge.ambiguous.join(" / ")}）` : ""} @${edge.line} 依据:${edge.via}`;

const entryLine = (path: string, entry: RegistryEntry): string =>
  `${path}:${entry.line} ${entry.kind} ${entry.name}${entry.target ? ` → ${entry.target}` : ""}${entry.method ? ` ${entry.method}` : ""}（${entry.via}）`;

function missing(kind: FactKind, db: TutorDatabase, repositoryId: string, path: string): string {
  const stored = db.getFileFact<{ version?: string }>(repositoryId, kind, path);
  if (stored && stored.version !== FACTS_VERSION) return `这个文件的 ${kind} 产物是旧判据算的（产物 version=${stored.version ?? "没写过版本"}，当前 ${FACTS_VERSION}），不作为现行读数给出；要用它先重新分析这个仓。`;
  const covered = db.factCoverage(repositoryId).some((row) => row.kind === kind);
  return covered
    ? `这类产物（${kind}）在本仓有行，但这个文件不在其中：可能它没有可执行体，也可能路径写错了。`
    : `本仓还没有 ${kind} 这类产物（从没算过，或产物比代码旧）。不要据此回答「仓库里没有这个关系」——先让用户重新分析。`;
}

/**
  产物查询门的实现（装配在 `application/canvas-tools.ts`：路由只认装配层，不直接 import 领域模块）。
  `target` 在 cfg/dataflow 里是函数名，在 typeRelations/registry 里是类型名或条目名。
*/
export function factsQueryTool(db: TutorDatabase, repositoryId: string): FactsToolContext {
  // 判据改过版（`FACTS_VERSION` 翻过）的旧行不再当现行读数交给模型：那是另一套判据算出来的结果
  const rowsOf = <T>(kind: FactKind, path: string): T | undefined => {
    const fact = db.getFileFact<T & { version?: string }>(repositoryId, kind, path);
    return fact?.version === FACTS_VERSION ? fact : undefined;
  };
  // 整类扫描要解析这一类每一行 JSON（一个仓 2~4 MB）：这扇门只活一个回合，按类别缓存一次
  const scanned = new Map<FactKind, Map<string, unknown>>();
  const scan = <T>(kind: FactKind): Map<string, T> => {
    const cached = scanned.get(kind) as Map<string, T> | undefined;
    if (cached) return cached;
    const loaded = db.listFileFacts<T & { version?: string }>(repositoryId, kind);
    // 「全仓找」这条路与按 path 取读必须同一道版本闸，否则旧判据产物从 scan 那边照样进模型
    for (const [factPath, fact] of loaded) if (fact?.version !== FACTS_VERSION) loaded.delete(factPath);
    scanned.set(kind, loaded as Map<string, unknown>);
    return loaded;
  };

  const coverage = (): string[] => {
    const stamps = db.factStamps(repositoryId);
    if (!stamps.length) return ["本仓没有任何静态产物（还没导入完成，或导入时这一层没算成）。"];
    const counts = db.factCoverage(repositoryId);
    return [
      `静态产物（按文件存，一次给一个指针）：${counts.map((row) => `${row.kind} ${row.files} 文件/${Math.round(row.bytes / 1024)} KB`).join("、")}`,
      `批次时间：${stamps.map((row) => `${row.kind} ${at(row.lastAt)}`).join("、")}。产物比代码旧时读数会漂，别当成实时的。`,
      "取法：path 给文件；cfg/dataflow 再加 target（函数名）出块与边、定义与使用；typeRelations/registry 加 target（类型名或条目名）全仓找。"
    ];
  };

  return {
    inventory: (() => {
      const counts = db.factCoverage(repositoryId);
      return counts.length ? `静态产物在册：${counts.map((row) => `${row.kind} ${row.files} 文件`).join("、")}。要用结构证据（分支、类型关系、注册绑定）就先调 query_facts，别凭印象说。` : "本仓还没有静态产物：结构类问题只能靠 read_file 读源码回答，并要说明没做过静态核对。";
    })(),
    apply: (argumentsJson: string) => {
      const raw = arg(argumentsJson, "kind");
      const path = arg(argumentsJson, "path");
      const target = arg(argumentsJson, "target");
      if (!raw) return emit([], coverage());
      if (!KINDS.has(raw)) return `kind 只认 ${FACT_KINDS.join(" / ")}；不给 kind 就回覆盖率清单。`;
      const kind = raw as FactKind;

      if (!path && !target) return emit([], coverage(), [`（这次要的是 ${kind}：给 path 取一个文件的读数，或给 target 全仓找。）`]);

      const needle = target.toLowerCase();
      if (target && !path) {
        const lines: string[] = [];
        if (kind === "typeRelations") {
          for (const [file, fact] of scan<TypeRelationFileFact>(kind)) {
            for (const type of fact.types.filter((item) => item.name.toLowerCase().includes(needle))) {
              lines.push(...(type.relations.length ? type.relations.map((edge) => relationLine(`${file}:${type.name}`, edge)) : [`${file}:${type.name}（${type.kind}@${type.line}）没有类型边`]));
            }
          }
        } else if (kind === "registry") {
          for (const [file, fact] of scan<RegistryFileFact>(kind)) {
            lines.push(...fact.entries.filter((entry) => `${entry.name} ${entry.target ?? ""}`.toLowerCase().includes(needle)).map((entry) => entryLine(file, entry)));
          }
        } else {
          // cfg 与 dataflow 的函数清单形状一致（都有 name/startLine），这里只报文件与行号，展开要带 path
          const names = kind === "cfg" ? [...scan<CfgFileFact>(kind).entries()] : [...scan<DataflowFileFact>(kind).entries()];
          for (const [file, fact] of names) {
            lines.push(...fact.functions.filter((item) => item.name.toLowerCase().includes(needle)).map((item) => `${file}:${item.startLine} ${item.name}`));
          }
        }
        return lines.length ? emit([], lines) : `全仓没有名字含「${target}」的 ${kind} 读数。这不能证明关系不存在：可能是动态派发、反射、宏或产物比代码旧。`;
      }

      if (kind === "cfg") {
        const fact = rowsOf<CfgFileFact>(kind, path);
        if (!fact) return missing(kind, db, repositoryId, path);
        const base = head(fact);
        const hit = pick(fact.functions, target);
        if (target && !hit) return notInFile(fact.functions, target);
        if (hit) {
          const blocks = hit.blocks.map((block) => `  块 ${block.id} ${block.kind} [${block.startLine}-${block.endLine}] 语句 ${block.statements.length}${block.statements.length ? `（${block.statements.slice(0, 6).join(", ")}${block.statements.length > 6 ? "…" : ""}）` : ""}`);
          const edges = hit.edges.map((edge) => `  边 ${edge.from} → ${edge.to}（${edge.kind}）`);
          return emit([base, blockLine(hit)], [...blocks, ...edges], skips(fact));
        }
        return emit([base], fact.functions.map((item) => `${item.name}@${item.startLine}-${item.endLine} 复杂度 ${item.complexity}，块 ${item.blocks.length}、边 ${item.edges.length}`), [...skips(fact), "（要看某个函数的块与边，加 target=函数名）"]);
      }

      if (kind === "dataflow") {
        const fact = rowsOf<DataflowFileFact>(kind, path);
        if (!fact) return missing(kind, db, repositoryId, path);
        const base = head(fact);
        const hit = pick(fact.functions, target);
        if (target && !hit) return notInFile(fact.functions, target);
        if (hit) {
          const variables = hit.variables.map(dataflowLine);
          const unresolved = hit.unresolved?.length ? [`读不到可达定义的 ${hit.unresolved.length} 处：${hit.unresolved.slice(0, 20).map((item) => `${item.name}@${item.line}`).join(" ")}${hit.unresolved.length > 20 ? ` …另 ${hit.unresolved.length - 20} 处` : ""}`] : [];
          return emit([base, `${hit.name}@${hit.startLine}-${hit.endLine} 变量 ${hit.variables.length}${hit.truncated ? "（已截断，只留前面的）" : ""}`], [...variables, ...unresolved]);
        }
        return emit([base], fact.functions.map((item) => `${item.name}@${item.startLine}-${item.endLine} 变量 ${item.variables.length}、读到 ${item.variables.reduce((sum, variable) => sum + variable.uses.length, 0)}`), [...skips(fact), "（要看定义与使用点，加 target=函数名）"]);
      }

      if (kind === "typeRelations") {
        const fact = rowsOf<TypeRelationFileFact>(kind, path);
        if (!fact) return missing(kind, db, repositoryId, path);
        if (!fact.types.length) return `${head(fact)}\n这个文件有产物行，但没声明任何具名类型（标量与内置类型按设计不进这张表）。`;
        return emit([head(fact)], fact.types.flatMap((type) => [`${type.name}（${type.kind}@${type.line}-${type.endLine}）${type.truncated ? " 边已截断" : ""}`, ...type.relations.map((edge) => `  ${relationLine(type.name, edge)}`)]), skips(fact));
      }

      const fact = rowsOf<RegistryFileFact>(kind, path);
      if (!fact) return missing(kind, db, repositoryId, path);
      const entries = target ? fact.entries.filter((entry) => `${entry.name} ${entry.target ?? ""}`.toLowerCase().includes(needle)) : fact.entries;
      if (!entries.length) return `${head(fact)}\n这个文件进了注册索引，但${target ? `没有名字含「${target}」的条目` : "没认出任一条目（配置文件只记键名，值不抄）"}。`;
      const digest = entries.reduce<Record<string, number>>((acc, entry) => ({ ...acc, [entry.kind]: (acc[entry.kind] ?? 0) + 1 }), {});
      return emit([head(fact), `条目 ${entries.length}：${Object.entries(digest).map(([name, count]) => `${name} ${count}`).join("、")}`], entries.map((entry) => `  ${entryLine(path, entry)}`));
    }
  };
}

/**
  静态产物的只读门，与 `set_diagram` 配对：那边写图，这边给证据。
  不重算任何东西——绘图阶段的职责边界就是只消费导入时已算好的产物。
*/
export const QUERY_FACTS_TOOL: LlmTool = {
  name: "query_facts",
  description: "查这个仓已经算好的静态分析产物（只搬已有读数，不会重新分析）。不给 kind 就回覆盖率清单：哪几类在册、各多少文件、算于何时——规划要画什么之前先调它。kind 四选一：cfg（函数内的节点、边、圈复杂度、出口）、dataflow（变量在哪行定义、哪些行读到、哪些读不到定义）、typeRelations（继承/实现/字段/参数/返回/泛型这些边，以及反查到的仓内文件）、registry（路由登记、依赖注入绑定、SPI 清单、构建清单里的键）。path 给一个文件取它那份；target 全仓找（cfg/dataflow 填函数名，typeRelations/registry 填类型名或条目名）。画架构图、流程图、时序图前先来这里取证据，别凭印象连线。「查不到不等于仓库里没有」：动态派发、反射、宏与异步事件不在产物里，那种关系要照实说「未证实」。",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", description: "cfg / dataflow / typeRelations / registry；省略就回覆盖率清单" },
      path: { type: "string", description: "仓内相对路径，如 src/order/Service.java" },
      target: { type: "string", description: "函数名（cfg、dataflow）或类型名/条目名（typeRelations、registry）" }
    },
    required: []
  }
};
