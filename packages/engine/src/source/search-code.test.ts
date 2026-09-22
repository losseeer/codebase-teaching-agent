import { describe, expect, it } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { SEARCH_CODE_TOOL, buildSearchCorpus, executeSearchCode } from "./search-code.js";

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
