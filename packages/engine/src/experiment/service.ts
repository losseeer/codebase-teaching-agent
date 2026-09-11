import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExperimentConfig, ExperimentGroup, JournalEvent } from "@codebase-tutor/shared";
import { hash, id } from "../lib.js";
import { readJournal } from "../store/journal.js";

const experimentFile = (repositoryPath: string): string => join(repositoryPath, ".tutor", "experiment.json");

export function createExperiment(repositoryPath: string, repositoryId: string, name: string, participantId?: string): ExperimentConfig {
  const groups: ExperimentGroup[] = ["A_tutor", "B_direct_answer", "C_no_assistant"];
  const assignedGroup = participantId ? groups[Number.parseInt(hash(`${repositoryId}:${participantId}`).slice(0, 8), 16) % groups.length] : undefined;
  const config: ExperimentConfig = { id: id(), repositoryId, createdAt: new Date().toISOString(), name: name || "M1 三组对照", groups, participantId, assignedGroup };
  mkdirSync(join(repositoryPath, ".tutor"), { recursive: true });
  writeFileSync(experimentFile(repositoryPath), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function getExperiment(repositoryPath: string): ExperimentConfig | undefined {
  const file = experimentFile(repositoryPath);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as ExperimentConfig : undefined;
}

export function exportExperimentCsv(repositoryPath: string): string {
  const events = readJournal(repositoryPath);
  const header = "id,at,type,repository_id,session_id,payload\n";
  return header + events.map((event) => row(event)).join("\n");
}

function row(event: JournalEvent): string {
  return [event.id, event.at, event.type, event.repositoryId, event.sessionId ?? "", JSON.stringify(event.payload)].map(csv).join(",");
}

function csv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
