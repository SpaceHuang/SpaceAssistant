/** SQLite schema version; bump when DDL changes require migration steps. */
export const DB_SCHEMA_VERSION = 13

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

export const SCHEMA_META_KEYS = {
  schemaVersion: 'schema_version',
  migratedFromJsonAt: 'migrated_from_json_at',
  migratedFromJsonPath: 'migrated_from_json_path',
  legacyWorkspaceLayoutCleanedAt: 'legacy_workspace_layout_cleaned_at'
} as const
