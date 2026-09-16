import { useEffect, useMemo, useState, type ReactElement } from "react";
import { buildFlowPlan, FLOW_LIMITS } from "@codebase-tutor/shared";
import type { RepositoryAnalysis, SourceAnchor } from "@codebase-tutor/shared";

/**
 * 宏观设计 v0.9：流程视图（与 `DepMap` 的架构视图并列）。
 *
 * 架构视图回答「有哪些模块、谁依赖谁」，流程视图回答「一次执行从入口出发经过哪些环节」。
 * 数据全部来自 `analysis.graph` 的静态分析结果：
 * - 环节 = 被调用函数（符号表里有定义就取其定义位置，否则回落到文件）；
 * - 只展开**跨文件**调用，同文件内部调用只计数——流程视图要表达的是模块之间的流转；
 * - 每步的分支按「该去向自己还能展开出多长的链」排序、连续编号，各自的下游紧随其后，
 *   避免入口文件里的收尾型调用（close 之类）挤掉主线；
 * - 环（回到自己的上游）与复用（共享下游）分别标注，不静默丢弃任何去向。
 *
 * 上限由 `FLOW_LIMITS` 给定（5 跳 / 每步 6 条分支 / 共 24 步），超出部分在页脚明示数量。
 * 间接调用（回调注册、反射、依赖注入）不在静态调用边里，页脚一并说明，避免读者误以为流程就这些。
 */
/**
  engine 的入口标签是英文短语（`detectEntrypoints`），界面上按项目惯例转中文；
  没收录的标签原样显示，不编造译名。
  */
function entryLabel(label: string): string {
  if (label === "conventional entrypoint") return "约定入口文件";
  if (label === "package main") return "package.json main";
  if (label === "CLI command") return "CLI 命令";
  const script = label.match(/^script:\s*(.+)$/);
  return script ? `启动脚本 ${script[1]}` : label;
}

export function FlowMap({ analysis, lineOf, selectedPath, onOpenFile }: {
  analysis: RepositoryAnalysis;
  lineOf: Map<string, number>;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
}): ReactElement {
  const entries = useMemo(() => analysis.graph.entrypoints, [analysis]);
  const [entryPath, setEntryPath] = useState(() => entries[0]?.path ?? "");
  useEffect(() => {
    if (!entries.some((entry) => entry.path === entryPath)) setEntryPath(entries[0]?.path ?? "");
  }, [entries, entryPath]);

  const entry: SourceAnchor | undefined = entries.find((item) => item.path === entryPath) ?? entries[0];
  const plan = useMemo(() => (entry ? buildFlowPlan(analysis, entry) : null), [analysis, entry]);

  if (!plan) {
    return (
      <div className="map-scroll">
        <div className="map-inner flow-inner">
          <p className="flow-empty">该仓库没有识别到执行入口，流程视图无法展开。入口由 package.json 的 main/bin/scripts 与 main/server/app/index 等约定文件名推断（engine 侧 `detectEntrypoints`）。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="map-scroll">
      <div className="map-inner flow-inner">
        <div className="flow-entries" role="group" aria-label="选择执行入口">
          {entries.map((item) => (
            <button
              key={item.path}
              type="button"
              className={item.path === plan.entry.path ? "active" : ""}
              title={`${item.path}（${item.label}）`}
              onClick={() => setEntryPath(item.path)}
            >
              <strong>{entryLabel(item.label)}</strong>
              <small>{item.path}</small>
            </button>
          ))}
        </div>

        <ol className="flow-chain">
          {plan.steps.map((step) => {
            const classes = [
              "flow-step",
              step.kind === "entry" ? "entry" : "",
              selectedPath === step.path ? "selected" : ""
            ].filter(Boolean).join(" ");
            const lines = lineOf.get(step.path);
            const pending = step.branches - step.expanded;
            return (
              <li key={`${step.order}:${step.path}:${step.line}`}>
                <button type="button" className={classes} onClick={() => onOpenFile(step.path)}>
                  <span className="flow-step-order">{String(step.order).padStart(2, "0")}</span>
                  <span className="flow-step-main">
                    <span className="flow-step-kind">
                      {step.kind === "entry" ? `入口 · ${entryLabel(plan.entry.label)}` : `第 ${step.depth} 跳${step.language ? ` · ${step.language}` : ""}`}
                    </span>
                    <strong>{step.title}</strong>
                    <small className="flow-step-where">{`${step.path}:${step.line}${lines ? ` · 共 ${lines} 行` : ""}`}</small>
                    {step.from
                      ? <small className="flow-step-from">{`← ${step.from.title} 调用（${step.from.path}:${step.from.line}）`}</small>
                      : <small className="flow-step-from">流程起点</small>}
                    <span className="flow-step-flags">
                      {step.branches > 1 ? <em className="flag-branch">{`分叉 ×${step.branches}`}</em> : null}
                      {pending > 0 ? <em className="flag-pending">{`未展开 ${pending}`}</em> : null}
                      {step.loops.length ? <em className="flag-loop">{`↺ 回到 #${step.loops.join("、#")}`}</em> : null}
                      {step.revisits.length ? <em className="flag-reuse">{`已展开于 #${step.revisits.join("、#")}`}</em> : null}
                      {step.sameFileCalls ? <em className="flag-same">{`同文件 ${step.sameFileCalls} 处调用`}</em> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <p className="flow-footnote">
          {`流程来自静态分析的跨文件调用（graph.calls）：同文件内部调用只计数不展开；按主线深度优先展开，上限 ${FLOW_LIMITS.maxDepth} 跳 / 每步 ${FLOW_LIMITS.maxBranchesPerStep} 条分支 / 共 ${FLOW_LIMITS.maxSteps} 步。`}
          {plan.truncated ? `本次有 ${plan.omitted} 个去向未展开。` : "全部去向均已展开。"}
          {"回调注册、反射、依赖注入等间接调用不在静态调用边里，属于本视图的已知边界。"}
        </p>
      </div>
    </div>
  );
}
