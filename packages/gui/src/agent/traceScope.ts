import type { AgentScope } from "@codebase-tutor/contract";

const SCENE_SCOPE: Record<string, AgentScope> = {
  "teaching.turn": "teaching",
  "map.chat": "map",
  "practice.chat": "practice",
  "practice.generate": "practice"
};

/** 练习区的两类运行：出题与答疑。 */
const PRACTICE_AGENT: Record<string, string> = { "practice.generate": "出题", "practice.chat": "答疑" };

export function inScope(scene: string, scope: AgentScope): boolean {
  return SCENE_SCOPE[scene] === scope;
}

export function practiceAgentLabel(scene: string): string | undefined {
  return PRACTICE_AGENT[scene];
}
