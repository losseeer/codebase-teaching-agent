/** 产物库的唯一形状声明：建表与列对账都读这一份；已存在的表缺列由列对账补。 */
export const DATABASE_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_state (
        repository_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        index_json TEXT,
        estimate_json TEXT,
        analysis_json TEXT,
        settings_json TEXT
      );
      -- 文件级摘要（L1）：一行 = 一个缓存键。
      CREATE TABLE IF NOT EXISTS summaries (
        cache_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- 出题缓存：一行 = 一道题的成品与标准答案。
      CREATE TABLE IF NOT EXISTS exercise_cache (
        repository_id TEXT NOT NULL,
        content_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_unit_id TEXT NOT NULL,
        exercise_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, content_version, kind, target_unit_id)
      );
      CREATE TABLE IF NOT EXISTS review_schedule (
        repository_id TEXT NOT NULL,
        exercise_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, exercise_id)
      );
      -- 画布上的一张图：读写口在 persistence/diagram-repository.ts。
      CREATE TABLE IF NOT EXISTS diagram (
        repository_id TEXT NOT NULL,
        diagram_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(repository_id, diagram_id)
      );
      -- 会话列表：settings_json 是这一轮的设置快照。
      CREATE TABLE IF NOT EXISTS chat_session (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_ref TEXT,
        exercise_id TEXT,
        title TEXT NOT NULL,
        state_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_session(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        error TEXT
      );
      -- 静态产物层：控制流、数据流、类型关系、注册与配置索引，一文件一行。
      CREATE TABLE IF NOT EXISTS static_fact (
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY(repository_id, kind, path)
      );
      -- 回合检查点：一行 = 一个工具轮结束时的快照，按线程寻址。
      -- 过 TTL 由读侧顺手清。
      CREATE TABLE IF NOT EXISTS turn_checkpoint (
        thread_id TEXT NOT NULL,
        scene TEXT NOT NULL,
        round INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        prompt_hash TEXT,
        stopped_reason TEXT,
        pending_tool_call_id TEXT,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, scene, round)
      );
      CREATE INDEX IF NOT EXISTS chat_message_session ON chat_message(session_id, created_at);
      CREATE INDEX IF NOT EXISTS chat_session_repo ON chat_session(repository_id, scope, deleted_at);
`;
