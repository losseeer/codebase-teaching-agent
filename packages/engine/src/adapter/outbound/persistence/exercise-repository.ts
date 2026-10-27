import type Database from "better-sqlite3";

/**
  一道练习题的持久行（表 `exercise_cache`）：题面、锚点与判分要用的参考答案存在同一行 JSON 里。
  这里只管「按作用域键存取一行」，不认缓存口径——那一格 `content_version` 由出题侧算好交进来
  （`exercises/exercises.ts` 的 `fileScope`：依赖文件哈希 + 提示词指纹 + 模型版本，代码族再挂 runner 指纹）。
  键的组成是出题的判断，住在出题那一侧；搬到这里就会变成两处定义、一处失真。
*/
export class ExerciseRepository {
  constructor(private readonly db: Database.Database) {}

  /** 按作用域键取（出题命中缓存走这条）。 */
  get<T>(repositoryId: string, contentVersion: string, kind: string, targetUnitId: string): T | undefined {
    const row = this.db.prepare("SELECT exercise_json FROM exercise_cache WHERE repository_id = ? AND content_version = ? AND kind = ? AND target_unit_id = ?")
      .get(repositoryId, contentVersion, kind, targetUnitId) as { exercise_json: string } | undefined;
    return row ? JSON.parse(row.exercise_json) as T : undefined;
  }

  /**
    按题 id 取（判分与讲评走这条：界面手里的只有 id）。
    同一道题可能躺在几个作用域键下（换模型、换 runner 各一份），取最近写的那一份——
    `created_at` 是写入时间而不是首次生成时间，与摘要表同一口径。
  */
  byId<T>(repositoryId: string, exerciseId: string): T | undefined {
    const row = this.db.prepare("SELECT exercise_json FROM exercise_cache WHERE repository_id = ? AND json_extract(exercise_json, '$.exercise.id') = ? ORDER BY created_at DESC LIMIT 1")
      .get(repositoryId, exerciseId) as { exercise_json: string } | undefined;
    return row ? JSON.parse(row.exercise_json) as T : undefined;
  }

  put(repositoryId: string, contentVersion: string, kind: string, targetUnitId: string, exercise: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO exercise_cache(repository_id, content_version, kind, target_unit_id, exercise_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(repositoryId, contentVersion, kind, targetUnitId, JSON.stringify(exercise), new Date().toISOString());
  }
}
