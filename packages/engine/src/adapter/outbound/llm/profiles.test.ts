import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path };
});

import { publicProfileView, readProfileFile, removeProfile, setActiveProfile, upsertProfile } from "./profiles.js";

describe("LLM 配置文件", () => {
  beforeAll(() => { home.path = mkdtempSync(join(tmpdir(), "llm-profiles-")); });
  afterAll(() => { rmSync(home.path, { recursive: true, force: true }); });

  it("新建即激活；第二套不抢激活；密钥只出掩码", () => {
    const first = upsertProfile({ name: "主力", provider: "openai-compatible", model: "deepseek-v4-pro", apiKey: "sk-abcdefghijkl" });
    const second = upsertProfile({ name: "备用", model: "gpt-5" });
    const file = readProfileFile();
    expect(file.activeId).toBe(first.id);
    expect(file.profiles.map((item) => item.name)).toEqual(["主力", "备用"]);
    const view = publicProfileView();
    expect(view.profiles[0].apiKeyMasked).not.toContain("abcdefghijkl");
    expect(view.profiles[0].hasApiKey).toBe(true);
    expect(setActiveProfile(second.id)).toBe(true);
    expect(readProfileFile().activeId).toBe(second.id);
  });

  it("删除当前配置后激活项落到剩余第一套", () => {
    const current = readProfileFile();
    const activeId = current.activeId;
    expect(removeProfile(activeId)).toBe(true);
    const next = readProfileFile();
    expect(next.profiles.some((item) => item.id === activeId)).toBe(false);
    expect(next.activeId).toBe(next.profiles[0]?.id ?? "");
  });
});
