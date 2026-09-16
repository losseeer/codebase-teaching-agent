import {
  FLOW_MAX_STAGES,
  type FlowStage,
  type FlowStageFile,
  type FlowStageKind,
  type RepositoryAnalysis,
  type RepositoryFlow,
  type RepositoryFlowResult,
  type RepositoryIndex,
  type SourceAnchor
} from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { executeReadFile } from "../source/read-file.js";
import { buildFlowEvidence, staticFlow } from "./evidence.js";

/**
  流程视图的服务端（宏观设计 · 流程视图）：

  流程由 LLM 生成，而不是直接把静态调用链画出来。理由是静态调用图看不见**编排**——
  `add_node("evaluate", evaluate)`、路由表、插件注册、依赖注入都不会产生调用边，
  于是真正的主干（如 LangGraph 的 evaluate → improve → 回环）在静态链上是断的。
  模型可以从文件、符号与依赖语义里读出这类结构，这是流程视图相对架构视图的增量。

  静态调用链没有被丢掉，它做两件事：作为 LLM 的输入证据（真实的跨文件调用顺序），
  以及 LLM 不可用时的降级视图（显式标注，不冒充模型结论）。

  与 `coursetree/entry-suggest.ts` 同一套约定：失败不抛给调用方，返回降级结果 + 原因；
  缓存只存成功结果，避免把失败固化。
 */

const MAX_DIGEST_FILES = 60;
const MAX_SYMBOLS_PER_FILE = 8;
const MAX_IMPORTS_PER_FILE = 8;
const MAX_CALL_CHAIN = 24;
const ENTRY_EXCERPT_LINES = 120;
const MAX_TITLE = 18;
const MAX_SUMMARY = 100;
const MAX_STAGE_TITLE = 14;
const MAX_STAGE_DETAIL = 60;
const MAX_STAGE_FILES = 3;
const MAX_FILE_NOTE = 20;
const MAX_BRANCHES = 4;
const MAX_BRANCH_TEXT = 30;
const MAX_CAVEATS = 160;
/** 环节被丢弃到低于该数量就不再算「一条流程」，回落静态视图。 */
const MIN_STAGES = 3;
const FALLBACK_UNPARSEABLE = "模型返回的内容无法解析成一条完整流程";

const SYSTEM_PROMPT = [
  "你是代码教学产品的架构讲解者。给定一个仓库的执行入口、文件清单（含符号名与依赖）与静态调用链证据，",
  "输出「一次执行从入口到结束经过哪些环节」。",
  "硬性要求：",
  "1. 环节按真实执行顺序排列，覆盖静态调用链看不到的**编排**（回调/节点注册、路由表、插件与依赖注入、事件订阅）——这是本次任务的重点，不要只把调用链誊一遍。",
  "2. 每个环节关联 1~3 个**清单里确实存在**的文件路径，并给出该文件在这个环节里的作用；给不出真实路径就不要写这一项，路径编错会导致整个环节被丢弃。",
  `3. 环节数 ${MIN_STAGES}~${FLOW_MAX_STAGES} 个。第 1 个环节必须是入口。`,
  "4. kind 取值：entry（入口）、stage（普通环节）、decision（有条件分支，用 branches 写清判断依据与去向）、loop（回到更早环节，用 loopsTo 写目标序号）、exit（结束/产出）。",
  "5. 只描述代码能支持的内容，不编造模块名或函数名；把握不准的地方写进 caveats。",
  `严格输出 JSON：{"title":"≤${MAX_TITLE}字","summary":"≤${MAX_SUMMARY}字",`,
  `"stages":[{"title":"≤${MAX_STAGE_TITLE}字","detail":"≤${MAX_STAGE_DETAIL}字","kind":"entry|stage|decision|loop|exit",`,
  `"files":[{"path":"清单中的路径","line":1,"note":"≤${MAX_FILE_NOTE}字"}],"branches":["≤${MAX_BRANCH_TEXT}字"],"loopsTo":1}],`,
  `"caveats":"≤${MAX_CAVEATS}字，说明不确定处或已知遗漏"}。`,
  "不要输出 JSON 以外的任何文字。"
].join("");

export interface FlowDigestFile {
  path: string;
  lines: number;
  symbols: string[];
  imports: string[];
  importedBy: number;
}

export interface FlowDigest {
  entry: { path: string; label: string };
  entryExcerpt?: string;
  files: FlowDigestFile[];
  /** 被截断的文件总数（清单未含全部文件时告知模型） */
  omittedFiles: number;
  /** 静态跨文件调用链：入口 → … 的紧凑序列 */
  callChain: string[];
  /** 静态链是否被展开上限截断 */
  callChainTruncated: boolean;
}

/**
  构造喂给模型的证据。证据只含「模型推不出、但必须知道」的事实：
  真实路径、符号名、依赖方向、静态调用顺序。刻意不放源码全文——那会把成本推高一个量级，
  而流程编排靠符号名与文件名已经能读出来。
 */
