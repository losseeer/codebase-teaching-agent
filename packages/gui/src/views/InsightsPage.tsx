import { useEffect, useState, type ReactElement } from "react";
import { BarChart3, BrainCircuit, FlaskConical } from "lucide-react";
import type { CostSummary, LearnerProfile } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";

/**
 * 成本与实验页：月度成本仪表 + 月度预算设置 + 三组对照实验 + 学习者模型面板。
 * - 成本：会话级 / 仓库级 / 本月累计；预算触顶降级运行（cost.mode = "degraded"）
 * - 实验：A_tutor / B_direct_answer / C_no_assistant 三组对照；CSV 导出到 `/api/repositories/:id/experiment/export.csv`
 * - 学习者：推荐档 + faded 辅助 + 单元掌握度图
 *
 * 与 §1.4 关系：InsightsPage 是「成本 / 实验」侧栏（dev plan §1.2 列为辅助面板），
 * 不在 7 个工作区目录内——放在 views/ 是临时归位，v0.2+ 可拆到 `insights/` 子目录。
 */

export function InsightsPage({ workspace }: { workspace: Workspace }): ReactElement {
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [learner, setLearner] = useState<LearnerProfile | null>(null);
  const [budget, setBudget] = useState("5");
  const [experiment, setExperiment] = useState<{ assignedGroup?: string; name?: string } | null>(null);
  const [participantId, setParticipantId] = useState("");
  const [error, setError] = useState("");
  const refresh = (): void => {
    api.getCost(workspace.repositoryId).then((summary) => { setCost(summary); setBudget(String(summary.monthlyBudgetUsd)); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取成本"));
    api.getExperiment(workspace.repositoryId).then(setExperiment).catch(() => setExperiment(null));
    api.getLearner(workspace.repositoryId).then(setLearner).catch(() => setLearner(null));
  };
  useEffect(refresh, [workspace.repositoryId]);
  const saveBudget = async (): Promise<void> => { try { setCost(await api.setBudget(workspace.repositoryId, Number(budget))); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存预算"); } };
  const startExperiment = async (): Promise<void> => { try { setExperiment(await api.createExperiment(workspace.repositoryId, "M1 三组对照", participantId)); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建实验"); } };
  return (
    <section className="page insights-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">运行控制</p>
          <h1>成本与实验</h1>
          <p>本地日志按仓库保存，可在研究流程中导出。</p>
        </div>
      </header>
      <div className="insights-grid">
        <section className="insight-panel">
          <div className="panel-title"><BarChart3 size={18} /><h2>本月成本</h2></div>
          <strong className="metric">${cost?.estimatedCostUsd.toFixed(4) ?? "0.0000"}</strong>
          <p>{cost?.inputTokens.toLocaleString() ?? 0} 输入 tokens · {cost?.outputTokens.toLocaleString() ?? 0} 输出 tokens</p>
          <div className={`mode-label ${cost?.mode ?? "normal"}`}>{cost?.mode === "degraded" ? "已降级为本地后备" : "正常运行"}</div>
          <label className="budget-field">月度预算（USD）
            <span>
              <input type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} />
              <button className="secondary" onClick={() => void saveBudget()}>更新</button>
            </span>
          </label>
        </section>
        <section className="insight-panel">
          <div className="panel-title"><FlaskConical size={18} /><h2>三组对照</h2></div>
          {experiment ? (
            <>
              <strong className="experiment-group">{experiment.assignedGroup ?? "等待分配"}</strong>
              <p>{experiment.name}</p>
              <a className="secondary export-link" href={`/api/repositories/${workspace.repositoryId}/experiment/export.csv`}>导出 CSV</a>
            </>
          ) : (
            <>
              <label className="budget-field">参与者标识<input value={participantId} onChange={(event) => setParticipantId(event.target.value)} placeholder="匿名标识" /></label>
              <button className="primary" onClick={() => void startExperiment()} disabled={!participantId.trim()}>创建并分配</button>
            </>
          )}
        </section>
      </div>
      <section className="learner-panel">
        <div className="panel-title"><BrainCircuit size={18} /><h2>学习者模型</h2></div>
        <div className="learner-summary">
          <div>
            <span>推荐档</span>
            <strong>{learner ? `风格 ${learner.recommended.settings.style} · ${learner.recommended.settings.depth === "macro" ? "宏观" : "微观"}` : "暂无数据"}</strong>
            <small>{learner?.recommended.reason ?? "完成一次教学或练习后生成推荐"}</small>
          </div>
          <div>
            <span>faded 辅助</span>
            <strong>{learner ? `${learner.faded.sampleCompleteness}/${learner.faded.hintDepth}/${learner.faded.stylePlainness}` : "暂无数据"}</strong>
            <small>{learner?.faded.reason ?? "掌握后按线索逐档消退"}</small>
          </div>
        </div>
        {learner?.mastery.length ? (
          <div className="mastery-map">
            {learner.mastery.map((entry) => (
              <div className="mastery-row" key={entry.unitId}>
                <code>{entry.unitId}</code>
                <span className="mastery-track"><i style={{ width: `${(entry.level / 5) * 100}%` }} /></span>
                <strong>{entry.level}/5</strong>
                <small>{Math.round(entry.successRate * 100)}% 通过</small>
              </div>
            ))}
          </div>
        ) : <p className="muted">完成练习或教学确认后，这里会显示按单元聚合的掌握度。</p>}
      </section>
      {error && <p className="error-message">{error}</p>}
    </section>
  );
}