import type { AgentScope } from "@codebase-tutor/contract";

const SCENE_SCOPE: Record<string, AgentScope> = {
  "teaching.turn": "teaching",
  "map.chat": "map",
  "practice.chat": "practice",
  "practice.generate": "practice"
};

export function inScope(scene: string, scope: AgentScope): boolean {
  return SCENE_SCOPE[scene] === scope;
}
