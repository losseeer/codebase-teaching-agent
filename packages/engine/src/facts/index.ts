import type { CfgFileFact, DeclaredType, DataflowFileFact, DataflowFunctionFact, FactKind, FactSkip, FileEntry, SymbolInfo, TypeRelationFileFact } from "@codebase-tutor/shared";
import { languageCapabilitiesOf } from "@codebase-tutor/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TutorDatabase } from "../store/database.js";
import type { SyntaxNode } from "../depgraph/parser.js";
import { eachFunction } from "./cfg.js";
import { graphExtensions } from "../depgraph/graph.js";
import { analyzeFunctionDataflow } from "./dataflow.js";
import { analyzeFileTypes } from "./types.js";
import { FACTS_VERSION } from "./version.js";

/**
  静态产物层的总装：**一个文件解析一次，产出所有类别的读数**。

  为什么合在一趟里：语法树解析是全仓最贵的一步，每多一类产物就多扫一遍源码
  （复审 #170 就记过「一轮两遍全仓读」这笔账）。各产物之间还要靠同一份块 id 对齐，
  分开算等于让两份图各自漂移。

  与依赖图分家（见 `store/database.ts` 里 `static_fact` 那段）：这些产物是确定性重算的，
  不进 `analysis_json`、不进 `backendStamp`、不参与任何缓存键——加一类分析绝不该让
  已导入的仓重烧付费调用。源码在这里再读一遍：图那边读完就丢了内容，
  为省一遍磁盘读把 Map 穿到三处调用方不值得。
*/
export interface FileFactRow {
  kind: FactKind;
  path: string;
  payload: unknown;
}

export interface FileFacts {
  cfg: CfgFileFact;
  dataflow: DataflowFileFact;
  types: TypeRelationFileFact;
}

export function analyzeFile(path: string, content: string, symbols: SymbolInfo[], language: string, allSymbols: SymbolInfo[] = symbols): FileFacts {
  const flows: DataflowFunctionFact[] = [];
  const types: DeclaredType[] = [];
  const typeSkips: FactSkip[] = [];
  const onRoot = (root: SyntaxNode): void => {
    const fact = analyzeFileTypes(path, root, language, allSymbols);
    types.push(...fact.types);
    typeSkips.push(...(fact.skipped ?? []));
  };
  const cfg = eachFunction(path, content, symbols, language, (scope) => void flows.push(analyzeFunctionDataflow(scope)), onRoot);
  // backend 跟着图走：没有语法树就没有任何一份产物，`skipped` 里那句原因对三类产物同时成立
  const shared = { path, language, backend: cfg.backend, version: FACTS_VERSION };
  return {
    cfg,
    dataflow: { ...shared, functions: flows.sort((left, right) => left.startLine - right.startLine), ...(cfg.skipped ? { skipped: cfg.skipped } : {}) },
    types: { ...shared, types: types.sort((left, right) => left.line - right.line), ...(typeSkips.length ? { skipped: typeSkips } : {}) }
  };
}

export function collectFileFacts(repositoryPath: string, files: FileEntry[], symbols: SymbolInfo[]): FileFactRow[] {
  const rows: FileFactRow[] = [];
  const byPath = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) byPath.set(symbol.path, [...(byPath.get(symbol.path) ?? []), symbol]);
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    // 没有语法就没有任何产物：文档、样式、配置走不到这里，也不会留下一行「算过、是空的」
    if (!graphExtensions.includes(file.extension.toLowerCase())) continue;
    let content: string;
    try {
      content = readFileSync(join(repositoryPath, file.path), "utf8");
    } catch {
      // 扫描期就读不到的文件已经在 `RepositoryIndex.unreadable` 里记过名，这里不再重复报一条
      continue;
    }
    const facts = analyzeFile(file.path, content, byPath.get(file.path) ?? [], languageCapabilitiesOf(file.path).language, symbols);
    rows.push({ kind: "cfg", path: file.path, payload: facts.cfg });
    rows.push({ kind: "dataflow", path: file.path, payload: facts.dataflow });
    rows.push({ kind: "typeRelations", path: file.path, payload: facts.types });
  }
  return rows;
}

/**
  整批落库，按类别各存一次 `replaceAll`。

  为什么是整类替换而不是逐行增改：这一批就是**当前源码算出来的全集**，盘上多出来的行只可能来自
  已删除或已不再含函数的文件——留着它们，读侧就会把「这个文件没图」误读成「这个文件的图是空的」。
*/
export function saveFileFacts(db: TutorDatabase, repositoryId: string, rows: FileFactRow[]): void {
  const grouped = new Map<FactKind, { path: string; payload: unknown }[]>();
  for (const row of rows) grouped.set(row.kind, [...(grouped.get(row.kind) ?? []), { path: row.path, payload: row.payload }]);
  for (const kind of ["cfg", "dataflow", "typeRelations", "registry"] as FactKind[]) db.saveFileFacts(repositoryId, kind, grouped.get(kind) ?? [], { replaceAll: true });
}
