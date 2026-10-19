import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { CostSummary } from "@codebase-tutor/shared/wire";
import { api, type Workspace } from "../api/client";
import { LlmSettingsControl } from "../agent/LlmSettings";
import { Icon } from "../ui/icons";
import { PageTopbar } from "./WorkspaceChrome";

// 成本监控页：预算卡 → 指标 tiles → 逐日条形 → 场景 / Provider / 计价三表。
// 读数全部来自引擎对本月 `token_usage` 事件的聚合（`cost/cost.ts`），这里只做呈现与分桶明细，不二次估算；
// 单价未配时金额恒为 0，这一事实必须显式说出来。

/** 场景取值 → 界面叫法。取值清单是引擎 `JournalEventType["token_usage"]` 的 scene 白名单，两边同步。 */
const SCENE_LABEL: Record<string, string> = {
  teach: "代码教学",
  map_chat: "宏观设计对话",
  practice_chat: "练习评估对话",
  course_map: "课程树生成",
  module_entries: "推荐入口",
  exercise_generate: "练习生成",
  exercise_llm_generate: "练习生成",
  exercise_feedback_polish: "反馈润色",
  unknown: "未标注"
};

// 金额一律按人民币显示（¥）：字段名里的 `Usd` / `USD_PER_MILLION` 是存量键名
// （已落进 `llm-settings.json`、`repository_state.settings_json` 与接口契约，不能改），
// 引擎算出来的数原样带 ¥，不做汇率乘除。
const usd = (value: number): string => `¥${value.toFixed(4)}`;
const tokensText = (value: number): string => value.toLocaleString();

