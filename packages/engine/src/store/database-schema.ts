/**
  产物库的唯一形状声明：migrate() 的 db.exec 与 reconcileColumns() 的列对账都从这里读。
  CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，声明本身在存量库上不成立——列对账是补这一步的机制。
  */
export const DATABASE_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_state (
        repository_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        index_json TEXT,
        -- 历史列：旧课程树产物。2026-10-20 起不再写入、不再读取；历史行留着，删列要迁移而收益是零。
        course_json TEXT,
        estimate_json TEXT,
        analysis_json TEXT,
        settings_json TEXT
      );
      CREATE TABLE IF NOT EXISTS summaries (
        cache_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
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
      -- 【已退役】LLM 产物的通用缓存表：读它写它的两个消费方（流程层与推荐入口层）已经撤掉，
      -- 表与历史行留着：里面的行是付过费算出来的产物，删表等于把已花的钱抹掉，而留着不读的成本是零
      -- （同一处置见上面的 diagram_artifact 与 repository_state 那几列）。
      CREATE TABLE IF NOT EXISTS layer_cache (
        cache_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      -- 【已退役，2026-10-18】「agent 重绘后待替换」那张过渡图住的表：宏观设计改成图库 + 自由画布之后，
      -- 结构改动直接落在下面的 diagram 表上，pending/preview 这套三态机没有了。
      -- 表与历史行都留着：老仓里可能还躺着一份用户点过头的判断，删表等于把他的记录毁了，
      -- 而留着不读的成本是零（同一道理见上面 repository_state 那几列的注释）。
      CREATE TABLE IF NOT EXISTS diagram_artifact (
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        purpose TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY(repository_id, kind, status)
      );
      -- 画布上的一张图（store/diagrams.ts 是唯一读写口）。一行 = 一张图，一个仓可以有很多张。
      -- 图是用户资产，所以自己一张表：按龄清空的缓存语义（上面那张 layer_cache）不适用在这里。
      -- 名字/来源/时间戳单独立列：图库列表只要这几格，不必把整张图的 JSON 解析一遍。
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
      CREATE TABLE IF NOT EXISTS chat_session (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_ref TEXT,
        -- 历史列：旧版课程节点 id。新行恒 NULL，读侧不再使用。
        course_node_id TEXT,
        exercise_id TEXT,
        title TEXT NOT NULL,
        -- 问答线程的设置快照 {settings}（map/practice 为 NULL）。
        -- 2026-10-14 撤掉教学状态机后这里不再存 stage/fallbackCount，只剩「下一轮接着用哪套设置」。
        -- 这些值过去靠 journal 的 hint_depth/style_shift 重放推出（restore.ts），现在直接住在产品数据线里。
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
        -- 教学阶段戳：状态机时代的遗留列，2026-10-14 起不再写入也不再读；
        -- 列留着不删——tutor.db 是随仓可带走的东西，历史行里的值得在，删列要迁移而收益是零。
        stage TEXT,
        error TEXT
      );
      -- 静态产物层（2026-10-19）：控制流图、数据流、类型关系、注册与配置索引，按文件一行。
      -- 为什么不进 repository_state.analysis_json：那一列已经是大仓里最重的一块，而且它的指纹
      -- （backendStamp）参与宏观润色的复用判定——把新产物塞进去等于每加一类分析就翻一次全仓的键。
      -- 为什么不进按龄清空的缓存表：这里的东西是确定性重算的，只要源码没改就一直有效，
      -- 被一次无关的清理干掉就得白重算一遍。
      -- 一文件一行而不是整仓一行：读侧只取要的那几个文件，不必把整仓的图解析一遍。
      CREATE TABLE IF NOT EXISTS static_fact (
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY(repository_id, kind, path)
      );
      -- 回合检查点（照 LangGraph 的 checkpoint 语义）：一行 = 一个 super-step（一次工具轮）结束时的状态快照。
      -- 按线程寻址：续跑要问的就是「这个线程上次走到第几轮」；input_hash 保证只有同一个问题才接得上，
      -- 换一句提问去复用别人的中间状态等于答非所问。
      -- 正常收尾与用户主动停止都删行——停止按作废收尾（见 journal 的 turn_aborted），替他续跑是违背他的意图；
      -- 留着的行就是「进程没了/抛异常」的残局，下一次同线程同问题的请求据此接上，已经读到的源码不必再付一遍。
      -- 保留策略：按 updated_at 过 TTL 清（读侧顺手清），检查点膨胀是 LangGraph 同款已知代价。
      CREATE TABLE IF NOT EXISTS turn_checkpoint (
        thread_id TEXT NOT NULL,
        scene TEXT NOT NULL,
        round INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        stopped_reason TEXT,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, scene, round)
      );
      CREATE INDEX IF NOT EXISTS chat_message_session ON chat_message(session_id, created_at);
      CREATE INDEX IF NOT EXISTS chat_session_repo ON chat_session(repository_id, scope, deleted_at);
`;
