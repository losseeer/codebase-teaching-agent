import { useEffect, useState, type ReactElement } from "react";
import { api, type LlmProviderKind, type LlmSettings, type LlmSettingsPatch, type ThinkingEffort } from "../api/client";
import { toastFailure } from "../ui/toast";
import { Icon } from "../ui/icons";

/** 模型入口与配置弹窗：字段失焦即 PUT 生效，无「保存」动作。 */
export function LlmSettingsControl({ variant = "pill" }: { variant?: "pill" | "button" }): ReactElement {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [open, setOpen] = useState(false);
  /** 被引擎拒绝（422）的原因，就地显示在表单里。 */
  const [rejected, setRejected] = useState<string | null>(null);
  /** 区分「还没读回来」与「读不到」。 */
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let current = true;
    api.getLlmSettings()
      .then((next) => { if (current) setLlm(next); })
      .catch(() => { if (current) setLoadFailed(true); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const updateLlm = (partial: LlmSettingsPatch): void => {
    if (!llm) return;
    const previous = llm;
    // 密钥不做乐观更新：本地只存掩码，明文以引擎响应为准
    setLlm({ ...llm, provider: partial.provider ?? llm.provider, model: partial.model ?? llm.model, baseUrl: partial.baseUrl ?? llm.baseUrl, thinking: partial.thinking ?? llm.thinking });
    api.updateLlmSettings(partial)
      .then((next) => {
        setLlm(next);
        setRejected(null);
      })
      .catch((error: unknown) => {
        setLlm(previous);
        const reason = error instanceof Error ? error.message : "";
        // 拒因存进表单，弹窗只报状态
        setRejected(reason || "设置没保存");
        toastFailure("设置没保存", error);
      });
  };

  const status = activeSummary(llm, loadFailed);

  return (
    <>
      {variant === "pill" ? (
        <button
          type="button"
          className={`rail-model-pill${status.local ? " warn" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`${status.text} · 点击配置模型与连接`}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={status.local ? "alert" : "zap"} size={12} />
          <span className="pill-name">{status.pill}</span>
          <span>思考 {status.thinking}</span>
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`${status.text} · 点击配置模型与连接`}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={status.local ? "alert" : "settings"} size={14} />模型与计价
        </button>
      )}
      {open && (
        <div className="modal-mask" onClick={() => setOpen(false)}>
          <div className="modal wide" role="dialog" aria-label="模型与推理设置" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>模型与计价</h3>
              <span className="fs-11 faint" title={status.title}>{status.text}</span>
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setOpen(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              {rejected ? <p className="error-message" role="alert">{rejected}</p> : null}
              <TextSetting
                label="模型"
                value={llm?.model ?? ""}
                placeholder={llm?.envFallback.model || ".env 未配置"}
                disabled={!llm}
                onCommit={(model) => updateLlm({ model })}
              />
              <SelectSetting
                label="思考档位（主力任务）"
                value={llm?.thinking ?? "auto"}
                disabled={!llm}
                hint={THINKING_STYLE_HINT[llm?.thinkingCapability?.style ?? "unknown"]}
                ariaLabel="思考模式与强度"
                onChange={(thinking) => updateLlm({ thinking: thinking as ThinkingEffort })}
                options={[
                  { value: "auto", label: "自动（模型默认）" },
                  ...(["off", "low", "high", "max"] as const).map((effort) => ({
                    value: effort,
                    label: THINKING_EFFORT_LABEL[effort],
                    // 未下发能力声明时全部可选；off 恒可选（= 不发字段）
                    disabled: llm?.thinkingCapability ? !effortSelectable(llm.thinkingCapability, effort) : false
                  }))
                ]}
              />
              {llm?.thinkingCapability ? <p className="field-note">{thinkingHint(llm.thinkingCapability)}</p> : null}
              {llm?.activeMode === "local" ? <div className="banner banner-danger"><Icon name="alert" /><span className="banner-text">{status.hint}</span></div> : null}

              <div className="section-title">连接</div>
              <SelectSetting
                label="服务商"
                value={llm?.provider ?? ""}
                disabled={!llm}
                ariaLabel="LLM 服务商协议"
                hint="协议决定请求格式与默认地址；选「默认」即沿用 .env 的配置"
                onChange={(provider) => updateLlm({ provider: provider as LlmProviderKind | "" })}
                options={[
                  { value: "", label: `默认（${llm?.envFallback.provider || ".env 未配置"}）` },
                  ...PROVIDER_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))
                ]}
              />
              <TextSetting
                label="接口地址"
                value={llm?.baseUrl ?? ""}
                placeholder={llm?.envFallback.baseUrl || "协议默认"}
                disabled={!llm}
                onCommit={(baseUrl) => updateLlm({ baseUrl })}
              />
              <TextSetting
                label="超时"
                numeric
                value={llm?.timeoutMs ?? ""}
                placeholder={timeoutPlaceholder(llm)}
                disabled={!llm}
                note="单位毫秒"
                onCommit={(timeoutMs) => updateLlm({ timeoutMs })}
              />
              <SecretSetting
                saved={llm?.apiKeyMasked ?? ""}
                placeholder={llm?.envFallback.hasApiKey ? ".env 已配置" : "未配置"}
                disabled={!llm}
                onSave={(apiKey) => updateLlm({ apiKey })}
                onClear={() => updateLlm({ apiKey: "" })}
              />

              <div className="section-title">单价（人民币 / 百万 token）</div>
              <TextSetting
                label="输入"
                numeric
                value={llm?.inputUsdPerMillion ?? ""}
                placeholder={ratePlaceholder(llm, "input")}
                disabled={!llm}
                onCommit={(inputUsdPerMillion) => updateLlm({ inputUsdPerMillion })}
              />
              <TextSetting
                label="命中"
                numeric
                value={llm?.cacheHitUsdPerMillion ?? ""}
                placeholder={ratePlaceholder(llm, "cacheHit")}
                disabled={!llm}
                onCommit={(cacheHitUsdPerMillion) => updateLlm({ cacheHitUsdPerMillion })}
              />
              <TextSetting
                label="输出"
                numeric
                value={llm?.outputUsdPerMillion ?? ""}
                placeholder={ratePlaceholder(llm, "output")}
                disabled={!llm}
                onCommit={(outputUsdPerMillion) => updateLlm({ outputUsdPerMillion })}
              />
              {llm?.pricing ? <p className={`field-note${pricingLive(llm) ? "" : " warn"}`}>{pricingReadout(llm)}</p> : null}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 服务商候选；「默认」空选项由调用处拼。 */
const PROVIDER_CHOICES = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "openai", label: "OpenAI 官方" }
] as const;

const THINKING_EFFORT_LABEL: Record<"off" | "low" | "high" | "max", string> = {
  off: "关闭",
  low: "低",
  high: "高",
  max: "最大"
};

/** 各思考能力样式的悬停提示。 */
const THINKING_STYLE_HINT: Record<string, string> = {
  deepseek: "DeepSeek：思考开关 + 强度档（V4 默认开启思考）",
  openai: "OpenAI：强度档（GPT-5 / o 系 / Gemini 兼容层）",
  anthropic: "Anthropic 兼容层：仅 thinking 开关，无强度档位",
  none: "该模型没有思考参数",
  unknown: "这个模型没有已知的思考档位，只能选自动或关闭"
};

/** 超时占位：留空时说明用的是 .env 的哪一份（显示单位换成秒）。 */
function timeoutPlaceholder(llm: LlmSettings | null): string {
  const env = llm?.envFallback.timeoutMs;
  return env ? `默认 ${String(Math.round(env / 1000))} 秒` : "未配置";
}

/** 单价占位：留空时展示 .env 的值。 */
function ratePlaceholder(llm: LlmSettings | null, key: "input" | "output" | "cacheHit"): string {
  const fromEnv = llm?.pricingSources?.[key] === "env";
  const value = llm?.pricing ? money(key === "input" ? llm.pricing.inputPerMillionUsd : key === "output" ? llm.pricing.outputPerMillionUsd : llm.pricing.cacheHitPerMillionUsd) : "";
  return fromEnv ? `默认 ${value}` : "未配置";
}

/** 三档里是否至少一档在计价；口径与引擎 pricingIsConfigured 一致。 */
function pricingLive(llm: LlmSettings): boolean {
  const p = llm.pricing;
  if (!p) return false;
  return p.inputPerMillionUsd > 0 || (p.cacheHitPerMillionUsd ?? 0) > 0 || p.outputPerMillionUsd > 0;
}

/** 计价读数一行：三个数与各档来源。 */
function pricingReadout(llm: LlmSettings): string {
  const p = llm.pricing;
  if (!p) return "单价读数未返回";
  if (!pricingLive(llm)) return "三种单价都没填，金额恒为 ¥0.0000，额度上限不会触发";
  const source = (key: "input" | "output" | "cacheHit"): string => ({ runtime: "界面", env: ".env", unset: "未配" })[llm.pricingSources?.[key] ?? "unset"];
  return `按 输入 ${money(p.inputPerMillionUsd)}（${source("input")}）· 命中 ${money(p.cacheHitPerMillionUsd)}（${source("cacheHit")}）· 输出 ${money(p.outputPerMillionUsd)}（${source("output")}）计价`;
}

/** 金额格式化；undefined 显示「按输入价」。 */
function money(value: number | undefined): string {
  return value === undefined ? "按输入价" : `¥${value.toFixed(3)}`;
}

/** 胶囊与弹窗共用的生效状态；pill 为短名，title 带协议全名。 */
function activeSummary(llm: LlmSettings | null, loadFailed: boolean): { pill: string; text: string; title: string; hint: string; thinking: string; local: boolean } {
  const thinking = llm?.thinking === "auto" || !llm?.thinking ? "自动" : THINKING_EFFORT_LABEL[llm.thinking];
  if (!llm) {
    return loadFailed
      ? { pill: "读不到", text: "读不到模型设置（引擎没连上）", title: "", hint: "", thinking, local: true }
      : { pill: "读取中…", text: "读取中…", title: "", hint: "", thinking, local: false };
  }
  if (llm.activeMode === "local") {
    return { pill: "未配模型", text: "未配模型（不发请求）", title: llm.activeProvider ?? "", hint: "服务商或密钥没配齐：对话与 LLM 出题会被当场挡下，摘要与规则题走确定性档。", thinking, local: true };
  }
  const [protocol, ...model] = (llm.activeModel ?? "").split(":");
  const slug = model.join(":") || llm.activeModel || "";
  return { pill: slug, text: `${protocol} · ${slug}`, title: `${llm.activeProvider ?? ""} · ${llm.activeModel ?? ""}`, hint: "", thinking, local: false };
}

/** 说明该模型可选哪些思考档。 */
function thinkingHint(capability: NonNullable<LlmSettings["thinkingCapability"]>): string {
  const styleName: Record<string, string> = {
    deepseek: "DeepSeek 格式",
    openai: "reasoning_effort",
    anthropic: "仅开关（无强度）",
    none: "无思考参数",
    unknown: "未声明思考能力"
  };
  const supported = (["off", "low", "high", "max"] as const).filter((effort) => effortSelectable(capability, effort)).map((effort) => THINKING_EFFORT_LABEL[effort]);
  return `${capability.model} · ${styleName[capability.style] ?? capability.style} · 支持：${supported.length ? supported.join(" / ") : "无"}`;
}

/** off 恒可表达：无思考参数/未声明的模型选 off = 不发字段。 */
function effortSelectable(capability: NonNullable<LlmSettings["thinkingCapability"]>, effort: "off" | "low" | "high" | "max"): boolean {
  if (capability.efforts.includes(effort)) return true;
  return effort === "off" && (capability.style === "none" || capability.style === "unknown");
}

/** 文本设置项：本地草稿，失焦或回车提交。 */
function TextSetting({ label, value, placeholder, list, hint, note, numeric, disabled, onCommit }: { label: string; value: string; placeholder: string; list?: string; hint?: string; note?: string; numeric?: boolean; disabled: boolean; onCommit: (next: string) => void }): ReactElement {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = (): void => { const next = draft.trim(); if (next !== value) onCommit(next); };
  return (
    <label className="field" title={hint}>
      <span className="lbl">{label}</span>
      <input
        className="text-input"
        value={draft}
        placeholder={placeholder}
        list={list}
        disabled={disabled}
        inputMode={numeric ? "decimal" : undefined}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }}
      />
      {note ? <span className="field-note">{note}</span> : null}
    </label>
  );
}

function SelectSetting({ label, value, options, disabled, hint, note, ariaLabel, onChange }: { label: string; value: string; options: { value: string; label: string; disabled?: boolean }[]; disabled: boolean; hint: string; note?: string; ariaLabel: string; onChange: (next: string) => void }): ReactElement {
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      <select className="select" value={value} disabled={disabled} aria-label={ariaLabel} title={hint} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value || "∅"} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      {note ? <span className="field-note">{note}</span> : null}
    </label>
  );
}

/** API Key 只写项：引擎从不回显明文；留空提交 = 不改动，清除只走 ✕ 按钮。 */
function SecretSetting({ saved, placeholder, disabled, note, onSave, onClear }: { saved: string; placeholder: string; disabled: boolean; note?: string; onSave: (key: string) => void; onClear: () => void }): ReactElement {
  const [draft, setDraft] = useState("");
  const commit = (): void => { if (draft.trim()) onSave(draft.trim()); setDraft(""); };
  return (
    <div className="field">
      <label className="lbl" htmlFor="llm-api-key">API Key</label>
      <span className="field-inline">
        <input
          id="llm-api-key"
          className="text-input"
          type="password"
          value={draft}
          placeholder={saved ? `已保存 ${saved}` : placeholder}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-label="API Key"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }}
        />
        {saved ? <button type="button" className="icon-btn" title="清除已存密钥，改用 .env 的" disabled={disabled} onClick={() => { setDraft(""); onClear(); }}><Icon name="trash" size={14} /></button> : null}
      </span>
      {note ? <span className="field-note">{note}</span> : null}
    </div>
  );
}
