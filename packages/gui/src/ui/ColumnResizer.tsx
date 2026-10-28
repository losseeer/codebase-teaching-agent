import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

/** 栏宽与对话栏收起的用户偏好，存 localStorage；宽度按像素存，不按比例。 */
export interface LayoutPrefs {
  /** Agent 对话栏（最右一栏）宽度 */
  railWidth: number;
  /** 对话栏是否收起（收起时整条不渲染） */
  railCollapsed: boolean;
  /** 三工作区共用的左侧列表栏宽度 */
  filePaneWidth: number;
}

export const LAYOUT_DEFAULTS: LayoutPrefs = { railWidth: 348, railCollapsed: false, filePaneWidth: 264 };

/** 上下限：再窄会换行成竖条。 */
const RANGES = { railWidth: { min: 268, max: 620 }, filePaneWidth: { min: 168, max: 520 } } as const;
const LAYOUT_KEY = "codebase-tutor.layout";

// 视口夹只作用于渲染，不回写偏好：临时窄窗口不该改掉用户存的宽度
const MAIN_FLOOR_PX = 420; // 对话栏变宽时主区最小宽度
const SOURCE_FLOOR_PX = 260; // 文件栏变宽时源码栏最小宽度
/** 主区左侧固定开销：侧栏 232 + 留白 32，对话栏夹算需扣除。 */
const FIXED_LEFT_PX = 232 + 32;

type WidthField = "railWidth" | "filePaneWidth";

function rangeClamp(field: WidthField, value: number): number {
  const range = RANGES[field];
  const fallback = LAYOUT_DEFAULTS[field];
  const numeric = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(numeric, range.min), range.max);
}

function viewportClamp(field: WidthField, value: number, source: LayoutPrefs): number {
  const range = RANGES[field];
  const viewport = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
  const floor = field === "railWidth" ? FIXED_LEFT_PX + MAIN_FLOOR_PX : FIXED_LEFT_PX + source.railWidth + SOURCE_FLOOR_PX;
  return Math.min(value, Math.max(range.min, Math.min(range.max, viewport - floor)));
}

function readLayout(): LayoutPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LAYOUT_KEY);
  } catch {
    return LAYOUT_DEFAULTS; // 存储不可用：用默认宽度
  }
  if (!raw) return LAYOUT_DEFAULTS;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null; // 坏数据按「没存过」处理
  }
  const value = (parsed ?? {}) as Partial<LayoutPrefs>;
  return {
    railWidth: typeof value.railWidth === "number" ? rangeClamp("railWidth", value.railWidth) : LAYOUT_DEFAULTS.railWidth,
    filePaneWidth: typeof value.filePaneWidth === "number" ? rangeClamp("filePaneWidth", value.filePaneWidth) : LAYOUT_DEFAULTS.filePaneWidth,
    railCollapsed: value.railCollapsed === true
  };
}

/** 用户存的偏好 与 当前视口下该渲染的宽度。 */
let preference: LayoutPrefs = readLayout();
let current: LayoutPrefs = { ...preference };

function recompute(): void {
  const next: LayoutPrefs = {
    railWidth: viewportClamp("railWidth", preference.railWidth, preference),
    filePaneWidth: viewportClamp("filePaneWidth", preference.filePaneWidth, preference),
    railCollapsed: preference.railCollapsed
  };
  if (next.railWidth === current.railWidth && next.filePaneWidth === current.filePaneWidth && next.railCollapsed === current.railCollapsed) return;
  current = next;
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

/** 改一份偏好并落盘；视口夹由 recompute 负责。 */
export function patchLayout(patch: Partial<LayoutPrefs>): void {
  preference = {
    railWidth: typeof patch.railWidth === "number" ? rangeClamp("railWidth", patch.railWidth) : preference.railWidth,
    filePaneWidth: typeof patch.filePaneWidth === "number" ? rangeClamp("filePaneWidth", patch.filePaneWidth) : preference.filePaneWidth,
    railCollapsed: typeof patch.railCollapsed === "boolean" ? patch.railCollapsed : preference.railCollapsed
  };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(preference));
  } catch {
    /* 存下失败只是下次不记得 */
  }
  recompute();
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", recompute);
  recompute();
}

/** 当前生效宽度；重渲染前闭包里的 width 是旧值，累加要用它。 */
function widthOf(field: WidthField): number {
  return field === "railWidth" ? current.railWidth : current.filePaneWidth;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 当前视口下的渲染宽度（视口夹之后的值，不是存盘值）。 */
export function useLayout(): LayoutPrefs {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function layoutVars(layout: LayoutPrefs): CSSProperties {
  return { "--rail-w": `${layout.railWidth}px`, "--file-pane-w": `${layout.filePaneWidth}px` } as CSSProperties;
}

/** 可拖竖向分隔条，绝对定位压在栏的左边界；支持拖动、方向键（Shift 加速）、双击回默认。 */
export function ColumnResizer({ field, label, growOn }: { field: WidthField; label: string; growOn: "left" | "right" }): ReactElement {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });
  const sign = growOn === "right" ? 1 : -1;
  const width = useLayout()[field];

  // 监听挂 window 而非分隔条：拖出窗口或在别处松手也能结束拖拽、清掉光标态
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent): void => {
      patchLayout({ [field]: start.current.width + sign * (event.clientX - start.current.x) } as Partial<LayoutPrefs>);
    };
    const end = (): void => { setDragging(false); };
    document.body.classList.add("col-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      document.body.classList.remove("col-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [dragging, field, sign]);

  const set = (next: number): void => { patchLayout({ [field]: next } as Partial<LayoutPrefs>); };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // preventDefault：否则起手选中文字
    event.preventDefault();
    start.current = { x: event.clientX, width };
    setDragging(true);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = (event.shiftKey ? 48 : 12) * sign;
    if (event.key === "ArrowLeft") { event.preventDefault(); set(widthOf(field) - step); }
    else if (event.key === "ArrowRight") { event.preventDefault(); set(widthOf(field) + step); }
    else if (event.key === "Home") { event.preventDefault(); set(LAYOUT_DEFAULTS[field]); }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label}宽度：拖动调节，或用左右方向键（按住 Shift 加速），双击回到默认`}
      aria-valuenow={width}
      aria-valuemin={RANGES[field].min}
      aria-valuemax={RANGES[field].max}
      tabIndex={0}
      className={`col-resizer${dragging ? " dragging" : ""}`}
      title={`${label} · ${width}px（拖动改宽，双击回默认）`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => set(LAYOUT_DEFAULTS[field])}
    />
  );
}
