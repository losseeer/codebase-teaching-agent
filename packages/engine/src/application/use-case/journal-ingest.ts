import type { JournalEvent } from "@codebase-tutor/domain";
import { isEngineOwnedEventType, isUiJournalEventType } from "@codebase-tutor/domain";
import { repositoryOr404 } from "../../infrastructure/composition-root.js";

/** 界面动作事件入账：只收 `UI_JOURNAL_EVENTS` 的成员，`payload` 仅标量，超长值与超长 `sessionId` 都拒。 */
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
  return { ok: true, value: repository.audit.append(type, scalars as JournalEvent["payload"], sessionId as string | undefined) };
}
