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

/** 渲染 toast 的宿主组件：挂在 App 根部一次即可。 */
export function ToastHost(): ReactElement | null {
  const [message, setMessage] = useState('');
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = subscribeToast((next) => {
      setMessage(next);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(''), 2400);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, []);
  if (!message) return null;
  return createPortal(
    <div className="toast" role="status" aria-live="polite">{message}</div>,
    document.body,
  );
}
