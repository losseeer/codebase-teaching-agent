import { describe, expect, it } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { SEARCH_CODE_TOOL, buildSearchCorpus, executeSearchCode } from "./search-code.js";
import { segmentForLookup } from "../text/lexical.js";

/** 小型假仓：3 个文件，分别提供路径/符号/职责三种命中面与一个 P2 假阳性诱饵。 */
const INDEX = {
  repositoryId: "r1",
  repositoryPath: "/fake",
  scannedAt: "2026-09-21T00:00:00.000Z",
  totalFiles: 3,
  totalLines: 500,
  files: [
    { path: "src/io/FileService.java", extension: ".java", bytes: 1, lines: 420 },
    { path: "src/io/ExceptRunner.java", extension: ".java", bytes: 1, lines: 55 },
    { path: "src/web/Configuration.java", extension: ".java", bytes: 1, lines: 25 }
  ]
} as unknown as RepositoryIndex;

const ANALYSIS = {
  repositoryId: "r1",
  graph: {
    imports: {
      "src/io/FileService.java": [],
      "src/io/ExceptRunner.java": ["src/io/FileService.java"],
      "src/web/Configuration.java": []
    },
    calls: [],
    symbols: [
      { id: "s1", name: "FileService", kind: "class", path: "src/io/FileService.java", line: 3 },
      { id: "s2", name: "openStream", kind: "method", path: "src/io/FileService.java", line: 10 },
      { id: "s3", name: "run", kind: "function", path: "src/io/ExceptRunner.java", line: 4 }
    ],
    entrypoints: [],
    semanticBackend: "static",
    lspStatus: []
  }
} as unknown as RepositoryAnalysis;

const SUMMARIES = new Map<string, string>([
  ["src/io/FileService.java", "负责文件打开与缓存读写"],
  ["src/io/ExceptRunner.java", "捕获异常并重启任务"],
  ["src/web/Configuration.java", "装配 Spring 配置"]
]);

const corpus = buildSearchCorpus(INDEX, ANALYSIS, SUMMARIES);
const run = (query: string, limit?: number) => executeSearchCode(corpus, JSON.stringify({ query, ...(limit === undefined ? {} : { limit }) }));

describe("buildSearchCorpus", () => {
  it("语料 = 已分析文件全集，行数取自索引、符号聚合去重、职责取自 L1 摘要", () => {
    expect(corpus.entries.map((entry) => entry.path)).toEqual([
      "src/io/ExceptRunner.java",
      "src/io/FileService.java",
      "src/web/Configuration.java"
    ]);
    const file = corpus.entries.find((entry) => entry.path.endsWith("FileService.java"))!;
    expect(file.lines).toBe(420);
    expect(file.symbols).toEqual(["FileService", "openStream"]);
    expect(file.summary).toBe("负责文件打开与缓存读写");
  });

  it("摘要表缺某个文件不丢条目（只少一个命中面）", () => {
    const partial = buildSearchCorpus(INDEX, ANALYSIS, new Map());
    expect(partial.entries).toHaveLength(3);
    expect(partial.entries.every((entry) => entry.summary === "")).toBe(true);
  });
});

