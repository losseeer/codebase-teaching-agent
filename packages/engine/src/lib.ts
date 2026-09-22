import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export const id = (): string => randomUUID();
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function repositoryId(path: string): string {
  return `repo_${hash(realpathSync(path)).slice(0, 16)}`;
}

export function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

/** 回合文本单边落盘上限：与 journal HTTP 出口的 payload 字符串校验同口径（2000 字符）。 */
export const TURN_TEXT_LIMIT = 2_000;

/**
  `turn_text` 事件的 payload 构造（2026-09-22 拍板口径）：三种对话（teach / map_chat / practice_chat）的
  问题+回复双边原文进 journal，各截 2000 字；截断必须留痕（`*_truncated`）——丢了字要能看出来，
  与「回复触顶明示」同一先例。
  */
export function turnTextPayload(scene: "teach" | "map_chat" | "practice_chat", question: string, answer: string): Record<string, string | number | boolean> {
  const q = question.slice(0, TURN_TEXT_LIMIT);
  const a = answer.slice(0, TURN_TEXT_LIMIT);
  return {
    scene,
    question: q,
    question_truncated: question.length > q.length,
    answer: a,
    answer_truncated: answer.length > a.length
  };
}

/**
  LLM 产物缓存键的统一构造：`层:仓库id[:范围]:输入哈希`，输入哈希 = 口径版本 + 模型版本 + 本层实际输入。

  为什么键里放**本层实际看到的输入**，而不是全仓 `versionStamp`：全仓哈希让任一字节变化作废整层缓存；
  换成细到「受影响子图」又得证明哪些变更会翻键——不完备就等于把旧结果锁死。而对模型实际看到的
  东西取哈希后，「输入逐字相同 ⇒ 提示词逐字相同 ⇒ 同一问同一答」是直接成立的，不需要额外论证完备性。

  两条使用约束：
  - `repositoryId` 必须在键里：不同仓库可能算出相同输入（同样的空清单、同样的样板路径），
    而缓存值装的是仓库内的节点 id 与相对路径，撞键会把 A 仓的结论挂到 B 仓上；
  - `payload` 必须是 JSON 安全的（Map/Set 会被 `JSON.stringify` 写成 `{}`，等于把不同输入哈希成同一个值）。
    需要时先序列化，例如 `Object.fromEntries(map.entries())`。

  `contractVersion` 专管「输入没变但算法变了」：提示词文本、裁剪阈值、排序规则改了，payload 可以
  一字不变，这类失效只有版本号管得了（L1 摘要键里的 `slice-v1` 是同一个道理）。
  */
export function layerCacheKey(input: {
  layer: string;
  repositoryId: string;
  contractVersion: string;
  modelVersion: string;
  payload: unknown;
  scope?: string;
}): string {
  const digest = hash(`${input.contractVersion}:${input.modelVersion}:${JSON.stringify(input.payload)}`).slice(0, 16);
  return `${input.layer}:${input.repositoryId}${input.scope ? `:${input.scope}` : ""}:${digest}`;
}
