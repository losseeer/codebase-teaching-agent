import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../llm/embeddings.js";
import { TutorDatabase } from "../store/database.js";
import { cosine, cosineTop, cosineTopByFile, embedUnits, embeddableHash, embeddableText, fileUnits, pendingUnits, reciprocalRankFusion, symbolUnits, type StoredVector } from "./embed-index.js";

/**
  检索第四臂（dense / hybrid，文件级与函数级两种粒度）的自建件：嵌入文本口径、增量失效键、向量存取、相似度与融合。
  全程假 provider——单测绝不打外部 embedding 端点（真跑有 `pnpm search:embed` 的 --yes 闸门管着）。
  守住的几件事：
  1. 嵌的文本必须与词法臂的三个命中面一字对齐（否则比的是文本不是模型）；
  2. 「文本没变」直接等于「不重嵌」，且第二次调用**一个请求都不发**（重复跑不重复花钱）；
  3. 换 embedding 模型 / 换粒度 = 换坐标系，旧向量一条都不能复用；
  4. 存进去的 float32 与读出来的必须逐位相同（BLOB 编解码成对，评测台架走的是同一个解码函数）；
  5. 函数级池化取**文件内最高分**，且没符号的文件不会因为换粒度而消失。
  */

const vectorOf = (text: string): Float32Array => {
  const out = new Float32Array(8);
  for (const character of text) out[(character.codePointAt(0) ?? 0) % 8] += 1;
  return out;
};

const fakeProvider = (model = "fake-v1") => {
  const calls: string[][] = [];
  const provider: EmbeddingProvider = {
    model,
    dimensions: 8,
    async embed(texts: string[]): Promise<Float32Array[]> {
      calls.push(texts);
      return texts.map(vectorOf);
    }
  };
  return { provider, calls, batchCount: () => calls.length };
};

const entryOf = (path: string, symbols: string[], summary: string) => ({ path, symbols, summary });

describe("嵌入文本口径", () => {
  it("文件级单元：路径 / 符号名 / 一句话职责三段拼起来就是被嵌的东西，失效键是它的哈希", () => {
    const entry = entryOf("src/io/FileService.java", ["FileService", "openCache"], "负责文件打开与缓存读写");
    const [unit] = fileUnits([entry])!;
    expect(unit!.unitId).toBe("src/io/FileService.java");
    expect(unit!.text.split("\n")).toEqual(["src/io/FileService.java", "FileService openCache", "负责文件打开与缓存读写"]);
    expect(embeddableHash(embeddableText(entry))).toBe(embeddableHash(unit!.text));
    expect(embeddableHash(unit!.text)).toHaveLength(16);
  });

  it("哈希只认这段文本：摘要重烧会重嵌，无关字段（行数等）不会", () => {
    const before = fileUnits([entryOf("a.ts", ["A"], "旧职责")]);
    expect(pendingUnits(before, new Map()).map((item) => item.unitId)).toEqual(["a.ts"]);
    const stored = new Map([["a.ts", pendingUnits(before, new Map())[0]!.contentHash]]);
    expect(pendingUnits(before, stored)).toEqual([]);
    expect(pendingUnits(fileUnits([entryOf("a.ts", ["A"], "新职责")]), stored).map((item) => item.unitId)).toEqual(["a.ts"]);
  });

  it("同一路径换了符号名也算变了（向量对不上新文本就是错坐标）", () => {
    const stored = new Map([["a.ts", embeddableHash(embeddableText(entryOf("a.ts", ["A"], "职责")) )]]);
    expect(pendingUnits(fileUnits([entryOf("a.ts", ["B"], "职责")]), stored)).toHaveLength(1);
  });
});

