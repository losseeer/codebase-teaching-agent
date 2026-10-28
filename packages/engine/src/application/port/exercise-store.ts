/** 一道题的持久行（表 `exercise_cache`），绑定在一个仓上；存的形状由练习侧决定，这里只透传 JSON。 */
export interface ExerciseStore {
  /** 按作用域键取一行。 */
  get<T>(scope: string, kind: string, targetUnitId: string): T | undefined;
  /** 按题 id 取；同题跨作用域多行时取最近写入的那份。 */
  byId<T>(exerciseId: string): T | undefined;
  put(scope: string, kind: string, targetUnitId: string, stored: unknown): void;
}
