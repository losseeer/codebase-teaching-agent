import { useEffect, useState, type ReactElement } from "react";

import { api, type McpConfigView } from "../api/client";
import { failureText, showToast, toastFailure } from "../ui/toast";
import { useModalLayer } from "../ui/modalLayer";

const TEMPLATE = `{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"]
    }
  }
}
`;

/** MCP 服务配置：直接编辑配置文件；保存前由引擎校验结构，保存后重置外部工具连接。 */
export function McpSettingsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [config, setConfig] = useState<McpConfigView | null>(null);
  const [text, setText] = useState(TEMPLATE);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useModalLayer(onClose);

  useEffect(() => {
    let alive = true;
    api.getMcpConfig()
      .then((next) => {
        if (!alive) return;
        setConfig(next);
        setText(next.text.trim() ? next.text : TEMPLATE);
      })
      .catch((reason: unknown) => { if (alive) setError(failureText("读取 MCP 配置失败", reason)); });
    return () => { alive = false; };
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const next = await api.putMcpConfig(text);
      setConfig(next);
      setText(next.text);
      showToast(`已保存：${String(next.servers.length)} 个本地 server`);
    } catch (reason) {
      setError(failureText("保存 MCP 配置失败", reason));
      toastFailure("保存失败", reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="MCP 服务">
        <div className="modal-head">
          <h3>MCP 服务</h3>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}><span aria-hidden>×</span></button>
        </div>
        <div className="modal-body">
          <p className="field-note">
            只接本地 <code>command</code>；远程 <code>url</code> 尚未支持。<code>env</code> 会明文写进配置文件，权限 0600。
          </p>
          <textarea
            className="text-input profile-editor"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            aria-label="MCP 配置 JSON"
          />
          {config ? (
            <div className="col gap-2">
              <p className="field-note mono" title={config.path}>存储于 {config.path}</p>
              <p className="field-note">
                已识别 {String(config.servers.length)} 个：{config.servers.map((item) => item.name).join("、") || "无"}
              </p>
              {config.skipped.length ? (
                <p className="field-note warn">
                  未接入：{config.skipped.map((item) => `${item.server}（${item.reason}）`).join("；")}
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="banner banner-danger"><span className="banner-text">{error}</span></div> : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "校验并保存"}</button>
        </div>
      </div>
    </div>
  );
}
