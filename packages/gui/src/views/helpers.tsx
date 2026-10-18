import type { ReactElement } from "react";
import type { CourseNode, ExerciseKind } from "@codebase-tutor/shared";

/**
  views/ 共享的小工具：
  - Loading / EmptyState：通用占位 UI
  - exerciseKindLabel：题型枚举 → 中文文案（导入阶段的文案在 ImportPage 的 PHASES 表里）
  - firstTeachNode / flatten：课程树遍历
 */

export function Loading(): ReactElement {
  return <div className="loading"><i className="spinner" aria-hidden />正在读取本地课程数据</div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }): ReactElement {
  return (
    <section className="page page-import">
      <div className="import-wrap">
        <div className="import-hero"><h1>{title}</h1><p>{detail}</p></div>
      </div>
    </section>
  );
}

/** 中文日期：界面是中文的，别露出 10/17/2026 这种美式串。 */
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

export function firstTeachNode(root: CourseNode): CourseNode {
  return flatten(root).find((node) => node.kind === "workflow" && node.anchors.length) ?? root;
}

export function flatten(root: CourseNode): CourseNode[] {
  return [root, ...root.children.flatMap(flatten)];
}

