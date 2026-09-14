import { useState, type ReactElement, type ReactNode } from "react";
import { useEffect } from "react";

/**
  三工作区共享的外框（prototype `.workspace-tabs` + `.context-line` + `.mobile-switcher`）：
  - `WorkspaceTabs`：代码地图 / 教学会话 / 练习复习 三个真 tab —— v0.4 起由 Workbench 挂载，
    切换只改 `?workspace=` URL 参数，不再走路由（对齐 prototype `activate(view)`）
  - `ContextLine`：当前工作区的上下文行（如「代码教学 · src/router.ts:3 · 模块『计算机网络』」）
  - `MobileSwitcher` + `useMobilePanes`：<=960px 时显示 pane 切换按钮，非激活 pane 隐藏

  对应 prototype `design-prototype.html` L51-67（tabs）、L298-343（context）、L180-202（mobile switcher）。
  */

export type WorkspaceId = "map" | "teaching" | "practice";

const TABS: { id: WorkspaceId; label: string }[] = [
  { id: "map", label: "代码地图" },
  { id: "teaching", label: "教学会话" },
  { id: "practice", label: "练习复习" },
];

export function WorkspaceTabs({ active, onChange }: { active: WorkspaceId; onChange: (id: WorkspaceId) => void }): ReactElement {
  return (
    <div className="workspace-tabs" role="tablist" aria-label="工作区切换">
      {TABS.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={active === tab.id} className={active === tab.id ? "active" : ""} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** 上下文行（prototype `.context-line`）：左侧当前绑定，右侧 `.context-actions` 放该工作区的真实动作。 */
export function ContextLine({ strong, detail, actions }: { strong: string; detail: string; actions?: ReactNode }): ReactElement {
  return (
    <div className="context-line">
      <span><strong>{strong}</strong> · {detail}</span>
      {actions ? <div className="context-actions">{actions}</div> : null}
    </div>
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
  桌面端（>960px）所有 pane 可见；`pane-hidden-mobile` 仅在移动端媒体查询里生效。
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
