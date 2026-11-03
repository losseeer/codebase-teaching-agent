import type { AttemptKind, JournalEvent, RepoLearningRecord } from "@codebase-tutor/domain";

import { confidenceOf } from "./weights.js";

/** 系统提示词里的学习快照上限；只注入事实，不注入教学档位。 */
export const LEARNER_SNAPSHOT_LIMIT = 500;

export interface LearnerSnapshotInput {
  record: RepoLearningRecord;
  /** 用来分主题统计首次/复习通过次数；缺省时只报最新掌握单元。 */
  events?: JournalEvent[];
  /** topic_id → label；没有表数据时用 topic id 兜底。 */
  topicLabels?: Record<string, string>;
  now?: Date;
}

interface SnapshotGroup {
  label: string;
  attempts: number;
  firstPasses: number;
  reviewPasses: number;
  lastAt?: string;
}

/** `llm:<topicId>:<nonce>` / `llm-code:<topicId>:<nonce>` 的第一段主题 id。 */
export function topicIdFromUnit(unitId: string): string | undefined {
  if (unitId.startsWith("llm-code:")) return unitId.slice("llm-code:".length).split(":")[0] || undefined;
  if (unitId.startsWith("llm:")) return unitId.slice("llm:".length).split(":")[0] || undefined;
  return undefined;
}

function unitIdOf(event: JournalEvent): string | undefined {
  return typeof event.payload.unit_id === "string"
    ? event.payload.unit_id
    : typeof event.payload.target_unit_id === "string" ? event.payload.target_unit_id : undefined;
}

function attemptKindOf(event: JournalEvent): AttemptKind {
  const recorded = event.payload.attempt_kind;
  return recorded === "first" || recorded === "retry" || recorded === "review" ? recorded : "first";
}

function mention(attempts: number): string {
  const confidence = confidenceOf(attempts);
  return confidence >= 0.8 ? "高" : confidence >= 0.4 ? "中" : "低";
}

function daysText(lastAt: string | undefined, now: Date): string {
  if (!lastAt) return "还没练过";
  const days = Math.floor((now.getTime() - new Date(lastAt).getTime()) / 86_400_000);
  if (days <= 0) return "今天练过";
  return `${String(days)} 天前练过`;
}

function groupsFromEvents(events: JournalEvent[], topicLabels: Record<string, string>): SnapshotGroup[] {
  const groups = new Map<string, SnapshotGroup>();
  for (const event of [...events].sort((left, right) => left.at.localeCompare(right.at))) {
    if (event.type !== "exercise_result") continue;
    const unitId = unitIdOf(event);
    if (!unitId) continue;
    const topicId = typeof event.payload.topic_id === "string" ? event.payload.topic_id : topicIdFromUnit(unitId);
    const label = topicId ? topicLabels[topicId] ?? topicId : unitId;
    const passed = event.payload.passed === true;
    const kind = attemptKindOf(event);
    const current = groups.get(label) ?? { label, attempts: 0, firstPasses: 0, reviewPasses: 0 };
    groups.set(label, {
      ...current,
      attempts: current.attempts + 1,
      firstPasses: current.firstPasses + (kind !== "review" && passed ? 1 : 0),
      reviewPasses: current.reviewPasses + (kind === "review" && passed ? 1 : 0),
      lastAt: event.at
    });
  }
  return [...groups.values()].sort((left, right) => (right.lastAt ?? "").localeCompare(left.lastAt ?? ""));
}

/** 一条紧凑的学习快照：最近练的主题 + 待复习数；不写掌握度分数与教学档位。 */
export function buildLearnerSnapshot(input: LearnerSnapshotInput): string {
  const now = input.now ?? new Date();
  const groups = groupsFromEvents(input.events ?? [], input.topicLabels ?? {});
  const fallback = [...input.record.mastery].sort((left, right) => (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""))[0];
  const lead = groups[0] ?? (fallback
    ? { label: fallback.unitId, attempts: fallback.attempts, firstPasses: fallback.successes, reviewPasses: 0, lastAt: fallback.lastPracticedAt }
    : undefined);
  const lines = [
    lead
      ? `${lead.label}：${String(lead.attempts)} 次，首次通过 ${String(lead.firstPasses)}，复习通过 ${String(lead.reviewPasses)}，置信度${mention(lead.attempts)}，${daysText(lead.lastAt, now)}`
      : "还没有练习记录",
    `待复习：${String(input.record.dueReviews)} 题`
  ];
  return lines.join("\n").slice(0, LEARNER_SNAPSHOT_LIMIT);
}
