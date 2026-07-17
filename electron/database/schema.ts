/** SQLite schema version; bump when DDL changes require migration steps. */
export const DB_SCHEMA_VERSION = 2

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

export const ARTIFACT_V2_SQL = `
CREATE TABLE IF NOT EXISTS session_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  work_dir_profile_id TEXT NOT NULL,
  workspace_root_real TEXT NOT NULL,
  package_id TEXT,
  container TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  stage TEXT,
  canonical_path TEXT NOT NULL,
  path_identity_key TEXT NOT NULL,
  requested_path TEXT,
  path_source TEXT NOT NULL,
  path_evidence_id TEXT,
  path_decision_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (path_source = 'user' AND path_evidence_id IS NOT NULL AND path_decision_id IS NULL) OR
    (path_source = 'user-decision' AND path_evidence_id IS NULL AND path_decision_id IS NOT NULL) OR
    (path_source IN ('project-convention', 'agent-default', 'system-assigned')
      AND path_evidence_id IS NULL AND path_decision_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS artifact_references (
  artifact_id TEXT PRIMARY KEY NOT NULL REFERENCES session_artifacts(id) ON DELETE CASCADE,
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  access_note TEXT,
  license_note TEXT
);

CREATE TABLE IF NOT EXISTS artifact_operations (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES session_artifacts(id),
  operation TEXT NOT NULL,
  move_mode TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  temp_path TEXT,
  target_existed INTEGER NOT NULL DEFAULT 0,
  target_backup_path TEXT,
  target_backup_identity TEXT,
  target_original_identity TEXT,
  target_original_size INTEGER,
  target_original_digest TEXT,
  expected_size INTEGER,
  expected_digest TEXT,
  temp_identity TEXT,
  phase TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_active_path
  ON session_artifacts(session_id, path_identity_key)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_artifacts_session_container
  ON session_artifacts(session_id, container, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_package
  ON session_artifacts(package_id, role, status);
`

export const SCHEMA_META_KEYS = {
  schemaVersion: 'schema_version',
  migratedFromJsonAt: 'migrated_from_json_at',
  migratedFromJsonPath: 'migrated_from_json_path'
} as const
