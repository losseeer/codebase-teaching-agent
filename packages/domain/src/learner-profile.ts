import type { TutorSettings } from "./teaching-policy.js";

export type MasteryLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface MasteryRecord {
  unitId: string;
  level: MasteryLevel;
  attempts: number;
  successes: number;
  lastPracticedAt?: string;
}

/** 学习画像公式版本：升级时改这里，旧 journal 按新版本全量回放，不做数据迁移。 */
export const LEARNER_MODEL_VERSION = "mastery-v0";

/** 一次作答的来源类型：首次 / 到期复习 / 首次之外的重复作答。 */
export type AttemptKind = "first" | "retry" | "review";

/** 仓库学习档案里的一条单元掌握度：分数由加权证据累加，level 只给 ZPD 路由。 */
export interface UnitMastery extends MasteryRecord {
  score: number;
  successRate: number;
  confidence: number;
}

/** 仓库学习档案：从本仓 journal 回放，不持久化教学档位。 */
export interface RepoLearningRecord {
  repositoryId: string;
  generatedAt: string;
  modelVersion: string;
  mastery: UnitMastery[];
  dueReviews: number;
}

/** 用户级主题：跨仓共享；删除默认软删。 */
export interface Topic {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
  updatedAt: string;
}

/** 跨仓原始证据：一行一次 exercise_result，可重算。 */
export interface Contribution {
  id: string;
  repositoryId: string;
  topicId?: string;
  exerciseId: string;
  unitId: string;
  kind: string;
  gradingMode: string;
  attemptKind: AttemptKind;
  score: number;
  passed: boolean;
  at: string;
}

/** 仓库元信息：跨仓画像按技术栈聚合时读取。 */
export interface RepositoryMeta {
  repositoryId: string;
  label: string;
  stacks: string[];
  lastSeenAt: string;
}

export interface CrossRepoLearningTopic {
  topicId: string;
  label: string;
  attempts: number;
  score: number;
  level: MasteryLevel;
  confidence: number;
  lastPracticedAt?: string;
  byKind: Record<string, number>;
}

export interface CrossRepoLearningStack {
  stack: string;
  attempts: number;
  lastPracticedAt?: string;
}

export interface CrossRepoLearningFrequency {
  topicId: string;
  count: number;
  lastAt?: string;
}

/** 跨仓学习画像：从 contribution 聚合；频率从 at 现算。 */
export interface CrossRepoLearningProfile {
  generatedAt: string;
  modelVersion: string;
  topics: CrossRepoLearningTopic[];
  stacks: CrossRepoLearningStack[];
  frequency: CrossRepoLearningFrequency[];
}

export type FadedTransition = "fade" | "replenish" | "steady";

export interface FadedState {
  sampleCompleteness: 0 | 1 | 2;
  hintDepth: 0 | 1 | 2 | 3;
  stylePlainness: 0 | 1 | 2;
  mastered: boolean;
  transition: FadedTransition;
  reason: string;
  updatedAt?: string;
}

export interface RecommendedTutorSettings {
  settings: TutorSettings;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export interface ReviewSchedule {
  exerciseId: string;
  unitId: string;
  repetitions: number;
  intervalDays: number;
  easinessFactor: number;
  dueAt: string;
  lastReviewedAt?: string;
}

export interface PracticeSummary {
  repositoryId: string;
  contentVersion: string;
  dueReviews: number;
  mastery: MasteryRecord[];
}
