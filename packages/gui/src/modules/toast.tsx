/**
  极简 toast 总线（prototype `.toast`）：模块配置 / 文件打开等操作的轻提示。
  - `showToast(msg)`：任意模块直接调用（无需 context / prop drilling）
  - `<ToastHost />`：挂在 App 根部，订阅并渲染
  对应 prototype `design-prototype.html` 的 toast() 实现（2.4s 自动消失）。
  */

import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

type Listener = (message: string) => void;

let listener: Listener | null = null;

export function showToast(message: string): void {
  listener?.(message);
}

export function subscribeToast(fn: Listener): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** 渲染 toast 的宿主组件：挂在 App 根部一次即可。淡出后再卸载，否则提示是「啪」地消失的。 */
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
      // 原型口径：2600ms 后开始 200ms 淡出，淡完再摘掉节点
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
