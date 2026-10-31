import type { DecompositionDepth, Pedagogy, TeachingPolicy, TutorSettings } from "./teaching-policy.js";

export const defaultTutorSettings: TutorSettings = { pedagogy: "socratic", depth: "macro" };

export function policyFor(settings: TutorSettings): TeachingPolicy {
  const pedagogy = settings.pedagogy === "socratic"
    ? ["在给出结论前先要求学习者说明推理", "每轮保留一个可验证的问题"]
    : settings.pedagogy === "explanatory"
      ? ["先给出带锚点的简短解释，再要求学习者复述证据", "不隐藏必要结论"]
      : ["把结论改写成可执行的观察任务", "要求学习者预测改变后的影响"];
  const depth = settings.depth === "macro"
    ? ["优先解释执行路径、模块边界和调用路径"]
    : ["优先解释函数输入、输出、守卫、边界和陷阱"];
  return { constraints: [...pedagogy, ...depth], pedagogy: settings.pedagogy, depth: settings.depth };
}

export function validateSettings(value: Partial<TutorSettings> | undefined): TutorSettings {
  const pedagogy: Pedagogy = value?.pedagogy === "explanatory" || value?.pedagogy === "practice" ? value.pedagogy : "socratic";
  const depth: DecompositionDepth = value?.depth === "micro" ? "micro" : "macro";
  return { pedagogy, depth };
}
