/** SQLite schema version; bump when DDL changes require migration steps. */
export const DB_SCHEMA_VERSION = 1

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

export const SCHEMA_META_KEYS = {
  schemaVersion: 'schema_version',
  migratedFromJsonAt: 'migrated_from_json_at',
  migratedFromJsonPath: 'migrated_from_json_path'
} as const
