/** 重写提示词指纹锁（`pnpm analysis:lock`）：把已登记步骤的指纹写入锁文件。 */
import { writeLockedFingerprints, ANALYSIS_STEP_LOCK_FILE } from "../../src/analysis-step.js";
import { loadedAnalysisStepCount } from "../../src/analysis-steps.register.js";

const registered = loadedAnalysisStepCount();
const written = writeLockedFingerprints();
console.log(`已写入 ${ANALYSIS_STEP_LOCK_FILE}：${written} 个步骤（代码里登记了 ${registered} 个）`);
