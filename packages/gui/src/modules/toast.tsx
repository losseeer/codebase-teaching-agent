/**
  轻量 toast 总线：模块配置 / 文件打开等操作的轻提示。
  - `showToast(msg)`：任意模块直接调用（无需 context / prop drilling）
  - `<ToastHost />`：挂在 App 根部，订阅并渲染
  */

import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

type Listener = (message: string) => void;

let listener: Listener | null = null;

export function showToast(message: string): void {
  listener?.(message);
}

/**
  操作失败的弹窗：只报状态、不解释原因；引擎带回的原因进 console。
  */
export function toastFailure(status: string, reason?: unknown): void {
  if (reason !== undefined) console.warn(`[gui] ${status}`, reason instanceof Error ? reason.message : String(reason));
  showToast(status);
}

export function subscribeToast(fn: Listener): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** 渲染 toast 的宿主组件：挂在 App 根部一次即可，淡出后再卸载节点。 */
export function ToastHost(): ReactElement | null {
  const [message, setMessage] = useState('');
  const [fading, setFading] = useState(false);
  useEffect(() => {
    let fadeTimer: number | undefined;
    let hideTimer: number | undefined;
    const unsubscribe = subscribeToast((next) => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(hideTimer);
      setFading(false);
      setMessage(next);
      // 2600ms 后开始 200ms 淡出，淡完再移除节点
      fadeTimer = window.setTimeout(() => setFading(true), 2600);
      hideTimer = window.setTimeout(() => setMessage(''), 2820);
    });
    return () => { unsubscribe(); window.clearTimeout(fadeTimer); window.clearTimeout(hideTimer); };
  }, []);
  if (!message) return null;
  return createPortal(
    <div className="toast-host"><div className="toast" style={fading ? { opacity: 0 } : undefined} role="status" aria-live="polite">{message}</div></div>,
    document.body,
  );
}
