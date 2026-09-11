import type { CourseNode, TeachingPolicy, TutorMessage } from "@codebase-tutor/shared";

/** Builds bounded RAG context; later model providers consume this exact shape. */
export function assembleContext(node: CourseNode, policy: TeachingPolicy, history: TutorMessage[], maximumCharacters = 6000): string {
  const resolved = history.filter((message) => message.role === "assistant").slice(-4).map((message) => oneLineConclusion(message.content)).join("\n");
  const context = [
    `课程节点: ${node.title}`,
    `源码证据: ${node.anchors.map((anchor) => `${anchor.path}:${anchor.line}`).join(", ") || "无"}`,
    `摘要: ${node.summary}`,
    `风格约束: ${policy.constraints.join("；")}`,
    `最近已解决阶梯: ${resolved}`
  ].join("\n");
  return context.slice(0, maximumCharacters);
}

function oneLineConclusion(content: string): string {
  const sentence = content.replaceAll(/\s+/g, " ").split(/[。！？!?]/)[0] ?? content;
  return sentence.slice(0, 180);
}
