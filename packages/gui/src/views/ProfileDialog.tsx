import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api/client";
import { showToast, failureText } from "../ui/toast";

/**
  用户画像：跨仓库、用户手写的 markdown。写给 agent 的长期偏好与背景，
  与具体项目无关（项目内的学习状态在运行轨迹里）。
*/
export function ProfileDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** 与 agent 的沟通：一句话让它记住 / 改 / 删，不必自己动 markdown。 */
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    api.getProfile()
      .then((next) => {
        if (!alive) return;
        setText(next.profile);
        setPath(next.path);
      })
      .catch((reason: unknown) => { if (alive) setError(failureText("读取用户画像失败", reason)); });
    return () => { alive = false; };
  }, []);

  const converse = async (): Promise<void> => {
    const message = ask.trim();
    if (!message || asking) return;
    setAsking(true);
    setError("");
    setNote("");
    try {
      const next = await api.chatProfile(message);
      setText(next.profile);
      setNote(next.reply);
      setAsk("");
    } catch (reason) {
      setError(failureText("更新画像失败", reason));
    } finally {
      setAsking(false);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const next = await api.putProfile(text);
      setText(next.profile);
      showToast(text.trim() ? "用户画像已保存" : "用户画像已清空");
      onClose();
    } catch (reason) {
      setError(failureText("保存用户画像失败", reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="用户画像">
        <div className="modal-head">
          <h3>用户画像</h3>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}><span aria-hidden>×</span></button>
        </div>
        <div className="modal-body">
          <textarea
            className="text-input profile-editor"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"## 表达偏好\n严谨、具体、结构清晰的中文技术表达。\n\n## 关注方向\n后端工程、Agent 系统。"}
            spellCheck={false}
            aria-label="用户画像正文"
          />
          <div className="profile-ask">
            <input
              className="text-input"
              value={ask}
              placeholder="提问或更新，例如：以后回答短一点；把「偏好类比」删掉"
              spellCheck={false}
              aria-label="对画像说一句话"
              disabled={asking}
              onChange={(event) => setAsk(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void converse(); } }}
            />
            <button type="button" className="btn btn-primary" disabled={asking || !ask.trim()} onClick={() => void converse()}>{asking ? "更新中…" : "发送"}</button>
          </div>
          {note ? <p className="field-note">{note}</p> : null}
          {error ? <div className="banner banner-danger"><span className="banner-text">{error}</span></div> : null}
          <p className="field-note mono" title={path}>{path ? `存储于 ${path}` : "正在读取存储位置…"}</p>
        </div>
        <div className="modal-foot">
          <span className="modal-note">留空并保存 = 清空画像</span>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}
