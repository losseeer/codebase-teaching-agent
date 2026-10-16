import { useEffect, useState, type ReactElement } from "react";
import { api, type LlmProviderKind, type LlmSettings, type LlmSettingsPatch, type ThinkingEffort } from "../api/client";
import { showToast } from "../modules/toast";
import { Icon } from "../ui/icons";

/**
  模型入口与配置弹窗（对齐 docs/ui-prototype 的 `.rail-model-pill` + `.modal`）：对话栏底部只留**一颗胶囊**
  显示「当前用哪个模型 · 思考档」，点开弹窗做全部配置——模型、思考档位，以及装机时才改的服务商 / 接口地址 / API Key。

  两条不变项：
  - **胶囊必须自带状态**：本地兜底（没配齐服务商或密钥）时胶囊变警示态并直说原因，配置错了不该只有一个不起眼的齿轮；
  - **改完即生效**：每个字段失焦/换选就 PUT 引擎并落盘，弹窗里没有「保存」这个动作，只有「完成」（关闭）。
    所以关掉窗口不等于放弃修改——文案上也不给这个错觉。
 */
export function LlmSettingsControl({ variant = "pill", styleLabel }: { variant?: "pill" | "button"; styleLabel?: string }): ReactElement {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let current = true;
    api.getLlmSettings().then((next) => { if (current) setLlm(next); }).catch(() => undefined);
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
    // 密钥不做乐观更新：本地态里只存掩码，明文交给引擎响应（它返回的是掩码后的完整设置）
    setLlm({ ...llm, provider: partial.provider ?? llm.provider, model: partial.model ?? llm.model, baseUrl: partial.baseUrl ?? llm.baseUrl, thinking: partial.thinking ?? llm.thinking });
    api.updateLlmSettings(partial)
      .then(setLlm)
      .catch((error: unknown) => {
        setLlm(previous);
        // 引擎 422（如思考档位与新模型不兼容、接口地址不是 http(s)）会带具体原因，优先透传而不是笼统的「失败」
        showToast(error instanceof Error && error.message ? error.message : "LLM 设置更新失败");
      });
  };

  const status = activeSummary(llm);

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
          {styleLabel ? <span>风格 {styleLabel}</span> : null}
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
              <TextSetting
                label="模型"
                value={llm?.model ?? ""}
                placeholder={llm?.envFallback.model || ".env 未配置"}
                list="llm-model-presets"
                disabled={!llm}
                note="思考档位按模型能力声明生效：不支持的档位会报错，不会静默回落"
                onCommit={(model) => updateLlm({ model })}
              />
              <datalist id="llm-model-presets">
                {modelOptions(llm, llm?.model ?? "").map((slug) => <option key={slug} value={slug} />)}
              </datalist>
              <SelectSetting
                label="思考档位（主力任务）"
                value={llm?.thinking ?? "auto"}
                disabled={!llm}
                hint={THINKING_STYLE_HINT[llm?.thinkingCapability?.style ?? "unknown"]}
                ariaLabel="思考模式与强度"
                note="轻任务（推荐入口 / L1 摘要 / 题面润色）强制关闭思考，与这里的设置无关"
                onChange={(thinking) => updateLlm({ thinking: thinking as ThinkingEffort })}
                options={[
                  { value: "auto", label: "自动（模型默认）" },
                  ...(["off", "low", "high", "max"] as const).map((effort) => ({
                    value: effort,
                    label: THINKING_EFFORT_LABEL[effort],
                    // 引擎按模型查表下发能力声明；老引擎没有该字段时全部可用（向后兼容）。
                    // off 对 none/unknown 样式恒可选（= 不发字段），与引擎 PUT 校验的豁免一致。
                    disabled: llm?.thinkingCapability ? !effortSelectable(llm.thinkingCapability, effort) : false
                  }))
                ]}
              />
              {llm?.thinkingCapability ? <p className="field-note">{thinkingHint(llm.thinkingCapability)}</p> : null}
              {llm?.activeMode === "local" ? <div className="banner banner-danger"><Icon name="alert" /><span className="banner-text">{status.hint}</span></div> : null}

              <div className="section-title">连接（装机时改一次）</div>
              <SelectSetting
                label="服务商"
                value={llm?.provider ?? ""}
                disabled={!llm}
                ariaLabel="LLM 服务商协议"
                hint="协议决定请求格式与默认接口地址；选「默认」即沿用 .env 的 TUTOR_LLM_PROVIDER"
                note="协议决定请求格式与默认接口地址；选「默认」即沿用 .env"
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
              <SecretSetting
                saved={llm?.apiKeyMasked ?? ""}
                placeholder={llm?.envFallback.hasApiKey ? ".env 已配置" : "未配置"}
                disabled={!llm}
                note="密钥只存本机文件（0600），界面与日志只显示掩码"
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
                note="每百万个输入 token 的价格，填人民币。留空 = 这一档用 .env 的 TUTOR_INPUT_USD_PER_MILLION；两层都空则不计价。DeepSeek 峰时约 ¥2 / 百万。"
                onCommit={(inputUsdPerMillion) => updateLlm({ inputUsdPerMillion })}
              />
              <TextSetting
                label="命中"
                numeric
                value={llm?.cacheHitUsdPerMillion ?? ""}
                placeholder={ratePlaceholder(llm, "cacheHit")}
                disabled={!llm}
                note="缓存命中那部分输入的价格，通常约为输入价的 1/10（DeepSeek 峰时 ¥0.2 / 百万）。留空 = 按输入价计，宁可高估也不把真花掉的钱说少。"
                onCommit={(cacheHitUsdPerMillion) => updateLlm({ cacheHitUsdPerMillion })}
              />
              <TextSetting
                label="输出"
                numeric
                value={llm?.outputUsdPerMillion ?? ""}
                placeholder={ratePlaceholder(llm, "output")}
                disabled={!llm}
                note="每百万个输出 token 的价格，填人民币。留空 = 用 .env 的 TUTOR_OUTPUT_USD_PER_MILLION。DeepSeek 峰时约 ¥8 / 百万。"
                onCommit={(outputUsdPerMillion) => updateLlm({ outputUsdPerMillion })}
              />
              {llm?.pricing ? <p className={`field-note${pricingLive(llm) ? "" : " warn"}`}>{pricingReadout(llm)}</p> : null}
            </div>
            <div className="modal-foot">
              <span className="modal-note">改完即生效并保存到 <code>~/.codebase-tutor/llm-settings.json</code>；留空的项回落 <code>.env</code>。</span>
              <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 服务商候选：与引擎对齐的口径见 `LlmProviderKind`（api/client.ts）；「默认（沿用 .env）」的空选项由调用处拼。 */
