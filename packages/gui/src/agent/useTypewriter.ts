import { useEffect, useRef, useState } from "react";

/** 打字机：delta 先进队列，按队列长度自适应吐字；finish 等排空。 */
export interface Typewriter {
  liveAnswer: string;
  /** 开一轮：清队列与文本，确保定时器在跑。 */
  begin: () => void;
  /** 追加一段 delta 到队列。 */
  enqueue: (text: string) => void;
  /** 等队列排空（固化正式消息之前调用）。 */
  finish: () => Promise<void>;
  /** 只清已显示文本，不动队列。 */
  clear: () => void;
  /** 放弃本轮：清队列 + 停表 + 清文本。 */
  abort: () => void;
  /** 只停吐字定时器。 */
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
      // 步长随队列长度自适应，约 2s 排空
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
  useEffect(() => () => stop(), []);
  return { liveAnswer, begin, enqueue, finish, clear, abort, stop };
}
