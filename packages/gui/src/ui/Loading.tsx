import type { ReactElement } from "react";

export function Loading(): ReactElement {
  return <div className="loading"><i className="spinner" aria-hidden />正在读取本地数据</div>;
}