describe("executeSearchCode 打分与词边界", () => {
  it("路径段命中：'io' 命中 io/ 目录文件，不再假阳性命中 Configuration（P2 口径）", () => {
    const { content } = run("io");
    expect(content).toContain("src/io/FileService.java");
    expect(content).toContain("src/io/ExceptRunner.java");
    expect(content).not.toContain("Configuration");
  });

  it("符号名整串命中：查询即符号名时只有该文件入围", () => {
    const { audit } = run("FileService");
    expect(audit.hits).toBe(1);
    expect(audit.topPaths).toEqual(["src/io/FileService.java"]);
  });

  it("中文职责词命中摘要；多命中面者排前", () => {
    const { content, audit } = run("缓存");
    expect(audit.topPaths[0]).toBe("src/io/FileService.java");
    expect(content).toContain("职责: 负责文件打开与缓存读写");
    expect(content).not.toContain("ExceptRunner");
  });

  it("路径+符号双命中排在单符号命中之前（分数降序）", () => {
    const { audit } = run("file service");
    expect(audit.hits).toBe(1);
    expect(audit.topPaths[0]).toBe("src/io/FileService.java");
  });

  it("测试文件重罚垫底不抢排名；唯一演示者仍兜底进结果并带「测试文件」标注", () => {
    const testIndex = {
      files: [
        { path: "src/io/FileService.java", extension: ".java", bytes: 1, lines: 10 },
        { path: "src/test/java/io/FileServiceTest.java", extension: ".java", bytes: 1, lines: 8 }
      ]
    } as unknown as RepositoryIndex;
    const testAnalysis = {
      graph: {
        imports: { "src/io/FileService.java": [], "src/test/java/io/FileServiceTest.java": [] },
        symbols: [{ id: "t1", name: "FileServiceTest", kind: "class", path: "src/test/java/io/FileServiceTest.java", line: 1 }]
      }
    } as unknown as RepositoryAnalysis;
    const corpus = buildSearchCorpus(testIndex, testAnalysis, new Map([
      ["src/io/FileService.java", "负责缓存读写"],
      ["src/test/java/io/FileServiceTest.java", "缓存读写测试，验证命中行为"]
    ]));
    // 原始分测试文件更高（缓存+2、测试+2 vs 缓存+2）——封顶 1 分后必须让位
    const both = executeSearchCode(corpus, JSON.stringify({ query: "缓存 测试" }));
    expect(both.audit.topPaths[0]).toBe("src/io/FileService.java");
    // 只有测试演示过的概念：兜底给出、明说它是测试文件，而不是假零
    const only = executeSearchCode(corpus, JSON.stringify({ query: "命中行为" }));
    expect(only.audit.topPaths).toEqual(["src/test/java/io/FileServiceTest.java"]);
    expect(only.content).toContain("测试文件");
    // 兜底分与真实弱命中并列（都是 1）时，测试仍靠后——真仓 cache-penetration 用例就是被这条挤掉的
    const tieCorpus = buildSearchCorpus(
      { files: [{ path: "src/io/a/CacheService.java", extension: ".java", bytes: 1, lines: 10 }, { path: "src/test/java/io/ZzTest.java", extension: ".java", bytes: 1, lines: 8 }] } as unknown as RepositoryIndex,
      { graph: { imports: { "src/io/a/CacheService.java": [], "src/test/java/io/ZzTest.java": [] }, symbols: [] } } as unknown as RepositoryAnalysis,
      new Map([["src/io/a/CacheService.java", "缓存读写"], ["src/test/java/io/ZzTest.java", "测试缓存读写"]] as const)
    );
    const tie = executeSearchCode(tieCorpus, JSON.stringify({ query: "缓存" }));
    expect(tie.audit.topPaths[0]).toBe("src/io/a/CacheService.java");
  });

  it("结果只给位置与职责，不含源码正文；head 指明下一步用 read_file", () => {
    const { content } = run("service");
    expect(content).toContain("search_code");
    expect(content).toContain("read_file");
    expect(content).toContain("src/io/FileService.java");
    expect(content).toContain("openStream");
  });
});

