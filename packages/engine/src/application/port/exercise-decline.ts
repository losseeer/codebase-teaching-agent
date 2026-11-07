/** 出题被拒的内部阶段码；只在用例层映射成对外错误码，不直接进 HTTP。 */
export class ExerciseDeclinedError extends Error {
  constructor(readonly stage: string, message: string, /** 主题没命中时给的可选替代主题词，供界面提示「换个主题试试」。 */ readonly suggestions: string[] = []) {
    super(message);
    this.name = "ExerciseDeclinedError";
  }
}
