import type { TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { defaultTutorSettings, validateSettings } from "@codebase-tutor/shared";
import { id } from "../ids.js";

export function createSession(repositoryId: string, scopeRef: string, settings: Partial<TutorSettings> = defaultTutorSettings): TutorSession {
  const normalized = validateSettings(settings);
  return { id: id(), repositoryId, scopeRef, style: normalized.style, settings: normalized, messages: [], createdAt: new Date().toISOString() };
}
