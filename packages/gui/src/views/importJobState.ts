/** 导入任务的本地记录：刷新或切页后据此回读引擎里的进度。 */

const ACTIVE_IMPORT_KEY = "codebase-tutor.import-job";

export function readActiveImportJob(storage: Pick<Storage, "getItem"> = localStorage): string | null {
  try {
    const raw = storage.getItem(ACTIVE_IMPORT_KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

export function writeActiveImportJob(id: string, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(ACTIVE_IMPORT_KEY, id); } catch { /* 存储不可用只影响刷新恢复 */ }
}

export function clearActiveImportJob(storage: Pick<Storage, "removeItem"> = localStorage): void {
  try { storage.removeItem(ACTIVE_IMPORT_KEY); } catch { /* 删不掉只影响下次回读 */ }
}
