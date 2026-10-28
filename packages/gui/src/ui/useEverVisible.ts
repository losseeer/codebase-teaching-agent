import { useEffect, useState } from "react";

/** 面板是否至少打开过一次；请求只发一次，不随可见性反复触发。 */
export function useEverVisible(visible: boolean): boolean {
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);
  return everVisible;
}
