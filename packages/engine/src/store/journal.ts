import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/shared";
import { id } from "../lib.js";

const eventTypes = new Set<JournalEventType>([
  "unit_mastered", "exercise_result", "hint_depth", "dependency_event",
  "style_shift", "teach_moment", "unassisted_test", "action_veto",
  "exercise_declined", "token_usage", "file_read"
]);

export class Journal {
  private readonly file: string;

  constructor(repositoryPath: string, readonly repositoryId: string) {
    const directory = join(repositoryPath, ".tutor");
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "journal.jsonl");
  }

  append(type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string): JournalEvent {
    if (!eventTypes.has(type)) throw new Error(`Unknown journal event: ${type}`);
    const event: JournalEvent = { id: id(), type, at: new Date().toISOString(), repositoryId: this.repositoryId, sessionId, payload };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }
}

export function readJournal(repositoryPath: string): JournalEvent[] {
  const file = join(repositoryPath, ".tutor", "journal.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as JournalEvent]; } catch { return []; }
  });
}
