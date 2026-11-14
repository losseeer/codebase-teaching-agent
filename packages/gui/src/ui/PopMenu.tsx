import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icons";

/** 按钮下方的小菜单：portal 渲染防裁剪，贴边翻转，点外/Esc/滚动即关。 */
export interface MenuItem {
  label: ReactNode;
  /** 列表 key。不给就用下标——label 是节点时不能拿它当 key（会全是同一个字符串）。 */
  key?: string;
  /** 补充说明放 title。 */
  title?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** 空列表时菜单与遮罩都不渲染。 */
export function PopMenu({ anchor, items, onClose, ariaLabel }: {
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  ariaLabel: string;
}): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    // 菜单内部的滚动不该把菜单关了：面板自己滚一下就被关掉，滚动条等于不能用。
    const onScroll = (event: Event): void => {
      if (panel.current?.contains(event.target as Node)) return;
      onClose();
    };
    // 捕获阶段：点菜单项自身也收起
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  // hook 必须在提前返回之前：anchor 从 null 变有值时不能改变 hook 数量
  // 面板高度上限与 CSS 的 max-height 对齐，贴边时按它算，免得底部被裁。
  const maxHeight = Math.max(180, Math.min(Math.round(window.innerHeight * 0.6), 420));
  // 先渲染再量尺寸：侧栏底部的头像下方放不下时必须翻到上方，用上限估算会把菜单顶到屏幕中间
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !items.length) { setPos(null); return; }
    const rect = anchor.getBoundingClientRect();
    const width = panel.current?.offsetWidth ?? 180;
    const height = panel.current?.offsetHeight ?? Math.min(44 * items.length + 8, maxHeight);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 6);
    setPos({ left, top });
  }, [anchor, items.length, maxHeight]);
  if (!anchor || !items.length) return null;
  const style = {
    position: "fixed" as const,
    ...(pos ?? { left: 8, top: 8, visibility: "hidden" as const }),
    minWidth: 168,
    maxHeight,
    zIndex: 70
  };
  return createPortal(
    <div className="pop" role="menu" aria-label={ariaLabel} ref={panel} style={style}>
      {items.map((item, index) => (
        <button
          key={item.key ?? index}
          type="button"
          role="menuitem"
          className="pop-item"
          title={item.title}
          disabled={item.disabled}
          style={item.danger ? { color: "var(--danger)" } : undefined}
          onClick={() => { onClose(); item.onSelect(); }}
        >{item.label}</button>
      ))}
    </div>,
    document.body
  );
}

/** 「⋯」菜单按钮：hover 现身，键盘聚焦时必须现身。 */
export function MenuButton({ label, open, onToggle, className }: {
  label: string;
  open: boolean;
  onToggle: (element: HTMLElement) => void;
  className?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={`icon-btn menu-btn${className ? ` ${className}` : ""}${open ? " open" : ""}`}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(event) => { event.stopPropagation(); onToggle(event.currentTarget); }}
    ><Icon name="more" size={14} /></button>
  );
}

/** 就地改名：Enter/失焦提交，Esc 取消，空标题不提交。 */
export function InlineName({ value, placeholder, ariaLabel, onCommit, onClose }: {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  onCommit: (name: string) => void;
  onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.select(); }, []);
  const commit = (): void => {
    const name = draft.trim();
    if (name && name !== value) onCommit(name);
    onClose();
  };
  return (
    <input
      ref={field}
      className="text-input inline-name"
      style={{ width: 176, padding: "3px 8px", fontSize: "var(--fs-13)" }}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); }
        else if (event.key === "Escape") { event.preventDefault(); onClose(); }
      }}
      onBlur={commit}
    />
  );
}
