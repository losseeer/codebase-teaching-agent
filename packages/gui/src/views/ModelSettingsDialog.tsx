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

/** 推理设置：全局思考档位（模型名、超时已归各自的 LLM 配置）。草稿式——保存前确认，取消丢弃。 */
export function ModelSettingsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [thinking, setThinking] = useState<"auto" | ThinkingEffort>("auto");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.getLlmSettings()
      .then((next) => {
        if (!alive) return;
        setLlm(next);
        setThinking(next.thinking ?? "auto");
      })
      .catch((reason: unknown) => { if (alive) setError(failureText("读取模型设置失败", reason)); });
    return () => { alive = false; };
  }, []);

  const submit = async (): Promise<void> => {
    setConfirm(false);
    setBusy(true);
    setError("");
    try {
      const next = await api.updateLlmSettings({ thinking: thinking as ThinkingEffort });
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
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="推理设置">
        <div className="modal-head">
          <h3>推理设置</h3>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}><span aria-hidden>×</span></button>
        </div>
        <div className="modal-body">
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
            <div className="modal-head"><h3>应用推理设置？</h3></div>
            <div className="modal-body"><p className="field-note">思考档位会立即应用到后续所有请求。</p></div>
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
