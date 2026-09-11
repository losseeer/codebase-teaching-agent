import type { ClaudePostToolUseEvent, CompanionAction, CompanionHookResult, CompanionSuggestion, CompanionSummary, RepositoryAnalysis, RepositoryIndex, SourceAnchor } from "@codebase-tutor/shared";
import { id } from "../lib.js";
import { TutorDatabase } from "../store/database.js";
import { Journal, readJournal } from "../store/journal.js";
import { evaluateTeachMoment } from "./timing.js";

export interface CompanionRepository {
  path: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
}

export class CompanionService {
  async receivePostToolUse(repository: CompanionRepository, event: ClaudePostToolUseEvent): Promise<CompanionHookResult> {
    const assessment = await evaluateTeachMoment(event, { repositoryPath: repository.path, index: repository.index, analysis: repository.analysis });
    const journal = new Journal(repository.path, repository.index.repositoryId);
    const classified = journal.append("teach_moment", {
      accepted: assessment.accepted,
      phase: "classified",
      tool: event.toolName ?? "unknown",
      flow: assessment.flow,
      relevance: assessment.relevance,
      latency_ms: assessment.latencyMs,
      discarded: assessment.discarded,
      reason: assessment.reason
    }, event.sessionId);
    if (!assessment.accepted || assessment.discarded) {
      return { accepted: false, discarded: assessment.discarded, reason: assessment.reason, flow: assessment.flow, relevance: assessment.relevance, latencyMs: assessment.latencyMs };
    }
    const suggestion = suggestionFor(repository, classified.id, event, assessment);
    const database = new TutorDatabase(repository.path);
    database.saveCompanionSuggestion(repository.index.repositoryId, suggestion);
    database.close();
    return { accepted: true, discarded: false, reason: assessment.reason, flow: assessment.flow, relevance: assessment.relevance, latencyMs: assessment.latencyMs, suggestion };
  }

  list(repository: CompanionRepository, includeLater = false): CompanionSuggestion[] {
    const database = new TutorDatabase(repository.path);
    const suggestions = database.getCompanionSuggestions(repository.index.repositoryId, includeLater ? ["pending", "later"] : ["pending"]);
    database.close();
    return suggestions;
  }

  act(repository: CompanionRepository, suggestionId: string, action: CompanionAction): CompanionSuggestion {
    const database = new TutorDatabase(repository.path);
    try {
      const existing = database.getCompanionSuggestion(repository.index.repositoryId, suggestionId);
      if (!existing) throw new Error("建议卡不存在");
      if (existing.status !== "pending" && existing.status !== "later") throw new Error("建议卡已经处理");
      const suggestion: CompanionSuggestion = { ...existing, status: action, actedAt: new Date().toISOString() };
      database.saveCompanionSuggestion(repository.index.repositoryId, suggestion);
      new Journal(repository.path, repository.index.repositoryId).append("teach_moment", {
        accepted: action === "accepted",
        phase: "action",
        action,
        suggestion_id: suggestion.id,
        kind: suggestion.kind,
        flow: suggestion.flow,
        relevance: suggestion.relevance
      });
      return suggestion;
    } finally {
      database.close();
    }
  }

  summary(repository: CompanionRepository): CompanionSummary {
    const actions = readJournal(repository.path).filter((event) => event.type === "teach_moment" && event.payload.phase === "action");
    const accepted = actions.filter((event) => event.payload.accepted === true).length;
    const database = new TutorDatabase(repository.path);
    const pendingCount = database.getCompanionSuggestions(repository.index.repositoryId).length;
    database.close();
    return { pendingCount, actionCount: actions.length, acceptanceRate: actions.length ? accepted / actions.length : null };
  }
}

function suggestionFor(repository: CompanionRepository, eventId: string, event: ClaudePostToolUseEvent, assessment: Awaited<ReturnType<typeof evaluateTeachMoment>>): CompanionSuggestion {
  const failed = assessment.flow === "stuck";
  const impacted = assessment.impactedPaths;
  const path = assessment.path;
  const kind = failed ? "failure_recovery" : impacted.length > 1 ? "impact_review" : "source_trace";
  const anchors = anchorsFor(repository, path, impacted);
  const title = kind === "failure_recovery" ? "先定位这次失败" : kind === "impact_review" ? "复查这次修改的影响" : "回看刚才的源码操作";
  const body = kind === "failure_recovery"
    ? `${event.toolName ?? "工具"} 未成功完成。先从${path ? ` ${path}` : "当前失败输出"}确认失败位置，再决定下一步。`
    : kind === "impact_review"
      ? `${path} 的依赖图显示 ${impacted.length} 个本地文件可能受影响。先确认调用方是否仍符合预期。`
      : `${path ?? "当前源码"} 已进入分析范围。回看输入、输出和边界，确认这次操作是否改变了预期行为。`;
  return {
    id: `companion:${id()}`,
    repositoryId: repository.index.repositoryId,
    eventId,
    kind,
    status: "pending",
    title,
    body,
    reason: assessment.reason,
    flow: assessment.flow,
    relevance: assessment.relevance,
    path,
    anchors,
    createdAt: new Date().toISOString()
  };
}

function anchorsFor(repository: CompanionRepository, path: string | undefined, impactedPaths: string[]): SourceAnchor[] {
  const paths = [path, ...impactedPaths].filter((value): value is string => Boolean(value)).filter((value, index, values) => values.indexOf(value) === index).slice(0, 3);
  const anchors = paths.map((candidate) => {
    const symbol = repository.analysis.graph.symbols.find((item) => item.path === candidate);
    return { path: candidate, line: symbol?.line ?? 1, endLine: symbol?.endLine, label: symbol ? symbol.name : "相关源码" };
  });
  return anchors.length ? anchors : repository.analysis.graph.entrypoints.slice(0, 1);
}
