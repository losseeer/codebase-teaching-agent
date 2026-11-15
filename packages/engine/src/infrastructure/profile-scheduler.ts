/** 引擎内的画像定时器：启动一分钟后补跑检查，之后每 24h 一次。 */
import { runProfileDaemon } from "../application/use-case/profile-daemon.js";

export function startProfileScheduler(): void {
  const tick = (): void => { void runProfileDaemon(); };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 86_400_000).unref();
}
