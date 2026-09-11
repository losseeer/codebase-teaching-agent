import type { ReviewSchedule } from "@codebase-tutor/shared";

const minimumEasiness = 1.3;

/** SM-2 update using the conventional 0-5 quality scale. */
export function scheduleSm2(previous: ReviewSchedule | undefined, quality: number, reviewedAt = new Date()): ReviewSchedule {
  const boundedQuality = Math.max(0, Math.min(5, Math.round(quality)));
  const base: ReviewSchedule = previous ?? {
    exerciseId: "",
    unitId: "",
    repetitions: 0,
    intervalDays: 0,
    easinessFactor: 2.5,
    dueAt: reviewedAt.toISOString()
  };
  const easinessFactor = Math.max(minimumEasiness, base.easinessFactor + 0.1 - (5 - boundedQuality) * (0.08 + (5 - boundedQuality) * 0.02));
  const repetitions = boundedQuality < 3 ? 0 : base.repetitions + 1;
  const intervalDays = boundedQuality < 3 ? 1 : repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.max(1, Math.round(base.intervalDays * easinessFactor));
  const due = new Date(reviewedAt);
  due.setUTCDate(due.getUTCDate() + intervalDays);
  return { ...base, repetitions, intervalDays, easinessFactor, dueAt: due.toISOString(), lastReviewedAt: reviewedAt.toISOString() };
}

export function qualityForScore(score: number): number {
  if (score >= 0.95) return 5;
  if (score >= 0.8) return 4;
  if (score >= 0.6) return 3;
  if (score >= 0.4) return 2;
  if (score > 0) return 1;
  return 0;
}
