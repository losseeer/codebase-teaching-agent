import { useEffect, useRef, useState } from "react";

/**
  打字机节奏器：SSE 的 delta 会在一帧内全部 flush，直写 liveAnswer 观感仍是整段落下。
  delta 先进队列，由定时器按自适应步长吐字（队列越长步长越大，任意长度约 2s 追平）；
  done 后等队列排空再固化正式消息。
  */
export interface Typewriter {
  liveAnswer: string;
  /** 开一轮：清空队列与已显示文本并确保吐字表在跑（发送前调用）。 */
  begin: () => void;
  /** 追加一段 delta 到队列（SSE delta 回调里调用）。 */
  enqueue: (text: string) => void;
  /** 等队列排空（回合结束、把 liveAnswer 固化成正式消息之前调用）。 */
  finish: () => Promise<void>;
  /** 只清已显示文本（固化之后 / 切节点时），不动队列。 */
  clear: () => void;
  /** 放弃本轮：清队列 + 停表 + 清文本（回合失败时调用）。 */
  abort: () => void;
  /** 只停吐字定时器（finally 兜底）。 */
  stop: () => void;
}

export function useTypewriter(): Typewriter {
  const [liveAnswer, setLiveAnswer] = useState("");
  const typeQueue = useRef("");
  const typeTimer = useRef<number | null>(null);
  const stop = (): void => {
    if (typeTimer.current !== null) {
      window.clearInterval(typeTimer.current);
      typeTimer.current = null;
    }
  };
  const begin = (): void => {
    setLiveAnswer("");
    typeQueue.current = "";
    if (typeTimer.current !== null) return; // 复用运行中的定时器
    typeTimer.current = window.setInterval(() => {
      const queue = typeQueue.current;
      if (!queue) return;
      // 三段式步长：任意长度约 2s 排空，观感恒速
      const step = queue.length > 240 ? Math.ceil(queue.length / 40) : queue.length > 40 ? 6 : 2;
      typeQueue.current = queue.slice(step);
      setLiveAnswer((current) => current + queue.slice(0, step));
    }, 24);
  };
  const enqueue = (text: string): void => {
    typeQueue.current += text;
  };
  const finish = async (): Promise<void> => {
    const started = Date.now();
    while (typeQueue.current && Date.now() - started < 6000) await new Promise((resolve) => setTimeout(resolve, 24));
    stop();
  };
  const clear = (): void => setLiveAnswer("");
  const abort = (): void => {
    typeQueue.current = "";
    stop();
    setLiveAnswer("");
  };
  // 卸载时停止定时器，避免在途吐字泄漏
  useEffect(() => () => stop(), []);
  return { liveAnswer, begin, enqueue, finish, clear, abort, stop };
}
