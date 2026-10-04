import { useEffect, useState } from "react";

/**
  「这个面板至少被打开过一次了吗」的一次性闸门。
  三个视图常驻挂载（切 tab 不丢状态），所以「隐藏时别发请求」不能直接写成 `visible` 进依赖：
  那样每次切回来 `visible` 都变一次 false→true，最贵的流程生成会**跟着重发一次**，
  还把已有结果清空、闪一帧骨架——省 token 的目的没达到，先赔了体验。
  这里要的是单向门：没看过就一次都不发，看过一次之后就按原来的依赖走。
  */
export function useEverVisible(visible: boolean): boolean {
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);
  return everVisible;
}
