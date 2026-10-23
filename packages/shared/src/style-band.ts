/** 风格档是 0~100 的连续值；预设值仍是 35、50、65。 */
export type StyleLevel = number;

/**
  语言风格档位的判据与展示名 —— engine 与 GUI 的唯一来源（两侧都从这里取，不各写阈值）：
  别处写死一个数字就会和这里的取值不一致，同一个滑块出现两套口径。
  档位只决定基调和回显名；档内的逐步细化在 engine 的 harness/prompts.ts（那里的 `at` 阈值是叠加在档位之上的补充要求）。
*/
export const STYLE_BAND_THRESHOLDS = { rigorousMax: 33, plainMin: 67 } as const;

export type StyleBand = "plain" | "neutral" | "rigorous";

export const STYLE_BAND_LABEL: Record<StyleBand, string> = { rigorous: "严肃", neutral: "普通", plain: "通俗" };

/** 非有限值（NaN / Infinity）按中间档（普通）处理，与 engine `validateStyle` 的回落值 50 落在同一档。 */
export function styleBand(style: number): StyleBand {
  if (!Number.isFinite(style)) return "neutral";
  if (style >= STYLE_BAND_THRESHOLDS.plainMin) return "plain";
  if (style <= STYLE_BAND_THRESHOLDS.rigorousMax) return "rigorous";
  return "neutral";
}
