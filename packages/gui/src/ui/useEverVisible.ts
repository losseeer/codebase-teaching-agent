import { useEffect, useState } from "react";

/**
  单向闸门：面板是否至少被打开过一次。
  视图常驻挂载（切 tab 不丢状态），可见性不能直接进依赖数组——每次切回都会重发请求并清空已有结果。
  */
export function useEverVisible(visible: boolean): boolean {
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);
  return everVisible;
}
