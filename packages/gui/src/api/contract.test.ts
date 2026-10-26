import {readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContractViolation } from "@codebase-tutor/contract";

import { parseScopedStreamFrame } from "./client";
import { progressText } from "../agent/progressLines";

/** 界面源码根：本测试住在 `src/api/`。 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

/**
  引擎 ↔ 界面这条边界上的契约：作用域对话的过程帧解析与界面文案映射。
  */
describe("作用域对话流的过程帧契约", () => {
  it("已登记的帧都能过，字段原样带出", () => {
    expect(parseScopedStreamFrame({ type: "thinking" })).toEqual({ type: "thinking" });
    expect(parseScopedStreamFrame({ type: "reading", path: "src/a.ts" })).toEqual({ type: "reading", path: "src/a.ts" });
    expect(parseScopedStreamFrame({ type: "searching", query: "缓存" })).toEqual({ type: "searching", query: "缓存" });
    expect(parseScopedStreamFrame({ type: "loading_skill", skill: "tutor-cost-audit" })).toEqual({ type: "loading_skill", skill: "tutor-cost-audit" });
    expect(parseScopedStreamFrame({ type: "editing_diagram" })).toEqual({ type: "editing_diagram" });
    expect(parseScopedStreamFrame({ type: "querying_facts" })).toEqual({ type: "querying_facts" });
    expect(parseScopedStreamFrame({ type: "calling_external" })).toEqual({ type: "calling_external" });
    expect(parseScopedStreamFrame({ type: "progress", payload: { stage: "reading", path: "src/b.ts" } })).toEqual({ type: "progress", payload: { stage: "reading", path: "src/b.ts" } });
    expect(parseScopedStreamFrame({ type: "delta", delta: "前半段" })).toEqual({ type: "delta", delta: "前半段" });
  });

  it("引擎多发一个没声明的字段：不炸，但不带进界面", () => {
    // 加字段不报错（向后兼容），未声明的字段也不带进界面
    expect(parseScopedStreamFrame({ type: "delta", delta: "x", extraFutureField: 1 })).toEqual({ type: "delta", delta: "x" });
  });

  it("缺了必填的格子：当场抛，并报出是哪一格的契约不符", () => {
    expect(() => parseScopedStreamFrame({ type: "delta" })).toThrow(ContractViolation);
    expect(() => parseScopedStreamFrame({ type: "reading" })).toThrow(/stream\.progress/);
  });

  it("没登记过的帧种类：抛，而不是让界面继续挂着上一行提示", () => {
    expect(() => parseScopedStreamFrame({ type: "compacting", chars: 120 })).toThrow(/stream\.progress/);
  });

  it("`{stage}` 形状的进度载荷走 `progress` 那一类，不裸发", () => {
    expect(() => parseScopedStreamFrame({ stage: "thinking" })).toThrow(ContractViolation);
  });
});

describe("过程帧的界面文案", () => {
  it("thinking 不报轮数：连着几轮想是同一件事，轮数归引擎的账", () => {
    expect(progressText({ type: "thinking" })).toBe("正在思考…");
  });

  it("reading / searching 缺字段时给通用兜底，不显示空白", () => {
    expect(progressText({ type: "reading", path: "src/a.ts" })).toBe("正在读取 src/a.ts …");
    expect(progressText({ type: "searching", query: "" })).toBe("正在检索代码：关键词 …");
  });

  it("取技能、改图、查产物、打外部程序各说一句人话（这些活动以前是静默的）", () => {
    expect(progressText({ type: "loading_skill", skill: "tutor-cost-audit" })).toBe("正在加载技能 tutor-cost-audit …");
    expect(progressText({ type: "loading_skill", skill: "" })).toBe("正在加载已装的做法 …");
    expect(progressText({ type: "editing_diagram" })).toBe("正在改画布上的图 …");
    expect(progressText({ type: "querying_facts" })).toBe("正在查询已有产物 …");
    expect(progressText({ type: "calling_external" })).toBe("正在调用外部工具 …");
  });

  it("教学那条流是 `progress` 包一层 payload：文案与裸帧同一条", () => {
    expect(progressText({ type: "progress", payload: { stage: "reading", path: "src/b.ts" } })).toBe("正在读取 src/b.ts …");
    expect(progressText({ stage: "thinking" })).toBe("正在思考…");
  });

  it("整个帧缺席时给「回复生成中…」，不假装知道在哪一步", () => {
    expect(progressText(undefined)).toBe("回复生成中…");
  });
});

describe("界面的跨包边界", () => {
  it("界面只 import domain 与 contract，不许 import 引擎内部包", () => {
    // 过去靠 wire.ts 那份手工再导出挡越界；现在边界由包本身承担：domain 是零依赖共享内核，contract 是跨进程契约，
    // 引擎内部（analysis、store、llm 实现）不在界面上出现，出现即说明有人把实现细节搬上了线。
    const offenders = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(/from "@codebase-tutor\/([a-z-]+)/g)) {
        const pkg = match[1];
        if (pkg !== "domain" && pkg !== "contract") offenders.add(pkg);
      }
    }
    expect([...offenders], `界面不许依赖这些包：${[...offenders].join(", ")}`).toEqual([]);
  });
});
