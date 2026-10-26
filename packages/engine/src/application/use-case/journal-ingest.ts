import type { JournalEvent } from "@codebase-tutor/domain";
import { repositoryOr404 } from "../../services.js";
import { Journal, isEngineOwnedEventType, isUiJournalEventType } from "../../store/journal.js";

/**
  界面动作事件的入账用例：每一次切节点、打开文件、切换主题、提交练习都要有 journal 事件可查。

  契约要点（这几条是审计能不能信这条线的前提，不许在传输层放宽）：
  - 只收界面侧那张表（`UI_JOURNAL_EVENTS`，成员以那张表为准）。`file_read` / `code_egress` / `token_usage`
    是审计证据，而这条接口本机任何进程都调得到，照全集合放行等于让被审计的一方自己填账；
  - `payload` 仅允许标量（`string | number | boolean | null`）：结构化对象会随版本漂移；
  - `sessionId` 只校验是字符串且有长度上限，不做存在性校验：journal 是 append-only 事件流，
    sessionId 是关联属性而非外键。超长会永久占进审计线，所以拒掉而不是截断。
  */
export type IngestFailure =
  | { kind: "repository-missing" }
  | { kind: "engine-owned-event" }
  | { kind: "unknown-event" }
  | { kind: "payload-not-object" }
  | { kind: "payload-value-invalid"; key: string }
  | { kind: "payload-too-long"; key: string }
  | { kind: "session-id-invalid" };

export type IngestResult<T> = { ok: true; value: T } | { ok: false; failure: IngestFailure };

const MAX_SESSION_ID = 200;
const MAX_PAYLOAD_VALUE = 2_000;

export function ingestUiEventUseCase(repositoryId: string, input: { type?: unknown; payload?: unknown; sessionId?: unknown }): IngestResult<JournalEvent> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  const { type, payload, sessionId } = input;
  if (!isUiJournalEventType(type)) {
    return { ok: false, failure: { kind: isEngineOwnedEventType(type) ? "engine-owned-event" : "unknown-event" } };
  }
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    return { ok: false, failure: { kind: "payload-not-object" } };
  }
  const scalars = (payload ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(scalars)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") continue;
    if (typeof value !== "string") return { ok: false, failure: { kind: "payload-value-invalid", key } };
    if (value.length > MAX_PAYLOAD_VALUE) return { ok: false, failure: { kind: "payload-too-long", key } };
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > MAX_SESSION_ID)) {
    return { ok: false, failure: { kind: "session-id-invalid" } };
  }
  return { ok: true, value: new Journal(repository.path, repository.index.repositoryId).append(type, scalars as JournalEvent["payload"], sessionId as string | undefined) };
}
