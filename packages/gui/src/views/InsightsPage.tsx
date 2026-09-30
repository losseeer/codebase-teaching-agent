import { useCallback, useEffect, useState, type ReactElement } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import type { CostSummary } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";

/**
 * 成本监控页：本月 token 用量的仪表读数 + 月度预算设置。
 * 读数全部来自引擎对本月 `token_usage` 事件的聚合（`cost/cost.ts`），这里只做呈现与分桶明细，
 * 不二次估算——所以「未配单价」这种会让金额恒为 0 的事实必须显式说出来，而不是留一句 $0.0000 让人误读。
 */

/** 场景取值 → 界面叫法。取值清单是引擎 `JournalEventType["token_usage"]` 的 scene 白名单，两边要同步。 */
const SCENE_LABEL: Record<string, string> = {
  teach: "代码教学",
  map_chat: "宏观设计对话",
  practice_chat: "练习评估对话",
  course_map: "课程树生成",
  flow_map: "流程视图生成",
  module_entries: "推荐入口",
  exercise_generate: "练习生成",
  exercise_llm_generate: "练习生成",
  exercise_feedback_polish: "反馈润色",
  unknown: "未标注"
};

const usd = (value: number): string => `$${value.toFixed(4)}`;
const tokensText = (value: number): string => value.toLocaleString();

