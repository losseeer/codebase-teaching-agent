/**
  引擎访问口令（API key）在前端的存放与广播。

  背景见开发日志 §44：引擎可以配一张 key 文件把 `/api/*` 全部关起来（企业/共享机形态），
  而**开闸后 GUI 原来的请求一个凭据都不带**，等于整套界面直接瘫掉。这一模块就是那条缺口的另一半。

  三条口径写在这里，别改：
  - **存 `localStorage`，不是内存**：口令是「这台浏览器怎么访问本机引擎」的配置，刷新与重开都要在，
    和 GUI 其它偏好同类。⚠️ 它因此对同源的任何脚本可读——**这是明说的取舍，不是安全存储**；
    真正的边界在引擎侧那份 key 文件（0600）与按仓授权。要更强的隔离就别把 GUI 部署到能跑别人脚本的地方。
  - **一次 401 就把状态亮出来**（`unauthorized`）：不弹模态、不循环重试，
    侧栏那条状态行改成「引擎需要访问口令」并给输入框——用户可能就只是想换个仓看，不该被打断。
  - **改口令 = 清掉 401 标记**：让界面自己重新走一遍，而不是留一条「红着但已经修好了」的状态。
  */

const STORAGE_KEY = "codebase-tutor.engine-key";

interface EngineAuthState {
  /** null = 没配口令（本机默认形态，也是闸门未开时的正常状态） */
  key: string | null;
  /** 最近一次请求被 401 拒过：侧栏据此把状态行换成输入框 */
  unauthorized: boolean;
}

function readStored(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const trimmed = stored?.trim();
    return trimmed ? trimmed : null;
  } catch {
    // 隐私模式下 localStorage 会抛：读不到就当没配，界面照常渲染（裸读会让整页白屏，见 §37.9）
    return null;
  }
}

let state: EngineAuthState = { key: readStored(), unauthorized: false };
const listeners = new Set<() => void>();

function publish(next: EngineAuthState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` 的订阅端（快照是同一个对象引用，只在变化时替换）。 */
export function subscribeEngineAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEngineAuth(): EngineAuthState {
  return state;
}

export function setEngineKey(value: string): void {
  let persisted = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    persisted = false;
  }
  // 存不进去也要让本次会话能用（否则用户输完还是 401，且不知道原因）
  publish({ key: value.trim() || null, unauthorized: false });
  if (!persisted && value.trim()) console.warn("[engine-key] 口令未能持久化（localStorage 不可用），本次会话结束后需要重填");
}

export function clearEngineKey(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 存不进也就删不掉，忽略 */
  }
  publish({ key: null, unauthorized: false });
}

/** 请求侧唯一的拼接头：没配口令时返回空对象，一条多余的头都不加。 */
export function engineKeyHeaders(): Record<string, string> {
  return state.key ? { "x-api-key": state.key } : {};
}

/** 401 的上报口（client.ts / journal transport 都用它，不在各处各写一份状态）。 */
export function reportUnauthorized(): void {
  if (!state.unauthorized) publish({ ...state, unauthorized: true });
}
