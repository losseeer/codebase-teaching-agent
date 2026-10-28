/** 轻量 toast：showToast 任意模块可调；ToastHost 挂在 App 根部订阅渲染。 */

import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

type Listener = (message: string) => void;

let listener: Listener | null = null;

export function showToast(message: string): void {
  listener?.(message);
}

/** 操作失败只报状态；原因进 console。 */
export function toastFailure(status: string, reason?: unknown): void {
  if (reason !== undefined) console.warn(`[gui] ${status}`, reason instanceof Error ? reason.message : String(reason));
  showToast(status);
}

export function subscribeToast(fn: Listener): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** 渲染 toast 的宿主组件，挂在 App 根部。 */
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