describe("executeSearchCode 边界行为", () => {
  it("无命中明示为空，不伪造结果", () => {
    const { content, audit } = run("zzzqqq不存在");
    expect(audit).toEqual({ query: "zzzqqq不存在", hits: 0, topPaths: [] });
    expect(content).toContain("没有命中");
  });

  it("limit 截断返回条数，hits 仍是全量命中数", () => {
    const { content, audit } = run("io", 1);
    expect(audit.hits).toBe(2);
    expect(audit.topPaths).toHaveLength(1);
    expect(content).toContain("返回前 1 条");
  });

  it("非法 JSON 与缺 query 都以文本回喂，不抛异常（空串按缺参处理，同 read_file 语义）", () => {
    expect(executeSearchCode(corpus, "not json").content).toContain("合法 JSON");
    expect(executeSearchCode(corpus, "{}").content).toContain("缺少 query");
    expect(executeSearchCode(corpus, "").content).toContain("缺少 query");
  });

  it("结果预算兜总字符：放不下时明示省略条数，而非静默截半条", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `src/mod/S${i}Service.java`);
    const wideIndex = {
      files: paths.map((path) => ({ path, extension: ".java", bytes: 1, lines: 10 }))
    } as unknown as RepositoryIndex;
    const wideAnalysis = {
      graph: {
        imports: Object.fromEntries(paths.map((path) => [path, []])),
        symbols: paths.map((path, i) => ({ id: `w${i}`, name: `S${i}Service`, kind: "class", path, line: 1 }))
      }
    } as unknown as RepositoryAnalysis;
    const fatSummaries = new Map(paths.map((path) => [path, `缓存${"读写".repeat(200)}`])); // 建库时被长度上限裁住
    const wideCorpus = buildSearchCorpus(wideIndex, wideAnalysis, fatSummaries);
    const { content, audit } = executeSearchCode(wideCorpus, JSON.stringify({ query: "缓存", limit: 15 }));
    expect(audit.hits).toBe(20);
    expect(content.length).toBeLessThan(3_000);
    expect(content).toContain("超出结果预算");
    expect(content).toMatch(/返回前 \d+ 条/);
  });

  it("工具定义要求 query 必填", () => {
    expect(SEARCH_CODE_TOOL.parameters.required).toEqual(["query"]);
  });
});