describe("函数级单元的构成", () => {
  const entries = [
    entryOf("src/a/CacheClient.java", ["CacheClient", "set", "get"], "缓存读写与空值兜底"),
    entryOf("src/a/Lone.java", ["Lone"], "只有类没有方法")
  ];
  const symbols = [
    { name: "set", kind: "method", path: "src/a/CacheClient.java", line: 12, parameters: ["key", "value"] },
    { name: "get", kind: "method", path: "src/a/CacheClient.java", line: 20, parameters: ["key"] },
    { name: "Ghost", kind: "class", path: "src/not/in/corpus.java", line: 1, parameters: [] }
  ];

  it("一个符号一条单元，单元 id 带行号（同名重载不会被并成一条）", () => {
    const units = symbolUnits(entries, symbols);
    expect(units.map((unit) => unit.unitId)).toEqual([
      "src/a/CacheClient.java#set#12",
      "src/a/CacheClient.java#get#20",
      "src/a/Lone.java"
    ]);
  });

  it("文本保留三个命中面：换粒度时唯一变的是「符号」那一行换成当前函数（否则差值没法归给粒度）", () => {
    const [unit] = symbolUnits(entries, symbols)!;
    expect(unit!.file).toBe("src/a/CacheClient.java");
    expect(unit!.text.split("\n")).toEqual(["src/a/CacheClient.java", "set method(key, value)", "缓存读写与空值兜底"]);
  });

  it("没有符号的文件仍拿到自己的文件级单元——换粒度不等于丢覆盖", () => {
    const units = symbolUnits(entries, symbols);
    expect(units.some((unit) => unit.unitId === "src/a/Lone.java" && unit.text === embeddableText(entries[1]!))).toBe(true);
    expect(units.some((unit) => unit.file === "src/not/in/corpus.java")).toBe(false);   // 未进语料的文件不进向量表
  });
});

describe("向量存取与增量", () => {
  let repository: string;
  let database: TutorDatabase;

  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), "tutor-embed-index-"));
    database = new TutorDatabase(repository);
  });
  afterEach(() => {
    database.close();
    rmSync(repository, { recursive: true, force: true });
  });

  const entries = [entryOf("src/a.java", ["Alpha"], "缓存读写"), entryOf("src/b.java", ["Beta"], "订单结算")];

  it("首建全嵌、再跑零请求：增量键真的挡住了重复花钱", async () => {
    const fake = fakeProvider();
    const first = await embedUnits(database, fake.provider, "repo_1", fileUnits(entries));
    expect(first).toEqual({ embedded: 2, skipped: 0, pruned: 0 });
    expect(fake.batchCount()).toBe(1);

    const second = await embedUnits(database, fake.provider, "repo_1", fileUnits(entries));
    expect(second).toEqual({ embedded: 0, skipped: 2, pruned: 0 });
    expect(fake.batchCount()).toBe(1);   // 第二次一条请求都不该发
  });

  it("存进去的 float32 读出来逐位相同（BLOB 编解码成对）", async () => {
    await embedUnits(database, fakeProvider().provider, "repo_1", fileUnits(entries));
    const loaded = database.loadVectors("repo_1", "fake-v1");
    expect(loaded.map((row) => row.path)).toEqual(["src/a.java", "src/b.java"]);
    expect(Array.from(loaded[0]!.vec)).toEqual(Array.from(vectorOf(embeddableText(entries[0]!))));
    expect(loaded[0]!.dim).toBe(8);
  });

  it("单元消失（文件删除或符号改名）就清掉它的向量——留着会让 dense 臂返回不存在的路径", async () => {
    const units = symbolUnits(entries, [
      { name: "Alpha", kind: "method", path: "src/a.java", line: 3, parameters: [] },
      { name: "Beta", kind: "method", path: "src/b.java", line: 5, parameters: [] }
    ]);
    await embedUnits(database, fakeProvider("fake-v1#symbol").provider, "repo_1", units);
    expect(database.loadVectors("repo_1", "fake-v1#symbol")).toHaveLength(2);
    const renamed = symbolUnits(entries, [{ name: "AlphaV2", kind: "method", path: "src/a.java", line: 3, parameters: [] }]);
    const after = await embedUnits(database, fakeProvider("fake-v1#symbol").provider, "repo_1", renamed);
    expect(after.pruned).toBe(2);   // Alpha 改名清一条；b.java 从「函数单元」退回「文件单元」再清一条
    expect(database.loadVectors("repo_1", "fake-v1#symbol").map((row) => row.path)).toEqual(["src/a.java#AlphaV2#3", "src/b.java"]);
  });

  it("换模型 / 换粒度 = 全部重嵌，旧坐标系的行原样留着（键含模型+粒度，不混坐标系）", async () => {
    await embedUnits(database, fakeProvider("fake-v1").provider, "repo_1", fileUnits(entries));
    const v2 = fakeProvider("fake-v1#symbol");
    const result = await embedUnits(database, v2.provider, "repo_1", fileUnits(entries));
    expect(result).toEqual({ embedded: 2, skipped: 0, pruned: 0 });
    expect(database.getVectorHashes("repo_1", "fake-v1").size).toBe(2);
    expect(database.loadVectors("repo_1", "fake-v1#symbol")).toHaveLength(2);
  });

  it("换仓不串：另一条仓库读不到本仓向量", async () => {
    await embedUnits(database, fakeProvider().provider, "repo_1", fileUnits(entries));
    expect(database.loadVectors("repo_2", "fake-v1")).toEqual([]);
  });
});

