import type { ReactElement } from "react";
import type { ExerciseKind } from "@codebase-tutor/shared/wire";

// views/ 共享的小工具：加载占位与题型、日期的中文文案。

export function Loading(): ReactElement {
  return <div className="loading"><i className="spinner" aria-hidden />正在读取本地数据</div>;
}

/** 中文日期文案：只显示到日；时间戳读不出时明说。 */
export function dateText(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? `${date.getMonth() + 1} 月 ${date.getDate()} 日` : "日期未上报";
}

export function exerciseKindLabel(kind: ExerciseKind): string {
  return ({
    change_localization: "修改定位",
    impact_analysis: "影响分析",
    patch_edit: "修改实现",
    author_function: "从零实现",
    llm_rubric: "主题练习"
  })[kind];
}

