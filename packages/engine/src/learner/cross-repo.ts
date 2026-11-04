import type { Contribution, CrossRepoLearningProfile, RepositoryMeta, Topic } from "@codebase-tutor/domain";

import { attemptDelta, clampScore, confidenceOf, levelOf } from "./weights.js";

/** 跨仓画像只聚合原始 contribution；标签从活跃 topic 表解析，频率从 at 现算。 */
export function deriveCrossRepoLearningProfile(input: {
  contributions: Contribution[];
  topics: Topic[];
  repositoryMetas: RepositoryMeta[];
  modelVersion: string;
  now?: Date;
}): CrossRepoLearningProfile {
  const labels = new Map(input.topics.map((topic) => [topic.id, topic.label]));
  const metaById = new Map(input.repositoryMetas.map((meta) => [meta.repositoryId, meta]));
  const byTopic = new Map<string, Contribution[]>();
  const stackStats = new Map<string, { attempts: number; lastAt?: string }>();

  for (const contribution of input.contributions) {
    if (contribution.topicId && labels.has(contribution.topicId)) {
      byTopic.set(contribution.topicId, [...(byTopic.get(contribution.topicId) ?? []), contribution]);
    }
    const meta = metaById.get(contribution.repositoryId);
    for (const stack of meta?.stacks ?? []) {
      const current = stackStats.get(stack) ?? { attempts: 0 };
      const lastAt = [current.lastAt, contribution.at].filter((value): value is string => typeof value === "string").sort().at(-1);
      stackStats.set(stack, { attempts: current.attempts + 1, ...(lastAt ? { lastAt } : {}) });
    }
  }

  const topics = [...byTopic.entries()].map(([topicId, rows]) => {
    const ordered = [...rows].sort((left, right) => left.at.localeCompare(right.at));
    let score = 0;
    let successes = 0;
    const byKind: Record<string, number> = {};
    for (const row of ordered) {
      score = clampScore(score + attemptDelta({ gradingMode: row.gradingMode, kind: row.kind }, { attemptKind: row.attemptKind, passed: row.passed }));
      if (row.passed) successes += 1;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    }
    return {
      topicId,
      label: labels.get(topicId) ?? topicId,
      attempts: ordered.length,
      score,
      level: levelOf(score),
      confidence: confidenceOf(ordered.length),
      ...(ordered.length ? { lastPracticedAt: ordered[ordered.length - 1]!.at } : {}),
      byKind
    };
  }).sort((left, right) => right.attempts - left.attempts || (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""));

  const stacks = [...stackStats.entries()].map(([stack, stats]) => ({
    stack,
    attempts: stats.attempts,
    ...(stats.lastAt ? { lastPracticedAt: stats.lastAt } : {})
  })).sort((left, right) => right.attempts - left.attempts || left.stack.localeCompare(right.stack));

  const frequency = [...byTopic.entries()].map(([topicId, rows]) => {
    const lastAt = [...rows].map((row) => row.at).sort().at(-1);
    return { topicId, count: rows.length, ...(lastAt ? { lastAt } : {}) };
  }).sort((left, right) => right.count - left.count);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    modelVersion: input.modelVersion,
    topics,
    stacks,
    frequency
  };
}
