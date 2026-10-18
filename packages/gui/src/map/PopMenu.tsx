import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icons";

/**
  挂在按钮下方的小菜单（原型 `attachPop`）。三条约定：
  - **走 portal**：图库那一条是可滚的（`.gallery-list`），菜单装在栏里就会被 `overflow` 裁掉半截；
  - **翻边自己修**：贴到视口下沿就往上翻、贴到右沿就往里收，不然「删除」永远点在菜单框外面；
  - **点外面、Esc、滚动都关**：菜单是临时决定，留在屏上就是一层挡路的浮块。
*/
export interface MenuItem {
  label: ReactNode;
  /** 补充口径进 title（菜单正文只留一行短语，与全局文案口径一致）。 */
  title?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** 空列表 = 这格此刻没什么可给（例如版本还没取到）：不渲染菜单也不渲染遮罩，免得点一下就"没反应"。 */
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
    // 捕获阶段：菜单项自己也要靠这一下收起（onSelect 之后 React 重渲染，遮罩先消失）
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

/**
  「⋯」那颗菜单按钮：hover 才现身（原型 `.g-menu-btn`），但**键盘聚焦时必须现身**——
  只用 opacity 的话，用 Tab 走过去的人看到一个看不见的按钮被按下了。
*/
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

/**
  就地改名：点图名变输入框，Enter 提交、Esc 取消、离开焦点提交（与图库菜单同一个动作）。
  空标题一律不提交——把图改成没有名字，下次在图库里就再也认不出它。
*/
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
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        else if (event.key === "Escape") { event.preventDefault(); onClose(); }
      }}
      onBlur={commit}
    />
  );
}
