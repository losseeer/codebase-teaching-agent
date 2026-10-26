import type { TutorSession, TutorSettings } from "@codebase-tutor/domain";
import { defaultTutorSettings, validateSettings } from "@codebase-tutor/domain";

import { id } from "@codebase-tutor/platform";

export function createSession(repositoryId: string, scopeRef: string, settings: Partial<TutorSettings> = defaultTutorSettings): TutorSession {
  const normalized = validateSettings(settings);
  return { id: id(), repositoryId, scopeRef, style: normalized.style, settings: normalized, messages: [], createdAt: new Date().toISOString() };
}