describe("相似度与融合", () => {
  const vector = (path: string, text: string): StoredVector => ({ path, dim: 8, vec: vectorOf(text) });
  const vectors = [vector("src/cache.java", "cache cache cache"), vector("src/order.java", "order order"), vector("src/zero.java", "")];

  it("cosine：同向为 1，正交为 0，零向量不炸", () => {
    const left = vectorOf("cache");
    expect(cosine(left, left)).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]), Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0]))).toBe(0);
    expect(cosine(left, new Float32Array(8))).toBe(0);
  });

  it("cosineTop 按分数降序、零分不参与、同分按路径字典序、limit 生效", () => {
    const top = cosineTop(vectorOf("cache cache cache"), vectors, 5);
    expect(top[0]!.path).toBe("src/cache.java");
    expect(top.map((item) => item.path)).not.toContain("src/zero.java");   // 零向量压根不进候选
    expect(cosineTop(vectorOf("cache cache cache"), vectors, 1)).toHaveLength(1);

    const tied = [vector("b.java", "aa"), vector("a.java", "aa"), vector("c.java", "aa")];
    expect(cosineTop(vectorOf("aa"), tied, 5).map((item) => item.path)).toEqual(["a.java", "b.java", "c.java"]);
  });

  it("cosineTopByFile：同文件的多个函数单元取最高分，返回的是文件而不是单元 id", () => {
    // 手写向量而不是文本派生：文本直方图 embedding 下「cache」「cache cache」方向相同（余弦都是 1），
    // 分不开高低，池化方式就没东西可判——这条要测的是池化，不是相似度本身。
    const axis = (values: number[]): Float32Array => Float32Array.from(values);
    const unit = (path: string, values: number[]): StoredVector => ({ path, dim: 8, vec: axis(values) });
    const query = axis([3, 4, 0, 0, 0, 0, 0, 0]);   // 模长 5
    const units = [
      unit("src/x.java#weak#1", [1, 0, 0, 0, 0, 0, 0, 0]),          // 与 query 正交 ⇒ 0
      unit("src/x.java#strong#2", [3, 4, 0, 0, 0, 0, 0, 0]),        // 1.0
      unit("src/y.java#only#3", [1, 1, 0, 0, 0, 0, 0, 0]),          // 7/(5√2) ≈ 0.99
      unit("src/lonely.java", [5, 0, 0, 0, 0, 0, 0, 0])             // 15/(5·5) = 0.6
    ];
    const top = cosineTopByFile(query, units, 3);
    expect(top.map((item) => item.path)).toEqual(["src/x.java", "src/y.java", "src/lonely.java"]);
    expect(top.every((item) => !item.path.includes("#"))).toBe(true);
    // max 池化：x.java 靠那一个强函数排第一。换成均值池化它就掉到 lonely 之下（(1+0)/2=0.5 < 0.6），
    // 也就是说「粒度有没有用」会被池化方式决定——这条断言把 max 钉住。
    expect(top[0]!.score).toBeGreaterThan(top[1]!.score);
    expect(top[1]!.score).toBeGreaterThan(top[2]!.score);
  });

  it("RRF 只信名次：两臂都出现的排最前，同分按路径字典序保证可复现", () => {
    expect(reciprocalRankFusion([["a", "b"], ["b", "c"]])).toEqual(["b", "a", "c"]);
    expect(reciprocalRankFusion([["x", "y"], ["x", "z"]])[0]).toBe("x");
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    expect(reciprocalRankFusion([])).toEqual([]);
    // 名次差一名就换序（k=60 时靠前的臂权重略高），这是「融合」而非「取并集」
    expect(reciprocalRankFusion([["only-lexical", "shared"], ["shared", "only-dense"]])).toEqual(["shared", "only-lexical", "only-dense"]);
  });
});
