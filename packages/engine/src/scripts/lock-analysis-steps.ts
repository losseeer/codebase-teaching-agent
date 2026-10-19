/**
  重写提示词指纹锁：`pnpm analysis:lock`。
  只在「口径登记守卫」（`analysis-step.test.ts`）报红之后跑。翻 `contractVersion` 会让旧产物作废并按条重算
  （一条流程 ≈¥0.17、全仓摘要 ≈¥0.06），跑之前先确认那条改动值得。
  脚本本身不做判断，只做记录。
*/
import { writeLockedFingerprints, ANALYSIS_STEP_LOCK_FILE } from "../analysis-step.js";
import { loadedAnalysisStepCount } from "../analysis-steps.js";

const registered = loadedAnalysisStepCount();
const written = writeLockedFingerprints();
console.log(`已写入 ${ANALYSIS_STEP_LOCK_FILE}：${written} 个步骤（代码里登记了 ${registered} 个）`);
