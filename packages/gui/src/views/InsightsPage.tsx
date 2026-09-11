import { useEffect, useState, type ReactElement } from "react";
import { BarChart3, BrainCircuit } from "lucide-react";
import type { CostSummary, LearnerProfile } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";

/**
 * 成本监控页：月度成本仪表 + 月度预算设置 + 学习者模型面板。
 * - 成本：输入/输出 token 统计、本月累计美元成本；预算触顶降级运行（cost.mode = "degraded"）
 * - 学习者：推荐档 + faded 辅助 + 单元掌握度图
 *
 * 与 §1.4 关系：InsightsPage 是「成本」侧栏（dev plan §1.2 列为辅助面板），
 * 不在 7 个工作区目录内——放在 views/ 是临时归位，v0.2+ 可拆到 `insights/` 子目录。
 */

export function InsightsPage({ workspace }: { workspace: Workspace }): ReactElement {
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [learner, setLearner] = useState<LearnerProfile | null>(null);
  const [budget, setBudget] = useState("5");
  const [error, setError] = useState("");
  const refresh = (): void => {
    api.getCost(workspace.repositoryId).then((summary) => { setCost(summary); setBudget(String(summary.monthlyBudgetUsd)); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取成本"));
    api.getLearner(workspace.repositoryId).then(setLearner).catch(() => setLearner(null));
  };
  useEffect(refresh, [workspace.repositoryId]);
  const saveBudget = async (): Promise<void> => { try { setCost(await api.setBudget(workspace.repositoryId, Number(budget))); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存预算"); } };
  return (
    <section className="page insights-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">运行控制</p>
          <h1>成本监控</h1>
          <p>Token 用量与月度预算实时监测，预算触顶自动降级为本地后备。</p>
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
