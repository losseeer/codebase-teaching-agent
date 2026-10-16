import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Icon } from "../ui/icons";
import { patchLayout, useLayout } from "../ui/ColumnResizer";

/**
  页面外框（对齐原型 `pages.js` 的 `topbar()` + `.mobile-switcher`）：
  - `PageTopbar`：每页顶部一行——左侧当前上下文（面包屑），右侧该页动作 + 对话栏开关
  - `RailToggle`：直接读写布局偏好（模块级 store），所以不需要从 App 逐层传 props
  - `MobileSwitcher` + `useMobilePanes`：窄屏（<=720px）时两栏折叠成一行 pane 切换

  三个工作区的切换由侧栏导航承担（原型形态），页内不再有 tab 条。
 */

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

/** 收起 / 展开右侧 Agent 对话栏（原型 topbar 上那枚 panelRight）。 */
export function RailToggle(): ReactElement {
  const layout = useLayout();
  return (
    <button
      type="button"
      className="icon-btn"
      title={layout.railCollapsed ? "展开对话栏" : "收起对话栏"}
      aria-label={layout.railCollapsed ? "展开对话栏" : "收起对话栏"}
      onClick={() => patchLayout({ railCollapsed: !layout.railCollapsed })}
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

/**
  移动端 pane 切换：返回 `[activeIndex, classNameFor]`。
  桌面端（>720px）所有 pane 可见；`pane-hidden-mobile` 仅在移动端媒体查询里生效。
 */
export function useMobilePanes(): [number, (index: number) => string, (index: number) => void] {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const reset = (): void => setActive(0);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);
  return [active, (index) => (index === active ? "ws-pane" : "ws-pane pane-hidden-mobile"), setActive];
}