describe("整句中文：兜底最后一级与它的两道闸（§26 读数换来的行为）", () => {
  const sentence = "缓存读写这块是谁负责的";

  it("原样查询零命中 ⇒ 自动用中文二分切词重试，并明说结果来自兜底臂", () => {
    const { content, audit } = run(sentence);
    expect(audit.segmented).toBe(true);
    expect(audit.topPaths[0]).toBe("src/io/FileService.java");
    expect(content).toContain("中文切词兜底");
  });

  it("关键词式查询第一遍就命中 ⇒ 根本不碰兜底臂（已验证的行为一分不动）", () => {
    expect(run("缓存").audit.segmented).toBeUndefined();
    expect(run("FileService").audit.segmented).toBeUndefined();
    expect(run("io").audit.segmented).toBeUndefined();
  });

  it("DF 闸 + 一致性闸：只被通用双字撞上的文件不算命中，带两个片段的仍能捞到", () => {
    const paths = ["src/a/Up.java", "src/a/Down.java", "src/a/Parse.java", "src/a/Keep.java"];
    const index = {
      repositoryId: "r9", repositoryPath: "/f", scannedAt: "2026-10-04T00:00:00.000Z", totalFiles: 4, totalLines: 40,
      files: paths.map((path) => ({ path, extension: ".java", bytes: 1, lines: 10 }))
    } as unknown as RepositoryIndex;
    const analysis = {
      repositoryId: "r9",
      graph: { imports: Object.fromEntries(paths.map((path) => [path, []])), calls: [], symbols: [], entrypoints: [], semanticBackend: "static", lspStatus: [] }
    } as unknown as RepositoryAnalysis;
    // 四条摘要都含「文件」⇒ 文档频率 4/4 超上限（max(3, ⌊4×12%⌋)=3）被当通用词丢掉；其余片段无人命中
    const summaries = new Map<string, string>([
      ["src/a/Up.java", "文件上传"], ["src/a/Down.java", "文件下载"], ["src/a/Parse.java", "文件解析"], ["src/a/Keep.java", "文件缓存读写"]
    ]);
    const wide = buildSearchCorpus(index, analysis, summaries);
    expect(executeSearchCode(wide, JSON.stringify({ query: "这些文件都是做什么的" })).audit.hits).toBe(0);
    const better = executeSearchCode(wide, JSON.stringify({ query: "缓存读写在哪里做" }));
    expect(better.audit.topPaths[0]).toBe("src/a/Keep.java");
    expect(better.audit.segmented).toBe(true);
  });

  it("切词不误伤 ASCII 与关键词式查询（原样保留，不插空格拆坏整词判定）", () => {
    expect(segmentForLookup("io")).toBe("io");
    expect(segmentForLookup("seckill voucher listener")).toBe("seckill voucher listener");
    expect(segmentForLookup("缓存")).toBe("缓存");
    expect(segmentForLookup("缓存击穿")).toBe("缓存 存击 击穿");
  });

  it("一致性闸只认互不重叠的证据：「一对一」切出的 一对/对一 是一处文字不是两处（真仓负例实测的形状）", () => {
    const paths = ["src/a/Pair.java", "src/a/Chat.java"];
    const index = {
      repositoryId: "r10", repositoryPath: "/g", scannedAt: "2026-10-04T00:00:00.000Z", totalFiles: 2, totalLines: 20,
      files: paths.map((path) => ({ path, extension: ".java", bytes: 1, lines: 10 }))
    } as unknown as RepositoryIndex;
    const analysis = {
      repositoryId: "r10",
      graph: { imports: Object.fromEntries(paths.map((path) => [path, []])), calls: [], symbols: [], entrypoints: [], semanticBackend: "static", lspStatus: [] }
    } as unknown as RepositoryAnalysis;
    const twoFace = buildSearchCorpus(index, analysis, new Map<string, string>([
      ["src/a/Pair.java", "秒杀券实体，与优惠券一对一绑定"],
      ["src/a/Chat.java", "私信会话分页与验签"]
    ]));
    const result = executeSearchCode(twoFace, JSON.stringify({ query: "一对一的私信验签是怎么做" }));
    expect(result.audit.segmented).toBe(true);
    expect(result.audit.topPaths).toEqual(["src/a/Chat.java"]);   // 私信 + 验签 两处不重叠 ⇒ 进；一对 + 对一 同一处 ⇒ 不进
    expect(result.content).toContain("私信");
    expect(result.content).not.toContain("Pair.java");
  });
});
describe("符号级位置回报（就近函数 + 行号）", () => {
  const paths = ["src/pay/VerifyCallback.java", "src/pay/Receipt.java"];
  const index = {
    repositoryId: "r11", repositoryPath: "/h", scannedAt: "2026-10-04T00:00:00.000Z", totalFiles: 2, totalLines: 90,
    files: paths.map((path) => ({ path, extension: ".java", bytes: 1, lines: 45 }))
  } as unknown as RepositoryIndex;
  const symbols = [
    { id: "u1", name: "verifyCallback", kind: "method", path: paths[0], line: 41, parameters: ["tokenValue"] },
    { id: "u2", name: "sum", kind: "method", path: paths[1], line: 9, parameters: ["id"] }
  ];
  const analysis = {
    repositoryId: "r11",
    graph: { imports: { [paths[0]]: [], [paths[1]]: [] }, calls: [], symbols, entrypoints: [], semanticBackend: "static", lspStatus: [] }
  } as unknown as RepositoryAnalysis;
  const local = buildSearchCorpus(index, analysis, new Map<string, string>([[paths[0], "支付回调验签"], [paths[1], "收据金额实体"]]));
  const ask = (query: string) => executeSearchCode(local, JSON.stringify({ query }));

  it("命中的符号连行号一起给出：模型拿着 verifyCallback:41 直接读文件，不用再猜位置", () => {
    const result = ask("verifyCallback 支付");
    expect(result.audit.topPaths[0]).toBe(paths[0]);
    expect(result.content).toContain("就近: verifyCallback:41");
  });

  it("形参与种类不参与打分（三仓实测：加了这个面 hit@5 一格不涨，还把干净负例撞成误命中）", () => {
    expect(ask("tokenvalue 无关词").audit.hits).toBe(0);
    expect(ask("id 无关词").audit.hits).toBe(0);
  });

  it("同名符号重载：打分用的名字去重，定位用的行号逐条保留", () => {
    const overloads = buildSearchCorpus(index, {
      ...analysis,
      graph: { ...analysis.graph, symbols: [
        { id: "u1", name: "verifyCallback", kind: "method", path: paths[0], line: 41 },
        { id: "u2", name: "verifyCallback", kind: "method", path: paths[0], line: 63 }
      ] }
    } as unknown as RepositoryAnalysis, new Map());
    const entry = overloads.entries.find((item) => item.path === paths[0]);
    expect(entry?.symbols).toEqual(["verifyCallback"]);
    expect(entry?.units.map((unit) => unit.line)).toEqual([41, 63]);
  });
});
