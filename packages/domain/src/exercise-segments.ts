/**
  出题分段产出：三段的名字与识别规则。

  分段只改出题的**产出节奏**（题面 → 代码 → 测试），产物仍是一道完整的题、一次性呈现。
  段名会出现在轨迹里：模型帧的 `stepId` 以段名打头（`prompt-m1` / `code-1` / `tests-1`），
  帧的 `label` 就是段名。轨迹回放据此把一次出题还原成三段。

  放在共享内核：引擎产帧、回放时认段，两边都要用同一份约定，改一处就够。
*/

/** 出题的三段，顺序即产出顺序。 */
export const EXERCISE_SEGMENTS = ["prompt", "code", "tests"] as const;
export type ExerciseSegment = (typeof EXERCISE_SEGMENTS)[number];

/** 每一段在轨迹里显示的名字。改这里等于改用户看到的文案。 */
export const EXERCISE_SEGMENT_LABEL: Record<ExerciseSegment, string> = {
  // 三段统一成「动词 + 名词」的三字短语：轨迹里并排出现时才像一套工序。
  // 「出题面」不取：它读起来像「出/题面」，而且和回合标题「出题 · 主题」重复。
  prompt: "拟题面",
  code: "写实现",
  tests: "写测试"
};

/** 从模型帧的 stepId 反推它属于哪一段；不是分段帧就返回 undefined。 */
export function exerciseSegmentOf(stepId: string | undefined): ExerciseSegment | undefined {
  if (!stepId) return undefined;
  const head = stepId.split("-")[0];
  return (EXERCISE_SEGMENTS as readonly string[]).includes(head) ? (head as ExerciseSegment) : undefined;
}
