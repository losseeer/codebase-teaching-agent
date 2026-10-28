import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icons";

/** 按钮下方的小菜单：portal 渲染防裁剪，贴边翻转，点外/Esc/滚动即关。 */
export interface MenuItem {
  label: ReactNode;
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
    // 捕获阶段：点菜单项自身也收起
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchor, onClose]);

  if (!anchor || !items.length) return null;
  const rect = anchor.getBoundingClientRect();
  const style = {
    position: "fixed" as const,
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 252)),
    top: Math.min(rect.bottom + 6, window.innerHeight - 224),
    minWidth: 168,
    zIndex: 70
  };
  return createPortal(
    <div className="pop" role="menu" aria-label={ariaLabel} ref={panel} style={style}>
      {items.map((item) => (
        <button
          key={String(item.label)}
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
