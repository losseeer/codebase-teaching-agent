import type { ReactElement } from "react";
import type { CourseNode, ExerciseKind, ImplementationUnit, ImportJob } from "@codebase-tutor/shared";
import { Icon } from "../ui/icons";

/**
  views/ 共享的小工具：
  - Loading / EmptyState：通用占位 UI
  - phaseLabel / exerciseKindLabel：枚举 → 中文文案
  - firstTeachNode / flatten：课程树遍历
  - MicroDetail：微观拆解（输入 / 输出 / 不变量 / 边界与陷阱）——抽屉里的 `.kv` 四行
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

export function phaseLabel(phase: ImportJob["phase"]): string {
  return ({
    queued: "队列中",
    indexing: "索引文件与 Git 历史",
    summarizing: "摘要缓存与分层归纳",
    building_course: "构建入口课程树",
    completed: "完成",
    failed: "失败"
  })[phase];
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

/** 微观拆解四行：没有实现单元时不渲染（旧产物与概览节点都没有）。 */
export function MicroDetail({ detail }: { detail: { implementation?: ImplementationUnit } | null }): ReactElement | null {
  const implementation = detail?.implementation;
  if (!implementation) return null;
  const rows: [string, string][] = [
    ["输入", implementation.inputs.join("、")],
    ["输出", implementation.output],
    ["不变量", implementation.invariants.join("；")],
    ["边界与陷阱", [...implementation.boundaries, ...implementation.traps].join("；") || "尚未检测到显式边界。"]
  ];
  return (
    <>
      {rows.map(([label, value]) => (
        <div className="kv" key={label}>
          <span className="kv-k">{label}</span>
          <span className="kv-v muted">{value}</span>
        </div>
      ))}
    </>
  );
}
