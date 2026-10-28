/**
  登记过口径的模块清单，只做副作用导入：新增一层时把它的模块加进来。
  产品路径不 import 这里。
*/
import "./summarizer/summary-provider.js";
import "./exercises/llm-generate.js";
import "./exercises/code-generate.js";
import { analysisSteps } from "./analysis-step.js";

/** 引用 `analysisSteps()`，避免上面的副作用导入被 tree-shaking 移除。 */
export function loadedAnalysisStepCount(): number {
  return analysisSteps().length;
}
