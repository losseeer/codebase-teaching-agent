/**
  弹层栈：Escape 只交给最后打开的那层，父层不会被嵌套弹窗的 Esc 连带关掉。
  行内输入框先在 React 事件里处理 Esc（preventDefault/stopPropagation），到这里就收不到。
*/
import { useEffect, useRef } from "react";

interface Layer {
  close: () => void;
}

const stack: Layer[] = [];
let listening = false;

/** 入栈，返回出栈函数；顺序即打开顺序。 */
export function pushLayer(close: () => void): () => void {
  const layer: Layer = { close };
  stack.push(layer);
  return () => {
    const index = stack.indexOf(layer);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** 关掉栈顶那层（先出栈再关，连按不会重复关同一层）；栈空返回 false。 */
export function closeTopLayer(): boolean {
  const layer = stack.pop();
  if (!layer) return false;
  layer.close();
  return true;
}

/** 测试用：清空栈，避免用例互相污染。 */
export function resetLayers(): void {
  stack.length = 0;
}

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    closeTopLayer();
  });
}

/** 挂载期间把 `onClose` 压入弹层栈；`enabled` 为假时不占位。 */
export function useModalLayer(onClose: () => void, enabled = true): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    return pushLayer(() => closeRef.current());
  }, [enabled]);
}
