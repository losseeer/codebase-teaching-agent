import { useEffect, useRef, useState, type ReactElement } from "react";
import { Icon } from "./icons";

/**
  共用的「下拉选择器」：触发器一行写完区名 + 当前选中项 + 数量，展开后是定高可滚的选项面板。
  用在模块分级与流程视图的入口选择上——列表长到不能平铺，但都不需要搜索。

  开合状态由调用方持有（`open` / `onOpenChange`）：同级有多个下拉时要「同时只开一个」，组件自己管 state 就协调不了。
  */
export interface DropdownOption {
  value: string;
  /** 主文案：模块名或入口名 */
  label: string;
  /** 次行小字：选中前不必看清、选中后要能核对的信息（如文件路径） */
  detail?: string;
  /** 触发器与选项右侧的计数徽章 */
  count?: number;
  /** 悬停说明 */
  note?: string;
}

export function OptionDropdown({ label, options, value, placeholder, tone, open, onOpenChange, onSelect, ariaLabel }: {
  label: string;
  options: DropdownOption[];
  value: string;
  placeholder: string;
  /** 色点档位（CSS 修饰符 `tone-*`）；不传就没有色点 */
  tone?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
  ariaLabel?: string;
}): ReactElement {
  const wrap = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const selected = options.find((item) => item.value === value);
  const index = Math.min(Math.max(cursor, 0), Math.max(options.length - 1, 0));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrap.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, onOpenChange]);

  const atSelected = (): number => Math.max(options.findIndex((item) => item.value === value), 0);
  const pick = (next: string): void => {
    onSelect(next);
    onOpenChange(false);
  };

  return (
    <div className={`picker${tone ? ` tone-${tone}` : ""}${open ? " picker-open" : ""}`} ref={wrap}>
      <button
        type="button"
        className={`picker-trigger${selected ? " has-active" : ""}`}
        title={selected ? `${label}：${selected.detail ?? selected.label}` : `${label}：${placeholder}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel ?? label}
        onClick={() => { setCursor(atSelected()); onOpenChange(!open); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { onOpenChange(false); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) { setCursor(atSelected()); onOpenChange(true); return; }
            setCursor((current) => (event.key === "ArrowDown" ? Math.min(current + 1, options.length - 1) : Math.max(current - 1, 0)));
            return;
          }
          if (event.key === "Enter" && open) { event.preventDefault(); const item = options[index]; if (item) pick(item.value); }
        }}
      >
        {tone ? <i className="picker-dot" aria-hidden /> : null}
        <span className="picker-label">{label}</span>
        <span className="picker-current">{selected?.label ?? placeholder}</span>
        <b>{options.length}</b>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="picker-panel" role="listbox" aria-label={ariaLabel ?? label}>
          {options.length ? options.map((item, position) => (
            <button
              type="button"
              key={item.value}
              role="option"
              aria-selected={item.value === value}
              className={`picker-option ${item.value === value ? "active" : ""} ${position === index ? "cursor" : ""}`}
              title={item.note ?? item.detail ?? item.label}
              onClick={() => pick(item.value)}
              onMouseEnter={() => setCursor(position)}
            >
              <span>{item.label}</span>
              {item.detail ? <small>{item.detail}</small> : null}
              {item.count !== undefined ? <b>{item.count}</b> : null}
            </button>
          )) : <span className="picker-empty">没有可选项</span>}
        </div>
      )}
    </div>
  );
}
