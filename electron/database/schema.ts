/** SQLite schema version; bump when DDL changes require migration steps. */
export const DB_SCHEMA_VERSION = 16

export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configs (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  llm_service_id TEXT,
  temperature REAL NOT NULL,
  max_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  skills_state TEXT NOT NULL,
  metadata TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  work_dir_profile_id TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_use TEXT,
  tool_calls TEXT,
  thinking TEXT,
  content_segments TEXT,
  skill_hints TEXT,
  attachments TEXT,
  images_delivered_to_api INTEGER,
  status TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  sequence INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_history (
  id TEXT PRIMARY KEY NOT NULL,
  query TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_usages (
  session_id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);
CREATE INDEX IF NOT EXISTS idx_sessions_work_dir_profile ON sessions(work_dir_profile_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

`

/**
 * v3 → v4：工具确认机制框架 —— 决策缓存表 + 用户规则覆盖表。
 * 用 CREATE TABLE IF NOT EXISTS 保证幂等（v4 升级与全新库均安全）。
 */
export const MIGRATION_V4_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS decision_cache (
  id TEXT PRIMARY KEY NOT NULL,
  key_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  lane TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decision_cache_key ON decision_cache(key_json);

CREATE TABLE IF NOT EXISTS policy_rules (
  rule_id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const MIGRATION_V5_TURN_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_session_state ON turns(session_id, state);
`

export const MIGRATION_V6_TURN_CHECKPOINT_SQL = `
ALTER TABLE turns ADD COLUMN user_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE turns ADD COLUMN context_boundary_sequence INTEGER;
ALTER TABLE turns ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turns ADD COLUMN outcome TEXT;
ALTER TABLE turns ADD COLUMN usage_json TEXT;
`

export const MIGRATION_V7_QUEUE_RECEIPT_SQL = `
CREATE TABLE IF NOT EXISTS queue_input_requests (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  queued_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_queue_input_requests_message ON queue_input_requests(queued_message_id);
`

export const MIGRATION_V8_TURN_START_TOKEN_SQL = `
ALTER TABLE turns ADD COLUMN start_token TEXT;
`

export const MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL = `
ALTER TABLE turns ADD COLUMN error_json TEXT;
ALTER TABLE turns ADD COLUMN intent_fingerprint TEXT;
`

export const MIGRATION_V10_TURN_TERMINAL_USAGE_SQL = `
ALTER TABLE turns ADD COLUMN terminal_usage_json TEXT;
`

export const MIGRATION_V11_TURN_CONTEXT_SQL = `
ALTER TABLE turns ADD COLUMN exclude_message_ids_json TEXT NOT NULL DEFAULT '[]';
`

export const MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL = `
ALTER TABLE turns ADD COLUMN execution_config_json TEXT;
`

/** 路由上下文的 assistant 资格及 user 锚点查询均按 session 关联 turn。 */
export const MIGRATION_V13_TURN_ROUTING_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_turns_session_assistant_state
  ON turns(session_id, assistant_message_id, state);
`

/**
 * 偏差 7：会话归属与可见性成为 sessions 的独立维度。
 * 存量行默认 user/primary（行为不变）；IM 来源会话（metadata.source ∈ feishu/wechat）按创建特征回填 remote。
 */
export const MIGRATION_V14_SESSION_OWNERSHIP_SQL = `
ALTER TABLE sessions ADD COLUMN ownership TEXT NOT NULL DEFAULT 'user';
ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'primary';
`

/** 归属回填：IM 创建的存量会话按 metadata.source 特征标记为 remote。
 *  json_valid 防护：损坏/篡改的 metadata 不得阻断迁移（该行保持默认 user，评审观察项）。 */
export const MIGRATION_V14_SESSION_OWNERSHIP_BACKFILL_SQL = `
UPDATE sessions SET ownership = 'remote'
  WHERE json_valid(metadata)
    AND json_extract(metadata, '$.source') IN ('feishu', 'wechat');
`

/**
 * P4 管家任务表：任务定义 + 运行记录。
 * client_id 唯一幂等键（`${taskId}:${scheduledFor}`）防 tick 重入 / 双投递；
 * 手动触发用 `${taskId}:manual:${requestId}`。
 */
export const MIGRATION_V15_BUTLER_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS automation_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  delivery_pref TEXT NOT NULL DEFAULT 'desktop',
  delivery_target TEXT,
  model_override TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER,
  next_run_at INTEGER
);

CREATE TABLE IF NOT EXISTS automation_task_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL DEFAULT 'schedule',
  scheduled_for INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  session_id TEXT,
  result_summary TEXT,
  usage_json TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_task ON automation_task_runs(task_id, scheduled_for);
`

/**
 * Agent Token 用量统计（v16）：逐步明细 + 按 Turn 汇总两张事实表。
 * 不对 sessions 建外键 —— 会话删除后统计行必须保留（需求 §9.1）。
 * UNIQUE(session_id, turn_id, step_id) 保证重试 / 恢复场景幂等（重复写为覆盖）。
 */
export const MIGRATION_V16_USAGE_STATS_SQL = `
CREATE TABLE IF NOT EXISTS usage_step_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  model TEXT,
  llm_service_id TEXT,
  app_version TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_semantics TEXT,
  source TEXT NOT NULL DEFAULT 'api',
  UNIQUE(session_id, turn_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_step_day ON usage_step_facts(day);
CREATE INDEX IF NOT EXISTS idx_usage_step_session_day ON usage_step_facts(session_id, day);
CREATE INDEX IF NOT EXISTS idx_usage_step_model_day ON usage_step_facts(model, day);
CREATE INDEX IF NOT EXISTS idx_usage_step_app_version_day ON usage_step_facts(app_version, day);

CREATE TABLE IF NOT EXISTS usage_turn_facts (
  turn_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  model TEXT,
  llm_service_id TEXT,
  app_version TEXT,
  step_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  tool_error_count INTEGER NOT NULL DEFAULT 0,
  tool_skipped_count INTEGER NOT NULL DEFAULT 0,
  outcome TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_turn_day ON usage_turn_facts(day);
CREATE INDEX IF NOT EXISTS idx_usage_turn_session_day ON usage_turn_facts(session_id, day);
CREATE INDEX IF NOT EXISTS idx_usage_turn_model_day ON usage_turn_facts(model, day);
CREATE INDEX IF NOT EXISTS idx_usage_turn_app_version_day ON usage_turn_facts(app_version, day);
`

export const SCHEMA_META_KEYS = {
  schemaVersion: 'schema_version',
  migratedFromJsonAt: 'migrated_from_json_at',
  migratedFromJsonPath: 'migrated_from_json_path',
  legacyWorkspaceLayoutCleanedAt: 'legacy_workspace_layout_cleaned_at',
  /** 用量统计一次性历史回填完成时间（C7）；缺失时启动重试，成功即写。 */
  usageStatsBackfillAt: 'usage_stats_backfill_at'
} as const
