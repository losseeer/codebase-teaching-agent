import { useEffect, useRef, useState } from "react";

/**
  打字机节奏器：SSE 回放是「LLM 生成完一次性 flush」，delta 直写 liveAnswer 会在一帧内全部渲染、观感仍是整段落下。
  收到的 delta 进队列，由定时器按自适应步长吐字（队列越长步长越大，任意长度约 2s 追平）；done 后等队列排空再固化正式消息。

  自成一个 Hook：队列/定时器/liveAnswer 三态与六个动作只在这一处，发送逻辑只按语义调 begin/enqueue/finish/clear/abort/stop。
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
    if (typeTimer.current !== null) return; // 表已在跑，复用
    typeTimer.current = window.setInterval(() => {
      const queue = typeQueue.current;
      if (!queue) return;
      // 三段式步长：长回复粗步追进度、中段匀速、尾部细步收尾——任意长度约 2s 排空，观感是恒速打字而非几何拖尾
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
  // 卸载时停表：否则在途吐字定时器会一直跑（只在 stop/finish 里停的话，卸载即泄漏）
  useEffect(() => () => stop(), []);
  return { liveAnswer, begin, enqueue, finish, clear, abort, stop };
}
