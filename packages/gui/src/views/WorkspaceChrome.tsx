import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Icon } from "../ui/icons";
import { patchLayout, useLayout } from "../ui/ColumnResizer";

// 页面外框：PageTopbar 每页顶部一行，右侧放该页动作与对话栏开关。
// RailToggle 直接读写布局偏好，不逐层传 props。
// MobileSwitcher + useMobilePanes：窄屏时两栏折叠成一行 pane 切换。

export type WorkspaceId = "map" | "teaching" | "practice";

export function PageTopbar({ crumb, actions, showRailToggle }: { crumb: ReactNode; actions?: ReactNode; showRailToggle?: boolean }): ReactElement {
  return (
    <header className="topbar">
      <div className="crumb">{crumb}</div>
      <div className="spacer" />
      {actions}
      {showRailToggle ? <RailToggle /> : null}
    </header>
  );
}

/** 收起 / 展开右侧 Agent 对话栏。 */
export function RailToggle(): ReactElement {
  const layout = useLayout();
  return (
    <button
      type="button"
      className="icon-btn"
      title={layout.railCollapsed ? "展开对话栏" : "收起对话栏"}
      aria-label={layout.railCollapsed ? "展开对话栏" : "收起对话栏"}
      onClick={() => patchLayout({ railOpen: layout.railCollapsed })}
    ><Icon name="panelRight" /></button>
  );
}

export function MobileSwitcher({ labels, active, onSelect }: { labels: string[]; active: number; onSelect: (index: number) => void }): ReactElement {
  return (
    <div className="mobile-switcher" role="tablist" aria-label="面板切换">
      {labels.map((label, index) => (
        <button key={label} role="tab" aria-selected={index === active} className={index === active ? "active" : ""} onClick={() => onSelect(index)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** 移动端 pane 切换：返回 [activeIndex, classNameFor, setActive]；桌面端全部可见。 */
export function useMobilePanes(): [number, (index: number) => string, (index: number) => void] {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const reset = (): void => setActive(0);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);
  return [active, (index) => (index === active ? "ws-pane" : "ws-pane pane-hidden-mobile"), setActive];
}
