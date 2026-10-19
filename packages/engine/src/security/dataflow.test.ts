import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/shared";
import { repositoryId } from "../identity.js";
import { readJournal } from "../store/journal.js";
import { runWithTrace } from "../trace/context.js";
import { recordEgress, type EgressSource } from "./dataflow.js";

/**
  出网清单的计入审计口径，四条判据都得钉住：
  - 一行都不带正文（带了指纹就没意义了，日志本身变成第二个泄露面）；
  - 空清单不落空行，被上层预算裁掉的段不算出网（虚报比漏报更糟）；
  - 仓 id 由路径推导，与导入时写进索引的同一套算法，不另造一套；
  - traceId 跟着请求上下文走——报表靠它把 journal 与 llm.log 接起来。
  */

const repositories: string[] = [];
const SECRET_TEXT = 'export const token = "sk-abcdefghijklmnopqrstuvwx";';
const CLEAN_TEXT = "export function registerOrder(builder) {\n  return builder.build();\n}";

function fixtureRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "tutor-dataflow-"));
  repositories.push(repository);
  return repository;
}

function source(overrides: Partial<EgressSource> = {}): EgressSource {
  return { kind: "anchor-excerpt", path: "src/main.ts", from: 3, to: 5, text: CLEAN_TEXT, ...overrides };
}

function rows(repositoryPath: string): JournalEvent[] {
  return readJournal(repositoryPath).filter((event) => event.type === "code_egress");
}

afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

describe("源码出网清单计入审计", () => {
  it("每段一行：路径、行区间、字符数与指纹齐全，payload 里没有正文", () => {
    const repository = fixtureRepository();
    recordEgress({ repositoryPath: repository, scene: "map.chat", sessionId: "thread-1", sources: [source(), source({ path: "src/other.ts", from: 1, to: 2, text: "// 一行\n// 两行" })] });

    const list = rows(repository);
    expect(list).toHaveLength(2);
    expect(list[0].payload).toMatchObject({ scene: "map.chat", kind: "anchor-excerpt", path: "src/main.ts", lines: "3-5", chars: CLEAN_TEXT.length });
    expect(String(list[0].payload.hash)).toMatch(/^[0-9a-f]{12}$/);
    expect(list[0].sessionId).toBe("thread-1");
    expect(list[1].payload.path).toBe("src/other.ts");
    for (const event of list) expect(JSON.stringify(event)).not.toContain(CLEAN_TEXT);
  });

  it("「扫过且干净」与「这道路没扫」是两个读数：masked=0 照样写，缺字段才是不写", () => {
    const repository = fixtureRepository();
    recordEgress({
      repositoryPath: repository,
      scene: "practice.polish",
      sources: [
        source({ path: "src/unswept.ts" }), // 装配方没给读数 = 这道路没过筛
        source({ path: "src/clean.ts", masked: 0 }), // 过了筛、零命中——必须留得下这个 0
        source({ path: "src/dirty.ts", text: SECRET_TEXT, masked: 2, truncated: true })
      ]
    });

    const [unswept, clean, dirty] = rows(repository);
    expect(unswept?.payload.masked).toBeUndefined();
    expect(clean?.payload.masked).toBe(0);
    expect(clean?.payload.truncated).toBeUndefined();
    expect(dirty?.payload).toMatchObject({ masked: 2, truncated: true });
    // 被隐去过的段，其正文（含密钥原样）绝不落进审计线
    expect(JSON.stringify(dirty)).not.toContain("sk-abcdefghijklmnop");
  });

  it("空清单不落任何行；给了 sent 就只登记其中确实还存在的那些段", () => {
    const repository = fixtureRepository();
    recordEgress({ repositoryPath: repository, scene: "map.chat", sources: [] });
    expect(rows(repository)).toHaveLength(0);

    // 模拟外层上下文预算把尾部整段裁掉：第二段没出门，就不能算出网
    const kept = source({ path: "src/kept.ts", text: "const kept = 1;" });
    const cut = source({ path: "src/cut.ts", text: "const cut = 2;" });
    recordEgress({ repositoryPath: repository, scene: "map.chat", sources: [kept, cut], sent: `代码上下文：\n${kept.text}\n\n问题：这段干什么？` });
    const list = rows(repository);
    expect(list.map((event) => event.payload.path)).toEqual(["src/kept.ts"]);

    // 空正文不能被 `includes("")` 恒真放进来
    recordEgress({ repositoryPath: repository, scene: "map.flow", sources: [source({ text: "" })], sent: "任何一份待发文本" });
    expect(rows(repository)).toHaveLength(1);
  });

  it("仓 id 由路径推导、traceId 跟请求上下文：报表才有连接键", () => {
    const repository = fixtureRepository();
    runWithTrace("req-egress-1", () => recordEgress({ repositoryPath: repository, scene: "teaching.turn", sources: [source()] }));
    recordEgress({ repositoryPath: repository, scene: "map.summary", sources: [source({ kind: "l1-slice" })] });

    const [inRequest, inBackground] = rows(repository);
    expect(inRequest?.traceId).toBe("req-egress-1");
    expect(inRequest?.repositoryId).toBe(repositoryId(repository));
    // 后台任务（导入期摘要）没有请求上下文，照旧记 null——不编一个 id 出来
    expect(inBackground?.traceId).toBeNull();
    expect(readFileSync(join(repository, ".tutor", "journal.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});
