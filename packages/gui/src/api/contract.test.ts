import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContractViolation } from "@codebase-tutor/shared/wire";
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
  it("五类已登记的帧都能过，字段原样带出", () => {
    expect(parseScopedStreamFrame({ type: "thinking", round: 3 })).toEqual({ type: "thinking", round: 3 });
    expect(parseScopedStreamFrame({ type: "reading", path: "src/a.ts" })).toEqual({ type: "reading", path: "src/a.ts" });
    expect(parseScopedStreamFrame({ type: "searching", query: "缓存" })).toEqual({ type: "searching", query: "缓存" });
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
    expect(() => parseScopedStreamFrame({ stage: "thinking", round: 1 })).toThrow(ContractViolation);
  });
});

describe("过程帧的界面文案", () => {
  it("thinking 第一轮不带轮次，之后带", () => {
    expect(progressText({ type: "thinking", round: 1 })).toBe("正在思考…");
    expect(progressText({ type: "thinking", round: 4 })).toBe("正在思考（第 4 轮）…");
  });

  it("reading / searching 缺字段时给通用兜底，不显示空白", () => {
    expect(progressText({ type: "reading", path: "src/a.ts" })).toBe("正在读取 src/a.ts …");
    expect(progressText({ type: "searching", query: "" })).toBe("正在检索代码：关键词 …");
  });

  it("教学那条流是 `progress` 包一层 payload：文案与裸帧同一条", () => {
    expect(progressText({ type: "progress", payload: { stage: "reading", path: "src/b.ts" } })).toBe("正在读取 src/b.ts …");
    expect(progressText({ stage: "thinking", round: 2 })).toBe("正在思考（第 2 轮）…");
  });

  it("整个帧缺席时给「回复生成中…」，不假装知道在哪一步", () => {
    expect(progressText(undefined)).toBe("回复生成中…");
  });
});

describe("界面只从 wire 边界取契约", () => {
  it("没有任何界面源码直接 import `@codebase-tutor/shared` 根出口（引擎内部模型不跨进程）", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => /from "@codebase-tutor\/shared"/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders, `改从 @codebase-tutor/shared/wire 取：${offenders.join(", ")}`).toEqual([]);
  });
});
