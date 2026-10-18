import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

/**
  可调宽度的栏 + 对话栏收起状态。这两个都是**用户偏好**，不是产品数据：
  存 localStorage，读不到/读坏了就用默认值，存储被禁（隐私模式）时功能照常、只是下次进来不记得。
  读写全兜住——与 App 里 workspace / 侧栏折叠那两处同一口径（这里一旦抛在渲染路径上就是白屏）。

  宽度存的是**像素**而不是比例：比例在「窗口变窄 + 侧栏收起」两种情况下会算出完全不同的栏宽，
  而用户拖出来的那一条边界记住的应该是「我要这么宽」。
  */
export interface LayoutPrefs {
  /** Agent 对话栏（最右一栏）宽度 */
  railWidth: number;
  /** 对话栏是否收起（收起时这一栏**整条不渲染**，不是留一条窄边） */
  railCollapsed: boolean;
  /** 三个工作区共用的左侧列表栏宽度（教学的「仓库文件」、宏观的「项目目录」、练习的「练习模块」） */
  filePaneWidth: number;
}

export const LAYOUT_DEFAULTS: LayoutPrefs = { railWidth: 348, railCollapsed: false, filePaneWidth: 264 };

/** 下限取「内容还能不能用」：对话栏再窄气泡就换行成竖条，文件栏再窄路径全成省略号。 */
const RANGES = { railWidth: { min: 268, max: 620 }, filePaneWidth: { min: 168, max: 520 } } as const;
const LAYOUT_KEY = "codebase-tutor.layout";

/**
  窗口窄时**渲染**要再夹一遍：只按各自上限夹，1100px 的窗口上「文件栏 520 + 对话栏 620」
  能把中间的源码栏挤成一条缝。但这一层夹**不回写**偏好——否则「拖宽后临时缩窗口」会把用户
  原本要的宽度永久改掉，放大窗口也回不来了。
*/
const MAIN_FLOOR_PX = 420; // 对话栏变宽时，主区至少留这么多
const SOURCE_FLOOR_PX = 260; // 文件栏变宽时，源码栏至少留这么多
/** 主区左边固定要吃掉的宽度：展开态侧栏 232 + 工作区左右留白 32。对话栏夹算时必须扣掉它，
    否则侧栏展开 + 对话栏拖到上限时中间主区会被挤到 200px 以下（原型是固定侧栏，没这个问题）。 */
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
    return LAYOUT_DEFAULTS; // 存储不可用：本次会话照常工作，用默认宽度
  }
  if (!raw) return LAYOUT_DEFAULTS;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null; // 坏数据按「没存过」处理，下面照旧落一次干净值
  }
  const value = (parsed ?? {}) as Partial<LayoutPrefs>;
  return {
    railWidth: typeof value.railWidth === "number" ? rangeClamp("railWidth", value.railWidth) : LAYOUT_DEFAULTS.railWidth,
    filePaneWidth: typeof value.filePaneWidth === "number" ? rangeClamp("filePaneWidth", value.filePaneWidth) : LAYOUT_DEFAULTS.filePaneWidth,
    railCollapsed: value.railCollapsed === true
  };
}

/** 用户手上的值（落盘的那份），与当前视口下真正该渲染的宽度。 */
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

/** 改一份偏好并落盘。交进来的是「用户想要的值」，视口夹那一层由 recompute 负责。 */
export function patchLayout(patch: Partial<LayoutPrefs>): void {
  preference = {
    railWidth: typeof patch.railWidth === "number" ? rangeClamp("railWidth", patch.railWidth) : preference.railWidth,
    filePaneWidth: typeof patch.filePaneWidth === "number" ? rangeClamp("filePaneWidth", patch.filePaneWidth) : preference.filePaneWidth,
    railCollapsed: typeof patch.railCollapsed === "boolean" ? patch.railCollapsed : preference.railCollapsed
  };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(preference));
  } catch {
    /* 存不下只是下次进来不记得这次拖动 */
  }
  recompute();
}

// 窗口变窄时只重算渲染宽度（不动盘里那份）：放大回来，用户原本拖出来的宽度还在。
if (typeof window !== "undefined") {
  window.addEventListener("resize", recompute);
  recompute();
}

/**
  当前**生效**宽度。键盘连按（以及同一帧里到多次的事件）要拿它累加，
  不能拿组件闭包里那份 `width`——React 还没重渲染时那一份是旧的，四下方向键会合成一下。
  */
function widthOf(field: WidthField): number {
  return field === "railWidth" ? current.railWidth : current.filePaneWidth;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 当前视口下**该渲染成多宽**（不是用户存的那份，见上面两层夹的注释）。 */
export function useLayout(): LayoutPrefs {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** 给容器用的 CSS 变量表：栏宽只有 CSS 知道怎么落到 grid-template-columns 上。 */
export function layoutVars(layout: LayoutPrefs): CSSProperties {
  return { "--rail-w": `${layout.railWidth}px`, "--file-pane-w": `${layout.filePaneWidth}px` } as CSSProperties;
}

/**
  一条可拖的竖向分隔条。**绝对定位**压在某一栏的左边界上（所以它不占栅格列——否则每个媒体查询都得跟着改列数）。
  三种调法都给了：拖动、方向键（键盘可达，Shift 加速）、双击回到默认。
  */
export function ColumnResizer({ field, label, growOn }: { field: WidthField; label: string; growOn: "left" | "right" }): ReactElement {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });
  const sign = growOn === "right" ? 1 : -1;
  const width = useLayout()[field];

  /**
    一次拖拽的全部生命周期都在这一个 effect 里：进入时上全局光标态、离开时一定移除。
    ⚠️ 监听挂 `window` 而不是分隔条自己，也**不用 pointer capture**——
    拖出窗口、在浏览器边框外松手、中途切到别的 app 时，事件不会送回那个小条，
    于是「col-resize 光标 + 禁选中」会一直挂在 body 上（用户实测：指针明明不在分隔条上也是拖拽样式）。
    挂在 window 上，松手/取消/窗口失焦任一条都能收尾；组件被卸载时 cleanup 同样会摘干净。
    */
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
    // 不 preventDefault 会起手就选中一段文字，拖动过程一路跟着刷蓝
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
