import { useEffect, useState, type ReactElement } from "react";
import { Sparkles } from "lucide-react";
import type { FlowStage, FlowStageKind, RepositoryAnalysis, RepositoryFlow } from "@codebase-tutor/shared";
import { api } from "../api/client";

/**
 * 宏观设计 v0.10：流程视图（与 `DepMap` 的架构视图并列）。

 * 两个视图的分工：
 * - 架构视图由**文件**驱动：节点 = 目录聚合模块，边 = import 依赖。客观、稳定、可穷举。
 * - 流程视图由**LLM 生成**：环节是一次执行经过的步骤，每个环节的关联文件**只出现在节点详情里**。
 *
 * 为什么流程不画静态调用链：`add_node("evaluate", evaluate)`、路由表、插件与依赖注入这类**编排**
 * 不产生调用边，静态链在真正的主干处是断的。模型能从文件与符号语义里读出编排，这正是本视图的增量。
 * 静态调用链仍在，它作为模型输入，并在 LLM 不可用时充当降级视图——降级会显式标注，不冒充模型结论。
 *
 * 环节数、关联文件数都由 engine 侧校验（路径必须真实存在，行号必须落在文件范围内），
 * 前端不再二次猜测；`caveats` 原样展示，包含被丢弃的环节与文件。
 */

/** 环节性质的中文展示；详情抽屉与画布共用同一份，避免一处一个叫法。 */
export const FLOW_KIND_LABEL: Record<FlowStageKind, string> = {
  entry: "入口",
  stage: "环节",
  decision: "判断",
  loop: "回环",
  exit: "出口"
};

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

interface FlowState {
  flow: RepositoryFlow;
  source: "llm" | "static";
  reason?: string;
}

/** 选中的环节 + 它所属的流程（详情抽屉需要两者：环节给文件，流程给标题与边界）；null 表示未选。 */
export interface FlowSelection {
  stage: FlowStage;
  flow: RepositoryFlow;
}

export function FlowMap({ repositoryId, analysis, selectedStageOrder, onSelectStage }: {
  repositoryId: string;
  analysis: RepositoryAnalysis;
  selectedStageOrder?: number;
  onSelectStage: (selection: FlowSelection | null) => void;
}): ReactElement {
  const entries = analysis.graph.entrypoints;
  const [entryPath, setEntryPath] = useState(() => entries[0]?.path ?? "");
  const [state, setState] = useState<FlowState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!entries.some((entry) => entry.path === entryPath)) setEntryPath(entries[0]?.path ?? "");
  }, [entries, entryPath]);

  useEffect(() => {
    if (!entryPath) return;
    let current = true;
    setLoading(true);
    setError("");
    setState(null);
    api.getRepositoryFlow(repositoryId, entryPath)
      .then((result) => { if (current) setState(result); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "无法生成流程"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
    // analysis.versionStamp 变化（仓库重分析）后流程需要重新生成
  }, [repositoryId, entryPath, analysis.versionStamp]);

  if (!entries.length) {
    return (
      <div className="map-scroll">
        <div className="map-inner flow-inner">
          <p className="flow-empty">该仓库没有识别到执行入口，流程视图无法生成。入口由 package.json 的 main/bin/scripts 与 main/server/app/index 等约定文件名推断（engine 侧 `detectEntrypoints`）。</p>
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
              className={item.path === entryPath ? "active" : ""}
              title={`${item.path}（${item.label}）`}
              onClick={() => { setEntryPath(item.path); onSelectStage(null); }}
            >
              <strong>{entryLabel(item.label)}</strong>
              <small>{item.path}</small>
            </button>
          ))}
        </div>

        {loading ? (
          <p className="flow-status"><Sparkles size={13} />正在生成流程…（首次生成由 LLM 完成，之后同一版本直接命中缓存）</p>
        ) : null}
        {error ? <p className="flow-status error">{error}</p> : null}

        {state ? (
          <>
            <div className="flow-head">
              <h3>{state.flow.title}</h3>
              <p>{state.flow.summary}</p>
            </div>
            {state.source === "static" ? (
              <p className="flow-degraded">
                <strong>以下不是模型生成，而是静态调用链降级视图。</strong>
                {state.reason ? `原因：${state.reason}。` : ""}
                它只反映代码里的跨文件调用，看不到回调注册、路由表与依赖注入等编排，环节可能比真实执行路径少。
              </p>
            ) : null}

            <ol className="flow-chain">
              {state.flow.stages.map((stage) => {
                const classes = [
                  "flow-step",
                  stage.kind === "entry" ? "entry" : "",
                  selectedStageOrder === stage.order ? "selected" : ""
                ].filter(Boolean).join(" ");
                return (
                  <li key={stage.order}>
                    <button
                      type="button"
                      className={classes}
                      onClick={() => onSelectStage(selectedStageOrder === stage.order ? null : { stage, flow: state.flow })}
                    >
                      <span className="flow-step-order">{String(stage.order).padStart(2, "0")}</span>
                      <span className="flow-step-main">
                        <span className="flow-step-kind">{FLOW_KIND_LABEL[stage.kind]}</span>
                        <strong>{stage.title}</strong>
                        <small className="flow-step-detail">{stage.detail}</small>
                        <span className="flow-step-flags">
                          {stage.loopsTo !== undefined ? <em className="flag-loop">{`↺ 回到 #${stage.loopsTo}`}</em> : null}
                          {stage.files.length ? <em className="flag-files">{`关联 ${stage.files.length} 个文件`}</em> : null}
                        </span>
                        {stage.branches.length ? (
                          <span className="flow-step-branches">
                            {stage.branches.map((branch) => <em key={branch}>{branch}</em>)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <p className="flow-footnote">
              {`共 ${state.flow.stages.length} 个环节。每个环节的关联文件在右侧「节点详情」里，点环节打开。`}
              {state.flow.caveats ? `已知边界：${state.flow.caveats}` : ""}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
