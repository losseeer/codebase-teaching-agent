import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowsRepository, authEnabled, authenticate, loadApiKeys, presentedKey } from "./api-keys.js";

/**
  key 文件的读法与比对。这里要钉住的是三条「闸门会不会形同虚设」的判据：
  - 没文件 / 坏文件 / 全是短 key ⇒ **认证关闭**（不是「开启且全拒绝」，也不是把引擎锁死）；
  - 短 key（<16 字符）一律不收——它挡不住任何东西，收下只会让人以为自己有闸；
  - 改文件不需要重启引擎（按 mtime 失效缓存），否则换 key 这件事会变成「先猜哪台机器要重启」。
  */

const root = mkdtempSync(join(tmpdir(), "tutor-api-keys-"));
const file = join(root, "api-keys.json");
const GOOD = "sk-tutor-route-key-0123456789";

function writeKeys(value: unknown): void {
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

beforeEach(() => {
  process.env.TUTOR_API_KEYS_FILE = file;
  rmSync(file, { force: true });
});

afterEach(() => {
  delete process.env.TUTOR_API_KEYS_FILE;
});

describe("API key 装载", () => {
  it("没有 key 文件 = 认证关闭（authEnabled 为 false，不是恒拒绝）", () => {
    expect(loadApiKeys()).toEqual([]);
    expect(authEnabled()).toBe(false);
    expect(authenticate(GOOD)).toBeUndefined();
  });

  it("坏 JSON、非数组、缺 key 字段的条目都不算一张 key，也不抛错", () => {
    writeKeys("{ this is not json");
    expect(loadApiKeys()).toEqual([]);
    writeKeys({ keys: "not-an-array" });
    expect(loadApiKeys()).toEqual([]);
    writeKeys({ keys: [{ name: "no-key-field" }, { key: 42 }, { key: GOOD }] });
    expect(loadApiKeys().map((entry) => entry.key)).toEqual([GOOD]);
  });

  it("短于 16 字符的 key 不收；名字缺省补 unnamed-key；repositories 缺省为全部", () => {
    writeKeys({ keys: [{ key: "shorty", name: "太短" }, { key: GOOD }] });
    const keys = loadApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: "unnamed-key", repositories: ["*"] });
    expect(authenticate("shorty")).toBeUndefined();
  });

  it("非字符串的 repositories 条目被剔掉，全非法时不会退化成「什么都不许」", () => {
    writeKeys({ keys: [{ key: GOOD, repositories: ["repo-a", 7, null, ""] }] });
    const auth = authenticate(GOOD);
    expect(auth?.repositories).toEqual(["repo-a", ""]);
    expect(allowsRepository(auth!, "repo-a")).toBe(true);
  });

  it("mtime 变了就重读：换 key 不需要重启引擎", () => {
    writeKeys({ keys: [{ key: GOOD, name: "第一张" }] });
    expect(authenticate(GOOD)?.name).toBe("第一张");
    const other = "sk-tutor-route-key-9876543210";
    writeKeys({ keys: [{ key: other, name: "第二张" }] });
    // 同一次运行里连续写两个文件，mtime 可能落在同一毫秒——显式往前推，测的就是「缓存按 mtime 失效」这条
    const stamp = new Date(Date.now() + 5_000);
    utimesSync(file, stamp, stamp);
    expect(authenticate(GOOD)).toBeUndefined();
    expect(authenticate(other)?.name).toBe("第二张");
  });
});

describe("key 比对与按仓授权", () => {
  beforeEach(() => {
    writeKeys({ keys: [{ key: GOOD, name: "全量", repositories: ["*"] }, { key: "sk-tutor-locked-repo-key-1", name: "只读 A 仓", repositories: ["repo-a"] }] });
  });

  it("逐字节不同的 key 一律不命中（含前后空格的差异）", () => {
    expect(authenticate(GOOD)?.name).toBe("全量");
    expect(authenticate(`${GOOD} `)).toBeUndefined();
    expect(authenticate("")).toBeUndefined();
    expect(authenticate(undefined)).toBeUndefined();
  });

  it("`*` 放行任意仓；限定名单时只放行名单内的仓", () => {
    expect(allowsRepository(authenticate(GOOD)!, "repo-any")).toBe(true);
    const locked = authenticate("sk-tutor-locked-repo-key-1")!;
    expect(locked.name).toBe("只读 A 仓");
    expect(allowsRepository(locked, "repo-a")).toBe(true);
    expect(allowsRepository(locked, "repo-b")).toBe(false);
  });

  it("`x-api-key` 优先；没有时才取 Authorization: Bearer（大小写与多余空格都收）", () => {
    expect(presentedKey(GOOD, `Bearer ${"sk-tutor-locked-repo-key-1"}`)).toBe(GOOD);
    expect(presentedKey(undefined, `bearer  ${GOOD}  `)).toBe(GOOD);
    expect(presentedKey(undefined, "Basic dXNlcjpwdw==")).toBeUndefined();
    expect(presentedKey(undefined, undefined)).toBeUndefined();
  });

  it("读 key 文件是只读的：装载与比对都不会改写它（引擎不许动用户配的文件）", () => {
    const before = readFileSync(file, "utf8");
    expect(loadApiKeys()).toHaveLength(2);
    authenticate(GOOD);
    authenticate("错的 key");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