export function InsightsPage({ workspace }: { workspace: Workspace }): ReactElement {
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [budget, setBudget] = useState("5");
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** 每次拉取先清掉上一回合的错误，读取成功后不留残留红字。 */
  const refresh = useCallback((): void => {
    setError("");
    api.getCost(workspace.repositoryId)
      .then((summary) => { setCost(summary); setBudget(String(summary.monthlyBudgetUsd)); setSavedAt(new Date().toLocaleTimeString()); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取成本"));
  }, [workspace.repositoryId]);
  useEffect(refresh, [refresh]);
  // 引擎只收「有限非负数」：`Number("") === 0`，空串会被当成把月预算改成 0，
  // 那一档让此后所有付费分支都判为达到预算上限。
  const budgetNumber = Number(budget);
  const budgetValid = budget.trim() !== "" && Number.isFinite(budgetNumber) && budgetNumber >= 0;
  const saveBudget = async (): Promise<void> => {
    if (!budgetValid) return;
    try {
      setCost(await api.setBudget(workspace.repositoryId, budgetNumber));
      setSavedAt(new Date().toLocaleTimeString());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存预算");
    }
  };

  const pricingConfigured = cost?.pricingConfigured ?? true;
  /** 读数没拿到（首帧或拉取失败）时 `cost` 是 null，此时不能出现任何「正常」字样：
      闸门生效与否、金额、剩余都来自那一次读取。 */
  const readoutReady = cost !== null;
  const usedRatio = cost && cost.monthlyBudgetUsd > 0 ? Math.min(1, cost.estimatedCostUsd / cost.monthlyBudgetUsd) : 0;
  const overBudget = readoutReady && pricingConfigured && cost.mode === "degraded";
  const dayPeak = cost?.byDay.reduce((peak, day) => Math.max(peak, day.inputTokens + day.outputTokens), 0) ?? 0;

  return (
    <>
      <PageTopbar
        crumb={<>
          <b>成本监控</b>
          <span className="faint">·</span>
          <span className="muted" title="读数来自引擎对本月 token_usage 事件的聚合，界面不二次估算">journal token_usage 聚合</span>
          <span className="fs-11 faint mono">{savedAt ? `读数 ${savedAt}` : "正在读取…"}</span>
        </>}
        actions={<>
          <LlmSettingsControl variant="button" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}><Icon name="rotate" size={14} />刷新</button>
        </>}
      />
      <section className="page page-insights">
        <div className="insights-wrap">
          {/* 错误紧跟标题：读数失败时页面照常显示 0.0000，红字必须一眼可见 */}
          {error ? <div className="banner banner-danger"><Icon name="alert" /><span className="banner-text">{error}</span></div> : null}

          <section className="card budget-card col gap-3">
            <div className="row between">
              <div className="budget-num">
                {readoutReady ? usd(cost.estimatedCostUsd) : "—"}
                <small> / 月度预算 {cost ? usd(cost.monthlyBudgetUsd) : "—"}</small>
              </div>
              <span className={`badge ${!readoutReady ? "badge-neutral" : overBudget ? "badge-danger" : pricingConfigured ? "badge-ok" : "badge-warn"}`} title={!readoutReady ? "闸门管不管事来自那一次成本读取；读不到就不能替它说「正常」" : pricingConfigured ? undefined : "单价未配置 ⇒ 花费算不出来 ⇒ 「超预算降级」这道闸没在管事，这个 normal 不是读数"}>
                {!readoutReady ? "闸门状态：读数未到" : !pricingConfigured ? "无上限运行（闸门未生效）" : overBudget ? "已达到预算上限，降级为本地规则" : "正常运行 · 无降级回合"}
              </span>
            </div>
            <div className="progress" role="img" aria-label={cost ? `预算已用 ${Math.round(usedRatio * 100)}%` : "预算已用比例：读数未到"}>
              <div style={{ width: `${usedRatio * 100}%` }} />
            </div>
            <p className="field-note">
              {!readoutReady
                ? "读数没拿到，刷新一次再看。"
                : pricingConfigured
                  ? <>剩余 {usd(cost.remainingBudgetUsd)} · 达到预算上限后改走本地规则（已用 {Math.round(usedRatio * 100)}%）</>
                  : <>剩余 {usd(cost.remainingBudgetUsd)} 不算上限：没配单价就算不出已花金额。</>}
            </p>
            <label className="field budget-field">
              <span className="lbl">调整月度预算（人民币）</span>
              <span className="field-inline">
                <input
                  className="text-input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={budget}
                  aria-invalid={!budgetValid}
                  title={budgetValid ? "改成非负数即可；¥0 表示此后所有付费分支一律走本地规则" : "要一个有限的非负数字；留空不算 0"}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <button type="button" className="btn btn-primary btn-sm" disabled={!budgetValid} title={budgetValid ? undefined : "先填一个有限的非负数字"} onClick={() => void saveBudget()}>更新</button>
              </span>
            </label>
          </section>

          {readoutReady && cost.turns > 0 ? (
            <>
              <div className="tiles">
                <div className="card tile" title="含缓存命中部分，与模型上报的 prompt_tokens 同口径"><div className="t-val">{tokensText(cost.inputTokens)}</div><div className="t-lbl">输入 tokens</div></div>
                <div className="card tile" title="= 输入 − 命中"><div className="t-val">{tokensText(cost.billedInputTokens)}</div><div className="t-lbl">未命中输入</div></div>
                <div className="card tile" title="复用同一份前缀省下的输入，按命中价计；端点没上报则为 0"><div className="t-val">{tokensText(cost.cacheHitTokens)}</div><div className="t-lbl">命中输入（缓存）</div></div>
                <div className="card tile"><div className="t-val">{tokensText(cost.outputTokens)}</div><div className="t-lbl">输出 tokens</div></div>
                <div className="card tile"><div className="t-val">{cost.turns - cost.degradedTurns}</div><div className="t-lbl">计费回合</div></div>
                <div className="card tile" title="走本地规则、未付 token 的回合"><div className="t-val">{cost.degradedTurns}</div><div className="t-lbl">降级回合</div></div>
                <div className="card tile" title="单价没配 ⇒ 金额恒 ¥0 ⇒ 这道闸永远判未超支。单价在「模型与计价」里填，改完即生效"><div className="t-val">{pricingConfigured ? "生效中" : "未生效"}</div><div className="t-lbl">预算闸门</div></div>
              </div>

              {!pricingConfigured ? (
                <div className="banner banner-warn">
                  <Icon name="alert" />
                  <span className="banner-text" title="「模型与计价」→ 单价，填完即生效；留空回落 .env 的 TUTOR_*_USD_PER_MILLION">
                    没配单价 ⇒ 金额恒 ¥0.0000，<b>预算闸门也因此不管事</b>。上面的 token 用量是真读数。
                  </span>
                </div>
              ) : null}

              <section className="card card-pad col gap-3">
                <div className="section-title" title="柱高按本月单日最大 tokens 归一，悬停看每天输入/输出">本月逐日</div>
                <div className="bar-chart">
                  {cost.byDay.slice(-14).map((day) => {
                    const total = day.inputTokens + day.outputTokens;
                    const pct = dayPeak > 0 ? Math.max(2, Math.round((total / dayPeak) * 100)) : 2;
                    return (
                      <div className={`bar-col${total === dayPeak ? " peak" : ""}`} key={day.date} title={`${day.date} · 输入 ${tokensText(day.inputTokens)} / 输出 ${tokensText(day.outputTokens)}`}>
                        <span className="bar-val">{total >= 1000 ? `${Math.round(total / 1000)}k` : total}</span>
                        <span className="bar" style={{ height: `${pct}%` }} />
                        <span className="bar-lbl">{day.date.slice(8)}</span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="card card-pad col gap-2">
                <div className="section-title">按场景</div>
                <table className="table">
                  <thead><tr><th>场景</th><th className="num">回合</th><th className="num">输入</th><th className="num">输出</th></tr></thead>
                  <tbody>
                    {cost.byScene.map((row, index) => (
                      <tr key={`${row.label}-${String(index)}`}>
                        <td title={row.label}>{SCENE_LABEL[row.label] ?? row.label}</td>
                        <td className="num">{row.turns}</td>
                        <td className="num">{tokensText(row.inputTokens)}</td>
                        <td className="num">{tokensText(row.outputTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <div className="row gap-4 align-start">
                <section className="card card-pad col gap-2 grow">
                  <div className="section-title">按模型</div>
                  <table className="table">
                    <thead><tr><th>Provider</th><th className="num">回合</th><th className="num">输入</th><th className="num">输出</th></tr></thead>
                    <tbody>
                      {cost.byProvider.map((row, index) => (
                        <tr key={`${row.label}-${String(index)}`}>
                          <td><code title={row.label}>{row.label}</code></td>
                          <td className="num">{row.turns}</td>
                          <td className="num">{tokensText(row.inputTokens)}</td>
                          <td className="num">{tokensText(row.outputTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section className="card card-pad col gap-2 grow">
                  <div className="section-title">计价明细</div>
                  <table className="table">
                    <thead><tr><th>档位</th><th className="num">tokens</th><th className="num">单价/百万</th><th className="num">金额</th></tr></thead>
                    <tbody>
                      {cost.costComponents.map((component) => (
                        <tr key={component.label} title={component.rateFallback ? "命中价未单独配置，按输入价计（未打折）" : undefined}>
                          <td>{component.label}</td>
                          <td className="num">{tokensText(component.tokens)}</td>
                          <td className="num">{pricingConfigured ? `¥${component.ratePerMillionUsd}` : "未配置"}</td>
                          <td className="num">{usd(component.estimatedCostUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <span className="field-note" title="命中档标「未打折」= 只配了输入价，实际通常更低">金额 = 三档之和</span>
                </section>
              </div>
            </>
          ) : null}

          {readoutReady && cost.turns === 0 ? (
            <div className="empty"><span className="empty-icon"><Icon name="gauge" size={22} /></span>本月还没有开销记录</div>
          ) : null}
        </div>
      </section>
    </>
  );
}
