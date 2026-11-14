import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.path };
});

import { profilePath, readProfile, writeProfile } from "./profile.js";

describe("用户画像存储", () => {
  beforeAll(() => { home.path = mkdtempSync(join(tmpdir(), "tutor-profile-")); });
  afterAll(() => { rmSync(home.path, { recursive: true, force: true }); });

  it("没有文件时读回空串，不抛错", () => {
    expect(readProfile()).toBe("");
  });

  it("写入即整份替换，空白视为清空，路径在用户目录下", () => {
    writeProfile("## 表达偏好\n严谨、具体。");
    expect(readProfile()).toContain("严谨、具体");
    expect(profilePath().startsWith(home.path)).toBe(true);
    writeProfile("   ");
    expect(readProfile()).toBe("");
  });
});
