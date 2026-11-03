import type { JournalEvent, RepoLearningRecord } from "@codebase-tutor/domain";
import { LEARNER_MODEL_VERSION } from "@codebase-tutor/domain";

import { deriveMastery } from "./mastery.js";

/**
  仓库学习档案：只是记忆结构（掌握度 + 待复习），不含教学档位。
  讲法由教学层从档案快照按需计算（见 `teaching-profile.ts`），不持久化。
*/
export function deriveRepoLearningRecord(repositoryId: string, events: JournalEvent[], dueReviews = 0, now = new Date(), modelVersion = LEARNER_MODEL_VERSION): RepoLearningRecord {
  return {
    repositoryId,
    generatedAt: now.toISOString(),
    modelVersion,
    mastery: deriveMastery(events),
    dueReviews
  };
}
