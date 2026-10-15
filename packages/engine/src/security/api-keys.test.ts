import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowsRepository, authEnabled, authStateOf, authenticate, ensureLocalKey, loadApiKeys, presentedKey, resetProvisionFailureForTest, stillIssued } from "./api-keys.js";

/**
  key 文件的读法与比对。这里要钉住的是五条「闸门会不会形同虚设」的判据：
  - **本机默认形态必须有口令**（`ensureLocalKey`，2026-10-15 拍板「本机调用也得带 token」）：
    没文件就配发一张，配发失败按 broken 拦死，绝不退回「所以免鉴权」；
  - 坏 JSON、或写了条目却一张都用不了 ⇒ **broken = 按拒绝全部处理**（10-12 改的：
    以前这一档也退回免鉴权，等于「把文件编辑到一半」这几秒钟整机摊开）；
  - 短 key（<16 字符）一律不收——它挡不住任何东西，收下只会让人以为自己有闸；
  - 改文件不需要重启引擎（按 mtime 失效缓存），否则换 key 这件事会变成「先猜哪台机器要重启」；
  - 装载与比对**都不改写**用户的文件（只有 `ensureLocalKey` 会写，且只补缺不覆盖）。
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
  resetProvisionFailureForTest(); // 上一条用例故意把配发搞砸过：不清零会把后面的 `off` 断言全判成 broken
});

afterEach(() => {
  delete process.env.TUTOR_API_KEYS_FILE;
});

describe("API key 装载", () => {
  it("没有 key 文件 = 认证关闭（authEnabled 为 false，不是恒拒绝）；这一档只属于没跑过配发的进程", () => {
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

describe("闸门三档状态（off / on / broken）", () => {
  /** 装载按 mtime 失效缓存：同毫秒内的两次写会被当成同一次，所以这里显式往前推（与上面那条 mtime 用例同一手法）。 */
  let bump = 1_000;
  function writeState(value: unknown): void {
    writeKeys(value);
    const stamp = new Date(Date.now() + (bump += 1_000));
    utimesSync(file, stamp, stamp);
  }

  it("没文件 = off；合法空清单 = off（用户自己关的闸）", () => {
    expect(authStateOf()).toBe("off");
    writeState({ keys: [] });
    expect(authStateOf()).toBe("off");
    expect(authEnabled()).toBe(false);
  });

  it("坏 JSON / 形状不对 = broken：不是「没闸」，而且一张 key 都不给用", () => {
    writeState("{ keys 少个引号");
    expect(authStateOf()).toBe("broken");
    expect(authEnabled()).toBe(false);
    expect(loadApiKeys()).toEqual([]);
    writeState({ keys: "not-an-array" });
    expect(authStateOf()).toBe("broken");
    writeState({ notKeys: [] });
    expect(authStateOf()).toBe("broken");
  });

  it("写了条目却一张都用不了（全是短 key）= broken；同批里有一张有效就照常是 on", () => {
    writeState({ keys: [{ key: "shorty", name: "太短" }] });
    expect(authStateOf()).toBe("broken");
    writeState({ keys: [{ key: "shorty" }, { key: GOOD }] });
    expect(authStateOf()).toBe("on");
    expect(loadApiKeys()).toHaveLength(1);
  });

  it("撤掉的 key 立刻不算在册（长连接靠这条自摘），闸门没开时不作判", () => {
    writeState({ keys: [{ key: GOOD, name: "在册的" }] });
    expect(stillIssued("在册的")).toBe(true);
    expect(stillIssued("已撤的")).toBe(false);
    rmSync(file, { force: true });
    // 闸门关着（没有身份体系）时恒为真：否则本机模式下每条流都会被自己掐掉
    expect(stillIssued("任意名字")).toBe(true);
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

/**
  开机配发本机口令（2026-10-15 拍板：「本机调用也得带 token」）。
  这一组钉的是「默认形态到底有没有闸」——以前答案是「没人手动建文件就没有闸」，
  而默认装机根本不会有人建，等于闸门这个名字挂着、整机对本机任意进程摊开。
  要钉住的四件事：缺就补、有就不动、补不成不许退回免鉴权、补出来的文件不许可读。
  */
describe("ensureLocalKey：本机默认形态也必须有一张口令", () => {
  const issuedKey = (): string => ((JSON.parse(readFileSync(file, "utf8")) as { keys: { key: string }[] }).keys[0]?.key ?? "");

  it("没文件：配发一张全量 key，闸门转 on，权限 0600", () => {
    expect(authStateOf()).toBe("off");
    const issued = ensureLocalKey();
    expect(issued.created).toBe(true);
    expect(issued.file).toBe(file);
    expect(authStateOf()).toBe("on");
    expect(authEnabled()).toBe(true);
    expect(issuedKey().length).toBeGreaterThanOrEqual(16);
    expect(authenticate(issuedKey())?.repositories).toEqual(["*"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("第二次开机不换口令：已有可用 key 时一个字都不写（否则界面里存的那份每次都 401）", () => {
    const first = ensureLocalKey();
    expect(first.created).toBe(true);
    const before = readFileSync(file, "utf8");
    utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000)); // 强制缓存失效，测的就是「读到 on 就不写」而不是「缓存没变」
    const again = ensureLocalKey();
    expect(again.created).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("手写的清单不被覆盖：只补缺，已有的 key 原样在册", () => {
    writeKeys({ keys: [{ key: GOOD, name: "只读 A 仓", repositories: ["repo-a"] }] });
    expect(ensureLocalKey().created).toBe(false);
    expect(loadApiKeys().map((entry) => entry.name)).toEqual(["只读 A 仓"]);
    expect(allowsRepository(authenticate(GOOD)!, "repo-b")).toBe(false);
  });

  it("空清单不再是「用户把闸关了」：照样配发一张，默认形态里没有免鉴权这一档", () => {
    writeKeys({ keys: [] });
    expect(authStateOf()).toBe("off");
    expect(ensureLocalKey().created).toBe(true);
    expect(authStateOf()).toBe("on");
    expect(statSync(file).mode & 0o777).toBe(0o600); // 文件本来就在，mode 得靠显式一次 chmod
  });

  it("文件坏到读不出来时不覆盖：配发不动它，闸门保持 broken（要修的不是冲掉）", () => {
    writeKeys("{ keys 少个引号");
    const before = readFileSync(file, "utf8");
    const issued = ensureLocalKey();
    expect(issued.created).toBe(false);
    expect(issued.reason).toContain("读不出来");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(authStateOf()).toBe("broken");
  });

  it("写不出口令文件时按「拒绝全部」跑，不退回免鉴权——路径修好后重试就能恢复", () => {
    const blocked = join(root, "a-file-blocks-the-dir");
    writeFileSync(blocked, "挡路用", "utf8"); // 父路径是个普通文件：mkdir 必然失败
    process.env.TUTOR_API_KEYS_FILE = join(blocked, "api-keys.json");
    expect(ensureLocalKey().created).toBe(false);
    expect(authStateOf()).toBe("broken"); // 「配不出来」≠「没配所以放行」
    expect(authEnabled()).toBe(false);
    expect(loadApiKeys()).toEqual([]);
    expect(authenticate(GOOD)).toBeUndefined();
    const dir = join(root, "recovered-dir");
    mkdirSync(dir, { recursive: true });
    process.env.TUTOR_API_KEYS_FILE = join(dir, "api-keys.json");
    expect(ensureLocalKey().created).toBe(true);
    expect(authStateOf()).toBe("on");
    rmSync(join(dir, "api-keys.json"), { force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(blocked, { force: true });
  });
});