export function buildFlowDigest(repositoryPath: string, index: RepositoryIndex, analysis: RepositoryAnalysis, entry: SourceAnchor): FlowDigest {
  const inDegree = new Map<string, number>();
  for (const targets of Object.values(analysis.graph.imports)) {
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }
  const symbolsByPath = new Map<string, string[]>();
  for (const symbol of analysis.graph.symbols) {
    const list = symbolsByPath.get(symbol.path) ?? [];
    if (list.length < MAX_SYMBOLS_PER_FILE) list.push(symbol.name);
    symbolsByPath.set(symbol.path, list);
  }

  // 有依赖边或有符号的文件才进清单：流程视图关心的是「谁参与执行」，不是全量文件清单
  const candidates = index.files
    .map((file) => ({
      path: file.path,
      lines: file.lines,
      symbols: symbolsByPath.get(file.path) ?? [],
      imports: (analysis.graph.imports[file.path] ?? []).slice(0, MAX_IMPORTS_PER_FILE),
      importedBy: inDegree.get(file.path) ?? 0
    }))
    .filter((file) => file.path === entry.path || file.imports.length || file.importedBy > 0 || file.symbols.length)
    .sort((left, right) =>
      Number(right.path === entry.path) - Number(left.path === entry.path)
      || right.importedBy - left.importedBy
      || right.lines - left.lines
      || left.path.localeCompare(right.path));
  const files = candidates.slice(0, MAX_DIGEST_FILES);

  const evidence = buildFlowEvidence(analysis, entry);
  const callChain = evidence.stages.map((stage) => `${stage.path}:${stage.title}${stage.kind === "entry" ? "（入口）" : ""}`);

  // 入口文件的真实内容：让模型知道入口到底做了什么，而不是从文件名猜
  const read = executeReadFile(repositoryPath, JSON.stringify({ path: entry.path, offset: 1, limit: ENTRY_EXCERPT_LINES }));
  const entryExcerpt = read.audit.denied ? undefined : read.content;

  return {
    entry: { path: entry.path, label: entry.label },
    ...(entryExcerpt ? { entryExcerpt } : {}),
    files,
    omittedFiles: candidates.length - files.length,
    callChain: callChain.slice(0, MAX_CALL_CHAIN),
    callChainTruncated: evidence.truncated || callChain.length > MAX_CALL_CHAIN
  };
}

export interface GenerateFlowInput {
  repositoryPath: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
  entry: SourceAnchor;
  provider: LlmProvider;
}

export interface GeneratedFlow extends RepositoryFlowResult {
  usage?: LlmUsage;
}

/** 生成一条流程。任何失败（调用异常 / JSON 不合法 / 校验后环节不足）都回落静态调用链，并带上原因。 */
export async function generateRepositoryFlow(input: GenerateFlowInput): Promise<GeneratedFlow> {
  const evidence = buildFlowEvidence(input.analysis, input.entry);
  try {
    const digest = buildFlowDigest(input.repositoryPath, input.index, input.analysis, input.entry);
    const response = await input.provider.complete({
      system: SYSTEM_PROMPT,
      user: JSON.stringify(digest),
      maxTokens: 2_400,
      temperature: 0.2,
      scene: "map.flow"
    });
    const parsed = parseFlow(response.text, {
      entry: input.entry,
      availablePaths: new Set(input.index.files.map((file) => file.path)),
      linesOf: new Map(input.index.files.map((file) => [file.path, file.lines]))
    });
    if (!parsed) return { flow: staticFlow(evidence, FALLBACK_UNPARSEABLE), source: "static", reason: FALLBACK_UNPARSEABLE, usage: response.usage };
    return { flow: parsed, source: "llm", usage: response.usage };
  } catch (error) {
    const reason = `流程生成调用失败（${error instanceof Error ? error.message : String(error)}）`;
    console.error("[flows] LLM 调用失败，回落静态调用链:", reason);
    return { flow: staticFlow(evidence, reason), source: "static", reason };
  }
}

interface ParseContext {
  entry: SourceAnchor;
  availablePaths: Set<string>;
  linesOf: Map<string, number>;
}

