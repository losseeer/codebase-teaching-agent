import type { MasteryLevel, MasteryRecord } from "@codebase-tutor/domain";

import { currentMastery } from "../learner/mastery.js";

/** 一个候选题目标：difficulty 是它对应的掌握度档位，value 是题目本体。 */
export interface ZpdTarget<T> {
  difficulty: MasteryLevel;
  id: string;
  title: string;
  value: T;
  /** 自包含度：跨文件依赖越多值越大。只在难度距离与难度都相同时参与排序，不改难度本身。 */
  selfContained?: number;
}

/** Selects an exercise no more than one level from the learner's latest mastery. */
export function selectZpdTarget<T>(targets: ZpdTarget<T>[], records: MasteryRecord[]): ZpdTarget<T> | undefined {
  if (!targets.length) return undefined;
  const mastery = currentMastery(records);
  const candidates = targets.filter((target) => Math.abs(target.difficulty - mastery) <= 1);
  if (!candidates.length) return undefined;
  return [...candidates].sort((left, right) => {
    const difficultyDistance = Math.abs(left.difficulty - mastery) - Math.abs(right.difficulty - mastery);
    return difficultyDistance || left.difficulty - right.difficulty
      || (left.selfContained ?? 0) - (right.selfContained ?? 0)
      || left.id.localeCompare(right.id);
  })[0];
}
