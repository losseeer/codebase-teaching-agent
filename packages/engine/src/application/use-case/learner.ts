import { basename } from "node:path";
import type { Contribution, CrossRepoLearningProfile, ExerciseResult, JournalEvent, RepositoryIndex, Topic } from "@codebase-tutor/domain";

import { projectContributionsFromEvents } from "../../learner/contribution.js";
import { deriveCrossRepoLearningProfile } from "../../learner/cross-repo.js";
import { learnerStore } from "../../infrastructure/composition-root.js";

/**
  学习状态用例：用户级主题 CRUD、跨仓画像、作答 contribution 落库。
  仓库学习档案仍从仓内 journal 回放，不在这里做。
*/
export type LearnerFailure =
  | { kind: "topic-missing" }
  | { kind: "topic-invalid" }
  | { kind: "topic-merge-invalid" };

export type LearnerResult<T> = { ok: true; value: T } | { ok: false; failure: LearnerFailure };

const invalid = (kind: LearnerFailure["kind"]): LearnerResult<never> => ({ ok: false, failure: { kind } });

/** 扩展名 → 技术栈；一个仓可以同时命中多条栈。 */
const STACK_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".java": "java", ".kt": "kotlin", ".go": "go", ".rs": "rust",
  ".rb": "ruby", ".php": "php", ".cs": "csharp", ".swift": "swift", ".scala": "scala",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp"
};

export function stacksOfIndex(index: RepositoryIndex): string[] {
  const counts = new Map<string, number>();
  for (const file of index.files) {
    const stack = STACK_BY_EXTENSION[file.extension.toLowerCase()];
    if (stack) counts.set(stack, (counts.get(stack) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([stack]) => stack);
}

/** 挂载/作答时更新仓库元信息；跨仓画像按 stack_json 聚合。 */
export function touchRepositoryMeta(repository: { path: string; index: RepositoryIndex }): void {
  learnerStore.touchRepository({
    repositoryId: repository.index.repositoryId,
    label: basename(repository.path) || repository.index.repositoryId,
    stacks: stacksOfIndex(repository.index)
  });
}

/**
  旧 journal 回放：按（仓, 题, 单元, 时间, 作答类型）幂等写入，重复挂载不会翻倍。
  这也覆盖升级前的历史练习：新作答与旧行用同一套字段口径。
*/
export function syncRepositoryContributions(repository: { index: RepositoryIndex; audit: { read(): JournalEvent[] } }): { imported: number } {
  const repositoryId = repository.index.repositoryId;
  const before = learnerStore.listContributions({ repositoryId }).length;
  for (const row of projectContributionsFromEvents(repository.audit.read(), repositoryId)) learnerStore.appendContribution(row);
  return { imported: learnerStore.listContributions({ repositoryId }).length - before };
}

/** 一行一次 exercise_result；对错与分数都保留原始值，聚合时再算权重。 */
export function recordExerciseContribution(result: ExerciseResult): Contribution {
  const topicId = result.topicId ? learnerStore.resolveTopic(result.topicId)?.id ?? result.topicId : undefined;
  return learnerStore.appendContribution({
    repositoryId: result.repositoryId,
    ...(topicId ? { topicId } : {}),
    exerciseId: result.exerciseId,
    unitId: result.targetUnitId,
    kind: result.kind,
    gradingMode: result.gradingMode,
    attemptKind: result.attemptKind,
    score: result.score,
    passed: result.passed,
    at: result.reviewedAt
  });
}

export function readCrossRepoLearningProfileUseCase(): CrossRepoLearningProfile {
  return deriveCrossRepoLearningProfile({
    contributions: learnerStore.listContributions(),
    topics: learnerStore.listTopics(),
    repositoryMetas: learnerStore.listRepositoryMeta(),
    modelVersion: learnerStore.modelVersion
  });
}

export function listTopicsUseCase(): { topics: Topic[] } {
  return { topics: learnerStore.listTopics() };
}

export function createTopicUseCase(input: { id?: unknown; label?: unknown; hint?: unknown }): LearnerResult<Topic> {
  if (typeof input.label !== "string" || !input.label.trim()) return invalid("topic-invalid");
  return {
    ok: true,
    value: learnerStore.createTopic({
      ...(typeof input.id === "string" && input.id.trim() ? { id: input.id.trim() } : {}),
      label: input.label,
      ...(typeof input.hint === "string" ? { hint: input.hint } : {})
    })
  };
}

export function updateTopicUseCase(topicId: string, patch: { label?: unknown; hint?: unknown }): LearnerResult<Topic> {
  if (patch.label !== undefined && (typeof patch.label !== "string" || !patch.label.trim())) return invalid("topic-invalid");
  const topic = learnerStore.updateTopic(topicId, {
    ...(typeof patch.label === "string" ? { label: patch.label } : {}),
    ...(typeof patch.hint === "string" ? { hint: patch.hint } : {})
  });
  return topic ? { ok: true, value: topic } : invalid("topic-missing");
}

export function deleteTopicUseCase(topicId: string): LearnerResult<{ deleted: boolean }> {
  return learnerStore.softDeleteTopic(topicId) ? { ok: true, value: { deleted: true } } : invalid("topic-missing");
}

export function mergeTopicsUseCase(sourceId: string, targetId: string | undefined): LearnerResult<Topic> {
  if (!targetId || !targetId.trim()) return invalid("topic-invalid");
  const topic = learnerStore.mergeTopics(sourceId, targetId.trim());
  return topic ? { ok: true, value: topic } : invalid("topic-merge-invalid");
}