/** 把模型输出校验成 `RepositoryFlow`：路径必须真实、行号必须落在文件范围内、序号与回环重排一致。 */
export function parseFlow(text: string, context: ParseContext): RepositoryFlow | null {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const droppedFiles = { count: 0 };
  // 序号以模型输出数组的位置为准（1 起）：提示词已要求「按真实执行顺序排列」，数组顺序比模型自填的
  // order 字段可靠——自填序号一旦跳号，回环目标就会整体错位。
  const kept = (Array.isArray(record.stages) ? record.stages : [])
    .slice(0, FLOW_MAX_STAGES)
    .map((item, index) => normalizeStage(item, context, droppedFiles, index + 1))
    .filter((stage): stage is NormalizedStage => stage !== null);
  // 路径全部编造的环节直接丢弃：宁可少一个环节，也不给一个指不到代码的环节
  if (kept.length < MIN_STAGES) return null;

  const orderMap = new Map<number, number>();
  kept.forEach((stage, index) => orderMap.set(stage.sourceOrder, index + 1));
  const stages: FlowStage[] = kept.map((stage, index) => {
    const order = index + 1;
    const kind: FlowStageKind = order === 1 ? "entry" : stage.kind === "entry" ? "stage" : stage.kind;
    const target = stage.loopsTo !== undefined ? orderMap.get(stage.loopsTo) : undefined;
    // 回环只能指向更靠前的环节；指向自己或未来环节不是回环，是数据错误
    const loopsTo = target !== undefined && target < order ? target : undefined;
    return {
      order,
      kind,
      title: stage.title,
      detail: stage.detail,
      files: stage.files,
      branches: stage.branches,
      ...(loopsTo !== undefined ? { loopsTo } : {})
    };
  });

  const droppedStages = (Array.isArray(record.stages) ? record.stages.length : 0) - kept.length;
  const notes = [
    asText(record.caveats, MAX_CAVEATS),
    droppedStages > 0 ? `有 ${droppedStages} 个环节因未给出存在的文件路径被丢弃` : "",
    droppedFiles.count > 0 ? `有 ${droppedFiles.count} 个文件路径不在仓库中，已剔除` : ""
  ].filter(Boolean);

  return {
    entry: context.entry,
    title: asText(record.title, MAX_TITLE) || `${context.entry.path} 的执行流程`,
    summary: asText(record.summary, MAX_SUMMARY),
    stages,
    ...(notes.length ? { caveats: notes.join("；") } : {}),
    generatedAt: new Date().toISOString()
  };
}

type NormalizedStage = Omit<FlowStage, "order" | "loopsTo"> & { sourceOrder: number; loopsTo?: number };

function normalizeStage(item: unknown, context: ParseContext, droppedFiles: { count: number }, sourceOrder: number): NormalizedStage | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const title = asText(record.title, MAX_STAGE_TITLE);
  if (!title) return null;
  const files: FlowStageFile[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(record.files) ? record.files : []) {
    if (files.length >= MAX_STAGE_FILES) break;
    if (!candidate || typeof candidate !== "object") continue;
    const file = candidate as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path.trim().replace(/^\.\//, "") : "";
    if (!path) continue;
    if (!context.availablePaths.has(path)) { droppedFiles.count += 1; continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const limit = context.linesOf.get(path) ?? 1;
    const line = Math.min(Math.max(1, Math.floor(Number(file.line ?? 1) || 1)), Math.max(1, limit));
    const note = asText(file.note, MAX_FILE_NOTE);
    files.push(note ? { path, line, note } : { path, line });
  }
  // 一个指不到代码的环节没有价值：静默保留会让读者以为它对应某处实现
  if (!files.length) return null;
  const kindText = typeof record.kind === "string" ? record.kind : "";
  const kind: FlowStageKind = kindText === "entry" || kindText === "decision" || kindText === "loop" || kindText === "exit" ? kindText : "stage";
  const branches = (Array.isArray(record.branches) ? record.branches : [])
    .map((branch) => asText(branch, MAX_BRANCH_TEXT))
    .filter(Boolean)
    .slice(0, MAX_BRANCHES);
  const loopsTo = Number.isInteger(record.loopsTo) ? Number(record.loopsTo) : undefined;
  return { sourceOrder, kind, title, detail: asText(record.detail, MAX_STAGE_DETAIL), files, branches, ...(loopsTo !== undefined ? { loopsTo } : {}) };
}

function asText(value: unknown, limit: number): string {
  return typeof value === "string" ? [...value.trim().replace(/\s+/g, " ")].slice(0, limit).join("") : "";
}

/** 流程缓存：同一（仓库分析版本, 入口）的重复请求不再重调 LLM。只缓存成功结果。 */
const flowCache = new Map<string, { result: GeneratedFlow; at: number }>();
const FLOW_CACHE_TTL_MS = 10 * 60_000;
const FLOW_CACHE_MAX = 60;

export function clearRepositoryFlowCache(): void {
  flowCache.clear();
}

export async function generateRepositoryFlowCached(input: GenerateFlowInput & { cacheKey: string }): Promise<GeneratedFlow> {
  const key = `${input.cacheKey}:${input.entry.path}`;
  const hit = flowCache.get(key);
  if (hit && Date.now() - hit.at < FLOW_CACHE_TTL_MS) {
    flowCache.delete(key);
    flowCache.set(key, hit); // 刷新 LRU 新近度
    return { ...hit.result, usage: undefined };
  }
  const result = await generateRepositoryFlow(input);
  if (result.source === "llm") {
    flowCache.set(key, { result, at: Date.now() });
    if (flowCache.size > FLOW_CACHE_MAX) {
      const oldest = flowCache.keys().next().value;
      if (oldest !== undefined) flowCache.delete(oldest);
    }
  }
  return result;
}

/** LLM 不可用或预算触顶时的入口：直接给静态调用链，并显式说明原因。 */
export function degradedFlow(analysis: RepositoryAnalysis, entry: SourceAnchor, reason: string): GeneratedFlow {
  return { flow: staticFlow(buildFlowEvidence(analysis, entry), reason), source: "static", reason };
}