const PROVIDER_CHOICES = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "openai", label: "OpenAI 官方" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama（本地）" }
] as const;

const THINKING_EFFORT_LABEL: Record<"off" | "low" | "high" | "max", string> = {
  off: "关闭",
  low: "低",
  high: "高",
  max: "最大"
};

/** 各思考能力样式的悬停提示（引擎按模型 slug 解析出的样式）。 */
const THINKING_STYLE_HINT: Record<string, string> = {
  deepseek: "DeepSeek 格式：thinking 开关 + reasoning_effort（V4 默认开启思考）",
  openai: "OpenAI 格式：顶层 reasoning_effort（GPT-5 / o 系 / Gemini 兼容层）",
  anthropic: "Anthropic 兼容层：仅 thinking 开关，无强度档位",
  none: "该模型没有思考参数",
  unknown: "未识别的模型：auto/off 不发字段；强度档位会被引擎拒绝（可用 TUTOR_THINKING_STYLES 声明）"
};

/** 单价一格的占位提示：留空时把 .env 的那个数摆出来，用户才知道「空着」意味着什么。 */
function ratePlaceholder(llm: LlmSettings | null, key: "input" | "output" | "cacheHit"): string {
  const fromEnv = llm?.pricingSources?.[key] === "env";
  const value = llm?.pricing ? money(key === "input" ? llm.pricing.inputPerMillionUsd : key === "output" ? llm.pricing.outputPerMillionUsd : llm.pricing.cacheHitPerMillionUsd) : "";
  return fromEnv ? `.env ${value}` : "未配置";
}

/** 三档里是不是至少有一档真的在计价（判据与引擎 `pricingIsConfigured` 同一口径：全空 ⇒ 钱恒为 0）。 */
function pricingLive(llm: LlmSettings): boolean {
  const p = llm.pricing;
  if (!p) return false;
  return p.inputPerMillionUsd > 0 || (p.cacheHitPerMillionUsd ?? 0) > 0 || p.outputPerMillionUsd > 0;
}

