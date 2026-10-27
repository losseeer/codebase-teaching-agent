import type {
  CfgFileFact,
  DataflowFileFact,
  DataflowFunctionFact,
  DeclaredType,
  FactKind,
  FactSkip,
  FileEntry,
  RegistryFileFact,
  SymbolInfo,
  TypeRelationFileFact
} from "@codebase-tutor/domain";
import { FACT_KINDS, languageCapabilitiesOf } from "@codebase-tutor/domain";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TutorDatabase } from "../persistence/database.js";
import type { SyntaxNode } from "@codebase-tutor/analysis";
import { eachFunction } from "@codebase-tutor/analysis";
import { graphExtensions } from "@codebase-tutor/analysis";
import { analyzeFunctionDataflow } from "@codebase-tutor/analysis";
import { analyzeFileTypes } from "@codebase-tutor/analysis";
import { analyzeFileRegistry, registryEligible } from "@codebase-tutor/analysis";
import { FACTS_VERSION } from "@codebase-tutor/analysis";

/**
  静态产物层的总装：一个文件解析一次，产出所有类别的读数。
  语法树解析是全仓最贵的一步，各产物又要靠同一份块 id 对齐，所以合在同一趟里算。
  产物确定性重算，不进 `analysis_json`、不进 `backendStamp`、不参与缓存键。
  源码在这里再读一次：图那边读完就丢了内容。
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
  registry: RegistryFileFact;
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
  // backend 跟着图走：没有语法树就没有任何一份产物，skipped 里的原因对三类产物同时成立
  const shared = { path, language, backend: cfg.backend, version: FACTS_VERSION };
  return {
    cfg,
    dataflow: { ...shared, functions: flows.sort((left, right) => left.startLine - right.startLine), ...(cfg.skipped ? { skipped: cfg.skipped } : {}) },
    types: { ...shared, types: types.sort((left, right) => left.line - right.line), ...(typeSkips.length ? { skipped: typeSkips } : {}) },
    registry: analyzeFileRegistry(path, content, language, cfg.backend === "ast")
  };
}

export function collectFileFacts(repositoryPath: string, files: FileEntry[], symbols: SymbolInfo[]): FileFactRow[] {
  const rows: FileFactRow[] = [];
  const byPath = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) byPath.set(symbol.path, [...(byPath.get(symbol.path) ?? []), symbol]);
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    // 没有对应语法就不产行，读侧才分得开「没算过」与「算过、是空的」
    if (!graphExtensions.includes(file.extension.toLowerCase())) continue;
    let content: string;
    try {
      content = readFileSync(join(repositoryPath, file.path), "utf8");
    } catch {
      // 扫描期读不到的文件已在 RepositoryIndex.unreadable 记名，这里不重复报
      continue;
    }
    const facts = analyzeFile(file.path, content, byPath.get(file.path) ?? [], languageCapabilitiesOf(file.path).language, symbols);
    rows.push({ kind: "cfg", path: file.path, payload: facts.cfg });
    rows.push({ kind: "dataflow", path: file.path, payload: facts.dataflow });
    rows.push({ kind: "typeRelations", path: file.path, payload: facts.types });
    rows.push({ kind: "registry", path: file.path, payload: facts.registry });
  }
  // 构建清单与 SPI 这类非源码文件只产注册索引：哪些文件在一起编译、接口运行时绑到哪个实现，只有它们能回答
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    if (graphExtensions.includes(file.extension.toLowerCase()) || !registryEligible(file.path, false)) continue;
    try {
      const content = readFileSync(join(repositoryPath, file.path), "utf8");
      rows.push({ kind: "registry", path: file.path, payload: analyzeFile(file.path, content, [], languageCapabilitiesOf(file.path).language, []).registry });
    } catch {
      continue;
    }
  }
  return rows;
}

/**
  整批落库，按类别各存一次 `replaceAll`：这一批就是当前源码算出的全集，
  留下的旧行会被读成「这个文件有产物、但是空的」。
*/
export function saveFileFacts(db: TutorDatabase, repositoryId: string, rows: FileFactRow[]): void {
  const grouped = new Map<FactKind, { path: string; payload: unknown }[]>();
  for (const row of rows) grouped.set(row.kind, [...(grouped.get(row.kind) ?? []), { path: row.path, payload: row.payload }]);
  for (const kind of FACT_KINDS) db.facts.save(repositoryId, kind, grouped.get(kind) ?? [], { replaceAll: true });
}
