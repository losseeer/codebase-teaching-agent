import { describe, expect, it } from "vitest";

import { clearActiveImportJob, readActiveImportJob, writeActiveImportJob } from "./importJobState";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: () => null,
    length: 0
  } as Storage;
}

describe("导入任务的本地记录", () => {
  it("写入后可读回，清除后为空", () => {
    const storage = memoryStorage();
    expect(readActiveImportJob(storage)).toBeNull();
    writeActiveImportJob("job-1", storage);
    expect(readActiveImportJob(storage)).toBe("job-1");
    clearActiveImportJob(storage);
    expect(readActiveImportJob(storage)).toBeNull();
  });

  it("空白记录按没有处理", () => {
    const storage = memoryStorage();
    storage.setItem("codebase-tutor.import-job", "  ");
    expect(readActiveImportJob(storage)).toBeNull();
  });

  it("存储不可用时读写都不抛错", () => {
    const broken = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); }
    } as unknown as Storage;
    expect(readActiveImportJob(broken)).toBeNull();
    expect(() => writeActiveImportJob("job-1", broken)).not.toThrow();
    expect(() => clearActiveImportJob(broken)).not.toThrow();
  });
});
