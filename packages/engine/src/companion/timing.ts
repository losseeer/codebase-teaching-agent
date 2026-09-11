import { isAbsolute, relative, resolve } from "node:path";
import type { ClaudePostToolUseEvent, CompanionFlowState, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { impactRadius, graphFromData } from "../depgraph/graph.js";
import { isWithin } from "../lib.js";

export interface CompanionTimingContext {
  repositoryPath: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
}

export interface RelevanceAssessment {
  relevance: number;
  path?: string;
  impactedPaths: string[];
  reason: string;
}

export interface TeachMomentAssessment extends RelevanceAssessment {
  accepted: boolean;
  discarded: boolean;
  flow: CompanionFlowState;
  latencyMs: number;
}

export interface TimingOptions {
  timeoutMs?: number;
  assessRelevance?: (event: ClaudePostToolUseEvent, context: CompanionTimingContext, flow: CompanionFlowState) => RelevanceAssessment | Promise<RelevanceAssessment>;
}

const errorPattern = /\b(?:TODO|FIXME|TypeError|ReferenceError|AssertionError|SyntaxError|FAIL(?:ED)?)\b/i;

/**
 * Keeps companion-mode decisions local and bounded. A late relevance result is
 * deliberately discarded so hooks never interrupt the developer's flow.
 */
export async function evaluateTeachMoment(event: ClaudePostToolUseEvent, context: CompanionTimingContext, options: TimingOptions = {}): Promise<TeachMomentAssessment> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 500;
  const flow = flowFor(event);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(undefined), timeoutMs); });
  try {
    const assessment = await Promise.race([
      Promise.resolve((options.assessRelevance ?? assessRelevance)(event, context, flow)),
      timeout
    ]);
    const latencyMs = elapsed(started);
    if (!assessment || latencyMs >= timeoutMs) return { accepted: false, discarded: true, reason: "时机判定超时，已丢弃", flow, relevance: 0, impactedPaths: [], latencyMs };
    const hasTeachingSignal = flow !== "focused" || errorPattern.test(event.output ?? event.toolResponse ?? "");
    return { ...assessment, accepted: hasTeachingSignal && assessment.relevance >= 0.6, discarded: false, flow, latencyMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function flowFor(event: ClaudePostToolUseEvent): CompanionFlowState {
  const output = event.output ?? event.toolResponse ?? "";
  if ((typeof event.exitCode === "number" && event.exitCode !== 0) || errorPattern.test(output)) return "stuck";
  if (isSourceMutation(event) || (event.durationMs ?? 0) >= 8_000) return "transition";
  return "focused";
}

export function assessRelevance(event: ClaudePostToolUseEvent, context: CompanionTimingContext, flow: CompanionFlowState): RelevanceAssessment {
  const path = eventPath(event, context.repositoryPath);
  const sourceKnown = Boolean(path && context.index.files.some((file) => file.path === path));
  const output = event.output ?? event.toolResponse ?? "";
  const failure = flow === "stuck";
  const impactedPaths = sourceKnown && path ? impactRadius(graphFromData(context.analysis.graph), [path]).impactedPaths : [];
  let relevance = sourceKnown ? 0.65 : 0;
  if (impactedPaths.length > 1) relevance = Math.min(1, relevance + 0.2);
  if (failure && /(?:test|pytest|vitest|jest|npm|pnpm|yarn|bash|shell)/i.test(event.toolName ?? event.command ?? "")) relevance = Math.max(relevance, 0.75);
  if (errorPattern.test(output) && sourceKnown) relevance = Math.max(relevance, 0.8);
  const reason = failure
    ? "工具失败且与当前仓库上下文相关"
    : sourceKnown && impactedPaths.length > 1
      ? "修改文件存在可追溯的影响半径"
      : sourceKnown
        ? "事件命中了已索引源码"
        : "事件未命中当前仓库的可教学上下文";
  return { relevance, path, impactedPaths, reason };
}

function isSourceMutation(event: ClaudePostToolUseEvent): boolean {
  return /(?:edit|write|patch|replace|multi)/i.test(event.toolName ?? "") && Boolean(eventPath(event, event.cwd));
}

function eventPath(event: ClaudePostToolUseEvent, repositoryPath?: string): string | undefined {
  const inputPath = event.path ?? stringValue(event.toolInput?.file_path) ?? stringValue(event.toolInput?.path) ?? stringValue(event.toolInput?.filePath);
  if (!inputPath) return undefined;
  if (!repositoryPath) return inputPath.replace(/^\.\//, "");
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(event.cwd ?? repositoryPath, inputPath);
  if (!isWithin(repositoryPath, absolute)) return undefined;
  return relative(repositoryPath, absolute).replaceAll("\\", "/");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}