/**
  计价读数一行：现在按哪三个数算、每一档来自界面还是 .env。
  来源必须写出来——留空那格显示的是 .env 的数，不标来源就成了「我明明填了怎么没变」。
  更要紧的是后半句：三档全空时**预算闸门也不管事**（引擎拿到的金额恒为 0，永远判未超支）。
  */
function pricingReadout(llm: LlmSettings): string {
  const p = llm.pricing;
  if (!p) return "单价读数未返回";
  if (!pricingLive(llm)) return "三档都没配 ⇒ 金额恒 ¥0.0000，「超预算改走本地规则」这道闸没在管事";
  const source = (key: "input" | "output" | "cacheHit"): string => ({ runtime: "界面", env: ".env", unset: "未配" })[llm.pricingSources?.[key] ?? "unset"];
  return `按 输入 ${money(p.inputPerMillionUsd)}（${source("input")}）· 命中 ${money(p.cacheHitPerMillionUsd)}（${source("cacheHit")}）· 输出 ${money(p.outputPerMillionUsd)}（${source("output")}）计价`;
}

/** ¥2.000 这种写法；命中价没配时明说是「按输入价计」，不留一个空白让人以为算错了。 */
function money(value: number | undefined): string {
  return value === undefined ? "按输入价" : `¥${value.toFixed(3)}`;
}

/**
  胶囊与弹窗标题共用的生效状态。`pill` 是窄位用的短名（去掉 `openai:` 这类协议前缀），
  `text` 是弹窗里的完整一行，`title` 挂协议全名供悬停排查。
  */
function activeSummary(llm: LlmSettings | null): { pill: string; text: string; title: string; hint: string; thinking: string; local: boolean } {
  const thinking = llm?.thinking === "auto" || !llm?.thinking ? "自动" : THINKING_EFFORT_LABEL[llm.thinking];
  if (!llm) return { pill: "读取中…", text: "读取中…", title: "", hint: "", thinking, local: false };
  if (llm.activeMode === "local") {
    return { pill: "本地兜底", text: "本地兜底（未走 LLM）", title: llm.activeProvider ?? "", hint: "服务商或密钥没配齐，教学走本地启发式（不消耗 token）。", thinking, local: true };
  }
  const [protocol, ...model] = (llm.activeModel ?? "").split(":");
  const slug = model.join(":") || llm.activeModel || "";
  return { pill: slug, text: `${protocol} · ${slug}`, title: `${llm.activeProvider ?? ""} · ${llm.activeModel ?? ""}`, hint: "", thinking, local: false };
}

/** 模型输入框的候选（datalist）：.env 预设 + 当前已填的自定义 slug。 */
function modelOptions(settings: LlmSettings | null, current: string): string[] {
  const presets = settings?.presets ?? [];
  return current && !presets.includes(current) ? [...presets, current] : presets;
}

/** 思考能力提示行：白话说清这个模型能选哪些档，被置灰的 option 在部分浏览器不浮出说明。 */
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

/** off 恒可表达：无思考参数/未声明模型选 off = 不发字段（与引擎 applyThinking 语义一致，不算「支持」也不禁用）。 */
function effortSelectable(capability: NonNullable<LlmSettings["thinkingCapability"]>, effort: "off" | "low" | "high" | "max"): boolean {
  if (capability.efforts.includes(effort)) return true;
  return effort === "off" && (capability.style === "none" || capability.style === "unknown");
}

/** 文本型设置项（模型 slug / 接口地址 / 单价）：本地草稿 + 失焦或回车提交，不每敲一个字就打一次 PUT。 */
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
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
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

/**
  API Key 是**只写**项：引擎从不回显明文，所以「输入框为空」不能当成「清除」——那样点一下别处就把密钥抹掉了。
  留空提交 = 不改动；清除只走那颗 ✕ 按钮。
  */
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
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
        />
        {saved ? <button type="button" className="icon-btn" title="清除已存密钥，改用 .env 的" disabled={disabled} onClick={() => { setDraft(""); onClear(); }}><Icon name="trash" size={14} /></button> : null}
      </span>
      {note ? <span className="field-note">{note}</span> : null}
    </div>
  );
}
