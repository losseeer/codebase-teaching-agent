import { api } from "../api/client";
import { showToast } from "./toast";
import { clearLegacyTierOverrides, readLegacyTierOverrides } from "./local-state";

/**
  人工修正走服务端（2026-10-16）。存在这里的只有「发给引擎」这一件事：
  校验、写盘、审计、通知都在引擎侧的 `commitOverride` 里，界面**不自己算一份再合并**——
  两边各判一次，就会出现「界面以为改成了、图上还是旧的」。
*/

/** 旧版本留在浏览器里的手动改档：第一次连上这个仓时一次性上报，成功后清本地键（不留双写）。 */
export async function migrateLegacyTierOverrides(repositoryId: string): Promise<void> {
  const legacy = readLegacyTierOverrides(repositoryId);
  const ids = Object.keys(legacy);
  if (!ids.length) return;
  try {
    const current = await api.getOverlays(repositoryId);
    // 服务端已经有档位就什么都不做：说明这台浏览器不是第一次迁（或另一台机器先迁了），旧值不该盖掉新值
    if (Object.keys(current.overlays.modules?.tier ?? {}).length) {
      clearLegacyTierOverrides(repositoryId);
      return;
    }
    await api.mergeOverlays(repositoryId, { modules: { tier: legacy } });
    clearLegacyTierOverrides(repositoryId);
    showToast(`已把 ${ids.length} 处手动改档交给引擎保存`);
  } catch {
    // 迁不动就不迁：本地值还在，下次再试。这条不弹错误——用户在用功能，不该被一条后台搬家打断
  }
}

/** 一次修正的发送与如实回报（引擎那句原话就是最终结论，界面不重述判断）。 */
export async function applyOverride(repositoryId: string, intent: Parameters<typeof api.applyOverlay>[1]): Promise<{ ok: boolean; text: string }> {
  try {
    return await api.applyOverlay(repositoryId, intent);
  } catch (reason) {
    /**
      拒写是 **422 带正文**回来的（`error` 就是引擎那句话），它和「引擎根本没起来」是两回事：
      前者要给用户看理由（「层名 X 不在现在的图上」这种话只有引擎知道），后者才是一句连接失败。
      一律报「没送达」等于把产品最该说清的那句话抹掉。
      */
    const message = reason instanceof Error ? reason.message : "";
    return { ok: false, text: message && message !== "请求失败" ? message : "修正没送达引擎（本机引擎没起来？）" };
  }
}
