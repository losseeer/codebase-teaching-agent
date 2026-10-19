import { api } from "../api/client";
import { showToast } from "./toast";
import { clearLegacyTierOverrides, readLegacyTierOverrides } from "./local-state";

/**
  人工修正档位走服务端：校验、写盘、审计、通知都在引擎侧 `commitOverride`，界面不自己算一份再合并。
*/

/** 浏览器里遗留的手动改档：首次连上该仓时一次性上报，成功后清本地键（不双写）。 */
export async function migrateLegacyTierOverrides(repositoryId: string): Promise<void> {
  const legacy = readLegacyTierOverrides(repositoryId);
  const ids = Object.keys(legacy);
  if (!ids.length) return;
  try {
    const current = await api.getOverlays(repositoryId);
    // 服务端已有档位时只清本地键：本地值不覆盖服务端值
    if (Object.keys(current.overlays.modules?.tier ?? {}).length) {
      clearLegacyTierOverrides(repositoryId);
      return;
    }
    await api.mergeOverlays(repositoryId, { modules: { tier: legacy } });
    clearLegacyTierOverrides(repositoryId);
    showToast(`已同步 ${ids.length} 处改档`);
  } catch {
    // 失败则保留本地值下次再试；后台迁移不弹错误
  }
}
