/**
  「哪些模块登记了口径」的清单，只做副作用导入：指纹守卫的加载入口，新增一层时把它的模块加进来即可。
  产品路径不 import 这里（会把全部分析模块拖进任何用到口径登记的地方）。
  漏加的后果有界：键仍只能由登记的步骤构造，只是该层的提示词没进这一轮的指纹基准。
*/
import "./flows/flow.js";
import "./coursetree/architecture.js";
import "./coursetree/entry-suggest.js";
import "./coursetree/llm-refine.js";
import "./summarizer/summary-provider.js";
import "./exercises/llm-generate.js";
import "./exercises/code-generate.js";
import { analysisSteps } from "./analysis-step.js";

/** 强制上面这些导入不被 tree-shaking 当成无用副作用丢掉，同时给调用方一个「确实加载过」的读数。 */
export function loadedAnalysisStepCount(): number {
  return analysisSteps().length;
}
