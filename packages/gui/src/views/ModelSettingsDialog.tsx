import { useEffect, useState, type ReactElement } from "react";

import { api, type LlmSettings, type ThinkingEffort } from "../api/client";
import { failureText, showToast, toastFailure } from "../ui/toast";

const EFFORTS: { value: "auto" | ThinkingEffort; label: string }[] = [
  { value: "auto", label: "自动（模型默认）" },
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "high", label: "高" },
  { value: "max", label: "最大" }
];

/** 通用模型设置：模型、思考档位、超时。草稿式——保存前确认，取消丢弃。 */
export function ModelSettingsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState<"auto" | ThinkingEffort>("auto");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.getLlmSettings()
      .then((next) => {
        if (!alive) return;
        setLlm(next);
        setModel(next.model ?? "");
        setThinking(next.thinking ?? "auto");
        setTimeoutMs(next.timeoutMs ? String(next.timeoutMs) : "");
      })
      .catch((reason: unknown) => { if (alive) setError(failureText("读取模型设置失败", reason)); });
    return () => { alive = false; };
  }, []);

  const submit = async (): Promise<void> => {
    setConfirm(false);
    setBusy(true);
    setError("");
    try {
      const next = await api.updateLlmSettings({
        model,
        thinking: thinking as ThinkingEffort,
        timeoutMs
      });
      setLlm(next);
      showToast("模型设置已保存");
      onClose();
    } catch (reason) {
      setError(failureText("保存模型设置失败", reason));
      toastFailure("保存失败", reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="模型设置">
        <div className="modal-head">
          <h3>模型设置</h3>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}><span aria-hidden>×</span></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="model-name">模型</label>
            <input
              id="model-name"
              className="text-input"
              value={model}
              placeholder={llm?.envFallback.model || ".env 未配置"}
              disabled={!llm}
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="model-thinking">思考档位（主力任务）</label>
            <select
              id="model-thinking"
              className="select"
              value={thinking}
              disabled={!llm}
              onChange={(event) => setThinking(event.target.value as "auto" | ThinkingEffort)}
            >
              {EFFORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="model-timeout">超时</label>
            <input
              id="model-timeout"
              className="text-input"
              inputMode="numeric"
              value={timeoutMs}
              placeholder={llm?.envFallback.timeoutMs ? `默认 ${String(Math.round(llm.envFallback.timeoutMs / 1000))} 秒` : "未配置"}
              disabled={!llm}
              onChange={(event) => setTimeoutMs(event.target.value.replace(/[^\d]/g, ""))}
            />
            <p className="field-note">单位毫秒</p>
          </div>
          {error ? <div className="banner banner-danger"><span className="banner-text">{error}</span></div> : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy || !llm} onClick={() => setConfirm(true)}>{busy ? "保存中…" : "保存"}</button>
        </div>
      </div>
      {confirm ? (
        <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirm(false); }}>
          <div className="modal" role="alertdialog" aria-label="确认保存模型设置">
            <div className="modal-head"><h3>应用模型设置？</h3></div>
            <div className="modal-body"><p className="field-note">模型、思考档位与超时会立即应用到后续所有请求。</p></div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>取消</button>
              <button type="button" className="btn btn-primary" onClick={() => void submit()}>确认保存</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
