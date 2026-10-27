/**
  一道题的持久行（表 `exercise_cache`），**绑定在一个仓上**（适配器闭包掉库句柄与仓 id）。
  存的是什么形状由练习侧决定：这里只透传一坨 JSON。作用域键（`scope`）的组成也在练习侧算，
  搬进存储就成两处定义、一处失真。
*/
export interface ExerciseStore {
  /** 按作用域键取（出题命中缓存走这条）。 */
  get<T>(scope: string, kind: string, targetUnitId: string): T | undefined;
  /** 按题 id 取（判分与讲评走这条：界面手里只有 id）。同题跨作用域多行时取最近写入那份。 */
  byId<T>(exerciseId: string): T | undefined;
  put(scope: string, kind: string, targetUnitId: string, stored: unknown): void;
}
