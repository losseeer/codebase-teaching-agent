import type { ReactElement } from "react";
import { RefreshCw } from "lucide-react";
import type { CourseNode, ExerciseKind, ImportJob, Pedagogy, TutorSession } from "@codebase-tutor/shared";

/**
 * views/ 共享的小工具：
 * - Loading / EmptyState：通用占位 UI
 * - phaseLabel / exerciseKindLabel：枚举 → 中文文案
 * - stageIndex：Socratic 5 阶段 → 0..4 序号（教学阶梯 L1→L5）
 * - Segmented：分段控件（教学法 / 拆解层次）
 * - firstTeachNode / flatten / replaceCourseNode：课程树遍历
 * - MicroDetail：课程节点详情（微观拆解）
 *
 * 对应 prototype `design-prototype.html` 中散落的 helper 函数。
 */

export function Loading(): ReactElement {
  return <div className="loading"><RefreshCw className="spin" size={18} />正在读取本地课程数据</div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }): ReactElement {
  return <section className="page empty-state"><h1>{title}</h1><p>{detail}</p></section>;
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
    output_prediction: "预测输出",
    change_localization: "修改定位",
    impact_analysis: "影响分析",
    llm_rubric: "主题练习"
  })[kind];
}

export function stageIndex(stage?: TutorSession["stage"]): number {
  return ({ orient: 0, procedure: 1, concept: 2, verify: 3, confirmed: 4 })[stage ?? "orient"];
}

/** 苏格拉底教学五阶段文案（prototype 的「教学阶梯」），Agent 侧栏 scope-context 的「阶段」行使用。 */
export const TEACHING_STAGES = ["L1 定向", "L2 程序", "L3 概念", "检验", "确认"] as const;

export function stageLabel(stage?: TutorSession["stage"]): string {
  return TEACHING_STAGES[stageIndex(stage)];
}

export function Segmented({ value, items, onChange }: { value: string; items: { value: Pedagogy | "macro" | "micro"; label: string }[]; onChange: (value: string) => void }): ReactElement {
  return <div className="segmented">{items.map((item) => <button key={item.value} className={value === item.value ? "selected" : ""} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

export function firstTeachNode(root: CourseNode): CourseNode {
  return flatten(root).find((node) => node.kind === "workflow" && node.anchors.length) ?? root;
}

export function flatten(root: CourseNode): CourseNode[] {
  return [root, ...root.children.flatMap(flatten)];
}

export function replaceCourseNode(root: CourseNode, nodeId: string, update: (node: CourseNode) => CourseNode): CourseNode {
  if (root.id === nodeId) return update(root);
  return { ...root, children: root.children.map((child) => replaceCourseNode(child, nodeId, update)) };
}

export function MicroDetail({ detail }: { detail: { implementation?: import("@codebase-tutor/shared").ImplementationUnit } | null }): ReactElement | null {
  const implementation = detail?.implementation;
  if (implementation) return <div className="micro-detail"><div><span>输入</span><p>{implementation.inputs.join("、")}</p></div><div><span>输出</span><p>{implementation.output}</p></div><div><span>不变量</span><p>{implementation.invariants.join("；")}</p></div><div><span>边界与陷阱</span><p>{[...implementation.boundaries, ...implementation.traps].join("；") || "尚未检测到显式边界。"}</p></div></div>;
  return null;
}