export function InsightsPage({ workspace }: { workspace: Workspace }): ReactElement {
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [budget, setBudget] = useState("5");
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** 每次拉取都先清掉上一回合的错误：原来一次失败就把红字永久挂在页面上，数据明明已经刷成功了。 */
  const refresh = useCallback((): void => {
    setError("");
    api.getCost(workspace.repositoryId)
      .then((summary) => { setCost(summary); setBudget(String(summary.monthlyBudgetUsd)); setSavedAt(new Date().toLocaleTimeString()); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取成本"));
  }, [workspace.repositoryId]);
  useEffect(refresh, [refresh]);
  const saveBudget = async (): Promise<void> => {
    try {
      setCost(await api.setBudget(workspace.repositoryId, Number(budget)));
      setSavedAt(new Date().toLocaleTimeString());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存预算");
    }
  };

  const pricingConfigured = cost?.pricingConfigured ?? true;
  const usedRatio = cost && cost.monthlyBudgetUsd > 0 ? Math.min(1, cost.estimatedCostUsd / cost.monthlyBudgetUsd) : 0;
  const dayPeak = cost?.byDay.reduce((peak, day) => Math.max(peak, day.inputTokens + day.outputTokens), 0) ?? 0;

  return (
    <section className="page cost-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">运行控制</p>
          <h1>成本监控</h1>
          <p>本月 Token 用量与三档单价（输入未命中 / 输入缓存命中 / 输出）的计价明细，另有按场景、按模型的分布与降级情况。</p>
        </div>
        <div className="cost-toolbar">
          <span className="cost-stamp">{savedAt ? `读数 ${savedAt}` : "正在读取…"}</span>
          <button type="button" className="secondary" onClick={refresh}><RefreshCw size={14} /> 刷新</button>
        </div>
      </header>
      {/* 错误紧跟标题：原来挂在整页最底部，读数失败时页面照常显示 0.0000，红字要滚到底才看得见 */}
      {error && <p className="error-message cost-error">{error}</p>}

      <section className="cost-hero">
        <div className="cost-amount-block">
          <div className="panel-title"><BarChart3 size={18} /><h2>本月成本</h2></div>
          <strong className="cost-amount">{usd(cost?.estimatedCostUsd ?? 0)}</strong>
          <p className="cost-amount-note">
            {cost ? `${tokensText(cost.billedInputTokens)} 输入未命中 · ${tokensText(cost.cacheHitTokens)} 缓存命中 · ${tokensText(cost.outputTokens)} 输出 · ${cost.turns} 个回合` : "读取中"}
          </p>
          <div className={`mode-label ${cost?.mode ?? "normal"}`}>
            {cost?.mode === "degraded" ? "已触顶，降级为本地规则" : "正常运行"}
          </div>
        </div>
        <div className="cost-budget-block">
          <div className="cost-budget-head">
            <span>月度预算 {usd(cost?.monthlyBudgetUsd ?? 0)}</span>
            <span>{Math.round(usedRatio * 100)}% 已用</span>
          </div>
          <div className="cost-bar" role="img" aria-label={`预算已用 ${Math.round(usedRatio * 100)}%`}>
            <i style={{ width: `${usedRatio * 100}%` }} />
          </div>
          <p className="muted">剩余 {usd(cost?.remainingBudgetUsd ?? 0)}；触顶后教学与对话改走本地规则，不再付 token。</p>
          <label className="budget-field">调整月度预算（USD）
            <span>
              <input type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} />
              <button className="primary" onClick={() => void saveBudget()}>更新</button>
            </span>
          </label>
        </div>
      </section>

      {cost && cost.turns > 0 && (
        <>
          <div className="cost-readouts">
            <div className="readout" title="含缓存命中那部分，与模型上报的 prompt_tokens 同口径"><span>输入 tokens</span><strong>{tokensText(cost.inputTokens)}</strong></div>
            <div className="readout" title="输入里按未命中价计费的那部分 = 输入 − 命中"><span>未命中输入</span><strong>{tokensText(cost.billedInputTokens)}</strong></div>
            <div className="readout" title="模型复用同一份前缀时省下的输入，按命中价计费；端点没上报则为 0"><span>命中输入（缓存）</span><strong>{tokensText(cost.cacheHitTokens)}</strong></div>
            <div className="readout"><span>输出 tokens</span><strong>{tokensText(cost.outputTokens)}</strong></div>
            <div className="readout"><span>计费回合</span><strong>{cost.turns - cost.degradedTurns}</strong></div>
            <div className="readout" title="预算触顶后走本地规则、未付 token 的回合数"><span>降级回合</span><strong>{cost.degradedTurns}</strong></div>
          </div>
          {!pricingConfigured && (
            <p className="cost-notice">
              还没配单价（环境变量 <code>TUTOR_INPUT_USD_PER_MILLION</code> / <code>TUTOR_CACHE_HIT_USD_PER_MILLION</code> / <code>TUTOR_OUTPUT_USD_PER_MILLION</code>），所以金额恒为 $0.0000——上面的 token 用量是真实读数，不受影响。
            </p>
          )}

          <div className="cost-columns">
            <section className="cost-table">
              <div className="panel-title"><h2>计价明细</h2></div>
              <table>
                <thead><tr><th>档位</th><th>tokens</th><th>单价/百万</th><th>金额</th></tr></thead>
                <tbody>
                  {cost.costComponents.map((component) => (
                    <tr key={component.label} title={component.rateFallback ? "命中价未单独配置，按输入价计（未打折）" : undefined}>
                      <td>{component.label}</td>
                      <td>{tokensText(component.tokens)}</td>
                      <td>{pricingConfigured ? `$${component.ratePerMillionUsd}` : "未配置"}</td>
                      <td>{usd(component.estimatedCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">金额=三档之和；命中那档若标了「未打折」，说明只配了输入价，实际账单通常比这里低。</p>
            </section>
            <section className="cost-table">
              <div className="panel-title"><h2>按场景</h2></div>
              <table>
                <thead><tr><th>场景</th><th>回合</th><th>输入</th><th>输出</th></tr></thead>
                <tbody>
                  {cost.byScene.map((row, index) => (
                    <tr key={`${row.label}-${String(index)}`}>
                      <td title={row.label}>{SCENE_LABEL[row.label] ?? row.label}</td>
                      <td>{row.turns}</td>
                      <td>{tokensText(row.inputTokens)}</td>
                      <td>{tokensText(row.outputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="cost-table">
              <div className="panel-title"><h2>按模型</h2></div>
              <table>
                <thead><tr><th>Provider</th><th>回合</th><th>输入</th><th>输出</th></tr></thead>
                <tbody>
                  {cost.byProvider.map((row, index) => (
                    <tr key={`${row.label}-${String(index)}`}>
                      <td><code title={row.label}>{row.label}</code></td>
                      <td>{row.turns}</td>
                      <td>{tokensText(row.inputTokens)}</td>
                      <td>{tokensText(row.outputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="cost-days">
            <div className="panel-title"><h2>本月逐日</h2></div>
            <div className="cost-days-track">
              {cost.byDay.slice(-14).map((day) => {
                const total = day.inputTokens + day.outputTokens;
                const barPx = dayPeak > 0 ? Math.round(8 + (total / dayPeak) * 68) : 8;
                return (
                  <div
                    className="cost-day"
                    key={day.date}
                    title={`${day.date} · 输入 ${tokensText(day.inputTokens)} / 输出 ${tokensText(day.outputTokens)}`}
                  >
                    <i style={{ height: `${barPx}px` }} />
                    <span>{day.date.slice(8)}</span>
                  </div>
                );
              })}
            </div>
            <p className="muted">只显示本月近 14 个有用量的日子，条形高度按其中峰值归一；悬停看每天的输入/输出用量。</p>
          </section>
        </>
      )}

      {cost && cost.turns === 0 && <p className="cost-empty">本月还没有 token 开销记录——去代码教学问一句，或生成一道练习，读数就会进来。</p>}
    </section>
  );
}
