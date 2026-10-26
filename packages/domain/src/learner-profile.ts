import type { TutorSettings } from "./teaching-policy.js";

export type MasteryLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface MasteryRecord {
  unitId: string;
  level: MasteryLevel;
  attempts: number;
  successes: number;
  lastPracticedAt?: string;
}

export interface MasteryMapEntry extends MasteryRecord {
  successRate: number;
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

export interface LearnerProfile {
  repositoryId: string;
  generatedAt: string;
  mastery: MasteryMapEntry[];
  faded: FadedState;
  recommended: RecommendedTutorSettings;
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
