import type { DecompositionDepth, Pedagogy, StyleLevel, TeachingPolicy, TutorSettings } from "@codebase-tutor/shared";

export const defaultTutorSettings: TutorSettings = { style: 50, pedagogy: "socratic", depth: "macro" };

export function policyFor(settingsOrStyle: TutorSettings | StyleLevel, overrides: Partial<Omit<TutorSettings, "style">> = {}): TeachingPolicy {
  const settings: TutorSettings = typeof settingsOrStyle === "number"
    ? { style: validateStyle(settingsOrStyle), pedagogy: overrides.pedagogy ?? defaultTutorSettings.pedagogy, depth: overrides.depth ?? defaultTutorSettings.depth }
    : validateSettings(settingsOrStyle);
  const label = settings.style >= 67 ? "通俗" : settings.style <= 33 ? "严肃" : "中性";
  const language = settings.style >= 67
    ? ["使用短句和常见术语", "先解释术语，再使用它", "一次只引导一个观察点", "不用未经解释的比喻或自造词"]
    : settings.style <= 33
      ? ["使用精确的工程术语", "要求指出数据流、控制流或不变量", "区分直接证据、间接线索和推测", "避免重复基础定义"]
      : ["准确使用代码术语", "将问题绑定到当前源码锚点", "明确区分事实与推断", "用简洁段落组织推理"];
  const pedagogy = settings.pedagogy === "socratic"
    ? ["在给出结论前先要求学习者说明推理", "每轮保留一个可验证的问题"]
    : settings.pedagogy === "explanatory"
      ? ["先给出带锚点的简短解释，再要求学习者复述证据", "不隐藏必要结论"]
      : ["把结论改写成可执行的观察任务", "要求学习者预测改变后的影响"];
  const depth = settings.depth === "macro"
    ? ["优先解释执行路径、模块边界和调用路径"]
    : ["优先解释函数输入、输出、守卫、边界和陷阱"];
  return { level: settings.style, label, constraints: [...language, ...pedagogy, ...depth], pedagogy: settings.pedagogy, depth: settings.depth };
}

export function validateStyle(value: unknown): StyleLevel {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return defaultTutorSettings.style;
  return Math.round(Math.max(0, Math.min(100, numeric)));
}

export function validateSettings(value: Partial<TutorSettings> | undefined): TutorSettings {
  const pedagogy: Pedagogy = value?.pedagogy === "explanatory" || value?.pedagogy === "practice" ? value.pedagogy : "socratic";
  const depth: DecompositionDepth = value?.depth === "micro" ? "micro" : "macro";
  return { style: validateStyle(value?.style), pedagogy, depth };
}
