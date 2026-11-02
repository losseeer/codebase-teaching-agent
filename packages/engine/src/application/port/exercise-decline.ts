/** 出题被拒的内部阶段码；只在用例层映射成对外错误码，不直接进 HTTP。 */
export class ExerciseDeclinedError extends Error {
  constructor(readonly stage: string, message: string) {
    super(message);
    this.name = "ExerciseDeclinedError";
  }
}
