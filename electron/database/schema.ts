/** SQLite schema version; bump when DDL changes require migration steps. */
export const DB_SCHEMA_VERSION = 49

export const MESSAGE_CONTENT_STORAGE_STATES = ['legacy', 'canonical-backed-dual-write', 'canonical-backed-only'] as const
export const SESSION_CONTENT_CLEANUP_STATES = ['retained', 'write-stopped', 'pending', 'complete'] as const

function sqlTextEnum(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(',')
}

export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS scope_versions (
  scope TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL
);

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
  work_dir_profile_id TEXT,
  fixed_work_dir TEXT,
  generation TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_storage_state TEXT NOT NULL DEFAULT 'legacy' CHECK(content_storage_state IN (${sqlTextEnum(MESSAGE_CONTENT_STORAGE_STATES)})),
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
CREATE INDEX IF NOT EXISTS idx_sessions_work_dir_profile ON sessions(work_dir_profile_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS confirmation_submissions (
  submission_id TEXT PRIMARY KEY NOT NULL,
  confirm_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL,
  memory TEXT NOT NULL,
  status TEXT NOT NULL,
  event_id TEXT,
  history_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS confirmation_commit_audits (
  submission_id TEXT PRIMARY KEY NOT NULL REFERENCES confirmation_submissions(submission_id) ON DELETE CASCADE,
  confirm_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL,
  memory TEXT NOT NULL,
  committed_at INTEGER NOT NULL
);

`

/** v27 → v28: durable idempotent user continuation-intent acceptance. */
export const MIGRATION_V28_CONTINUATION_INTENTS_SQL = `
CREATE TABLE IF NOT EXISTS continuation_intents (
  request_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  raw_text TEXT NOT NULL, attachments_json TEXT NOT NULL, intent_kind TEXT NOT NULL, route TEXT NOT NULL,
  source_invocation_id TEXT, source_turn_id TEXT, source_sequence INTEGER, target_id TEXT, status TEXT NOT NULL,
  rejection_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_continuation_intents_session ON continuation_intents(session_id, created_at);
`

/** v31 → v32: queued continuation carries its authoritative source context into turn claim. */
export const MIGRATION_V32_CONTINUATION_QUEUE_CONTEXT_SQL = `
ALTER TABLE continuation_intents ADD COLUMN continuation_context_json TEXT;
`

export const MIGRATION_V33_AUTOMATION_TASK_CONFIG_SQL = `
ALTER TABLE automation_tasks ADD COLUMN work_dir TEXT;
ALTER TABLE automation_tasks ADD COLUMN model_id TEXT;
ALTER TABLE automation_tasks ADD COLUMN model_service_id TEXT;
ALTER TABLE automation_tasks ADD COLUMN reasoning_effort TEXT;
ALTER TABLE automation_task_runs ADD COLUMN config_snapshot_json TEXT;
ALTER TABLE usage_step_facts ADD COLUMN model_id TEXT;
ALTER TABLE usage_step_facts ADD COLUMN provider_model_name TEXT;
ALTER TABLE usage_step_facts ADD COLUMN route_identity TEXT;
ALTER TABLE usage_turn_facts ADD COLUMN model_id TEXT;
ALTER TABLE usage_turn_facts ADD COLUMN provider_model_name TEXT;
ALTER TABLE usage_turn_facts ADD COLUMN route_identity TEXT;
`

/** v17 → v18：确认提交 receipt 绑定可信 session / generation / revision。 */
export const MIGRATION_V18_CONFIRMATION_COMMIT_IDENTITY_SQL = `
ALTER TABLE confirmation_submissions ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE confirmation_submissions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE confirmation_submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE confirmation_commit_audits ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE confirmation_commit_audits ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE confirmation_commit_audits ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
UPDATE confirmation_submissions SET session_id = owner_id WHERE session_id = '';
UPDATE confirmation_submissions SET revision = expected_revision WHERE revision = 1 AND expected_revision <> 1;
UPDATE confirmation_commit_audits SET session_id = (SELECT session_id FROM confirmation_submissions WHERE confirmation_submissions.submission_id = confirmation_commit_audits.submission_id) WHERE session_id = '';
UPDATE confirmation_commit_audits SET generation = (SELECT generation FROM confirmation_submissions WHERE confirmation_submissions.submission_id = confirmation_commit_audits.submission_id);
UPDATE confirmation_commit_audits SET revision = (SELECT revision FROM confirmation_submissions WHERE confirmation_submissions.submission_id = confirmation_commit_audits.submission_id);
`

/** v18 → v19：Agent SDK canonical history streams and idempotent events. */
export const MIGRATION_V19_AGENT_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS agent_history_streams (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0)
);

CREATE TABLE IF NOT EXISTS agent_history_events (
  invocation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(invocation_id, sequence),
  UNIQUE(invocation_id, event_id),
  UNIQUE(invocation_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_history_events_turn
  ON agent_history_events(invocation_id, turn_id, sequence);
`

/** v19 → v20：bind canonical invocation streams to their owning application session. */
export const MIGRATION_V20_AGENT_HISTORY_SESSION_SQL = `
ALTER TABLE agent_history_streams ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_history_streams_session
  ON agent_history_streams(session_id, invocation_id);
`

/** v20 → v21：backfill legacy invocation ownership only from an unambiguous turn receipt. */
export const MIGRATION_V21_AGENT_HISTORY_SESSION_BACKFILL_SQL = `
WITH owner_candidates AS (
  SELECT request_id AS invocation_id, session_id
  FROM turns
  WHERE trim(session_id) <> ''
  UNION
  SELECT invocation_id,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.sessionId') END AS session_id
  FROM agent_history_events
  WHERE kind = 'session-input-committed'
    AND sequence = 1
    AND json_valid(payload_json) = 1
    AND json_type(payload_json, '$.sessionId') = 'text'
    AND trim(json_extract(payload_json, '$.sessionId')) <> ''
    AND json_type(payload_json, '$.messageId') = 'text'
    AND trim(json_extract(payload_json, '$.messageId')) <> ''
    AND json_extract(payload_json, '$.role') = 'user'
    AND json_type(payload_json, '$.inputFingerprint') = 'text'
    AND trim(json_extract(payload_json, '$.inputFingerprint')) <> ''
  UNION
  SELECT invocation_id,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.sessionLedger.location.sessionId') END AS session_id
  FROM agent_history_events
  WHERE kind IN ('transcript-compacted', 'invocation-completed', 'invocation-failed', 'invocation-interrupted')
    AND json_valid(payload_json) = 1
    AND json_type(payload_json, '$.sessionLedger.location.sessionId') = 'text'
    AND trim(json_extract(payload_json, '$.sessionLedger.location.sessionId')) <> ''
    AND json_type(payload_json, '$.sessionLedger.location.workDir') = 'text'
    AND trim(json_extract(payload_json, '$.sessionLedger.location.workDir')) <> ''
    AND json_type(payload_json, '$.sessionLedger.location.createdAt') IN ('integer', 'real')
), unique_owners AS (
  SELECT invocation_id, MIN(session_id) AS session_id
  FROM owner_candidates
  GROUP BY invocation_id
  HAVING COUNT(DISTINCT session_id) = 1
)
UPDATE agent_history_streams
SET session_id = (SELECT session_id FROM unique_owners WHERE unique_owners.invocation_id = agent_history_streams.invocation_id)
WHERE session_id IS NULL
  AND EXISTS (SELECT 1 FROM unique_owners WHERE unique_owners.invocation_id = agent_history_streams.invocation_id);
`

/** v21 → v22: distinguish new atomic input commitments from legacy turn receipts. */
export const MIGRATION_V22_TURN_INPUT_HISTORY_VERSION_SQL = `
ALTER TABLE turns ADD COLUMN accepted_input_history_version INTEGER NOT NULL DEFAULT 0 CHECK(accepted_input_history_version >= 0);
`

/** v22 → v23：durable driver delivery intents and append-only transitions. */
export const MIGRATION_V23_DRIVER_DELIVERY_SQL = `
CREATE TABLE IF NOT EXISTS driver_deliveries (
  delivery_id TEXT NOT NULL,
  target TEXT NOT NULL,
  preference_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','deferred','delivering','delivered','failed','expired','superseded','delivery-uncertain')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY(delivery_id, target)
);
CREATE INDEX IF NOT EXISTS idx_driver_deliveries_status_created ON driver_deliveries(status, created_at);
CREATE TABLE IF NOT EXISTS driver_delivery_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_driver_delivery_events_intent ON driver_delivery_events(delivery_id, target, sequence);
`

/** v23 → v24：versioned session transcript and cross-process turn admission claims. */
export const MIGRATION_V24_SESSION_TRANSCRIPT_SQL = `
CREATE TABLE IF NOT EXISTS session_transcript_checkpoints (
  session_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  last_turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','commit_uncertain','blocked')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_transcript_entries (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn_id),
  UNIQUE(session_id, version)
);
CREATE TABLE IF NOT EXISTS session_execution_claims (
  session_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','executing','commit_uncertain')),
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/** v24 → v25：durable FIFO queue entries for session execution admission. */
export const MIGRATION_V25_SESSION_EXECUTION_QUEUE_SQL = `
CREATE TABLE IF NOT EXISTS session_execution_queue (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','executing','commit_uncertain')),
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_session_execution_queue_order ON session_execution_queue(session_id, status, enqueued_at, turn_id);
`

/** v25 → v26：auditable operator resolutions for uncertain session transcript commits. */
export const MIGRATION_V26_SESSION_TRANSCRIPT_RECONCILIATION_SQL = `
CREATE TABLE IF NOT EXISTS session_transcript_reconciliations (
  resolution_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  resolved_version INTEGER NOT NULL,
  resolution TEXT NOT NULL CHECK(resolution IN ('commit-reviewed')),
  operator_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_transcript_reconciliations_session ON session_transcript_reconciliations(session_id, resolved_version);
`

/** v26 → v27：durable immutable AcceptedTurn identity and request mapping. */
export const MIGRATION_V27_ACCEPTED_TURN_CONTEXT_SQL = `
CREATE TABLE IF NOT EXISTS accepted_turn_contexts (
  turn_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  accepted_turn_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_accepted_turn_contexts_request ON accepted_turn_contexts(request_id, session_id);
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

/** v28: 当前 SDK usage step 的可选内容归因快照；历史精确 usage 保持原值。 */
export const MIGRATION_V28_USAGE_ATTRIBUTION_SQL = `
ALTER TABLE usage_step_facts ADD COLUMN system_tokens INTEGER;
ALTER TABLE usage_step_facts ADD COLUMN tools_tokens INTEGER;
ALTER TABLE usage_step_facts ADD COLUMN message_tokens INTEGER;
ALTER TABLE usage_step_facts ADD COLUMN estimator_version TEXT;
ALTER TABLE usage_step_facts ADD COLUMN attribution_json TEXT;
ALTER TABLE usage_turn_facts ADD COLUMN tool_attribution_json TEXT;
`

/** v29: explicit, idempotently claimed continuation checkpoints. */
export const MIGRATION_V29_CONTINUATIONS_SQL = `
CREATE TABLE IF NOT EXISTS agent_continuations (
  continuation_id TEXT PRIMARY KEY NOT NULL,
  source_invocation_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  checkpoint_sequence INTEGER NOT NULL CHECK(checkpoint_sequence > 0),
  checkpoint_sha256 TEXT NOT NULL CHECK(length(checkpoint_sha256) = 64),
  request_idempotency_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  frozen_config_json TEXT NOT NULL,
  frozen_config_sha256 TEXT NOT NULL CHECK(length(frozen_config_sha256) = 64),
  target_invocation_id TEXT NOT NULL UNIQUE,
  target_turn_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled','interrupted','unknown_side_effect')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_invocation_id, checkpoint_sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_continuations_source ON agent_continuations(source_invocation_id, checkpoint_sequence);
`

/** v30: persist the target Turn credential so continuation retries retain one identity across restarts. */
export const MIGRATION_V30_CONTINUATION_START_TOKEN_SQL = `
ALTER TABLE agent_continuations ADD COLUMN target_start_token TEXT NOT NULL DEFAULT '';
`

/** v30 → v31: durable per-projection repair queue and resumable legacy classification cursor. */
export const MIGRATION_V31_CANONICAL_PROJECTION_REPAIRS_SQL = `
DROP INDEX IF EXISTS idx_messages_content;
CREATE TABLE IF NOT EXISTS canonical_projection_repairs (
  repair_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT,
  invocation_id TEXT NOT NULL,
  repair_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  updated_at INTEGER NOT NULL,
  UNIQUE(invocation_id, repair_kind, target_key)
);
CREATE INDEX IF NOT EXISTS idx_canonical_projection_repairs_pending
  ON canonical_projection_repairs(status, updated_at, repair_id);
CREATE TABLE IF NOT EXISTS canonical_projection_repair_migration (
  migration_key TEXT PRIMARY KEY NOT NULL,
  after_invocation_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO canonical_projection_repair_migration(migration_key, after_invocation_id, status, updated_at)
VALUES('legacy-classification-v1', NULL, 'pending', 0);
`

/** v31 → v32 cursor tables; created even in minimal migration fixtures without History tables. */
export const MIGRATION_V32_AGENT_HISTORY_CURSOR_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS agent_history_commit_cursor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_event_cursor (
  session_id TEXT PRIMARY KEY NOT NULL,
  next_seq INTEGER NOT NULL CHECK(next_seq >= 0)
);
CREATE TABLE IF NOT EXISTS canonical_session_projection_cache (
  session_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  cache_version INTEGER NOT NULL,
  session_generation TEXT NOT NULL,
  session_seq INTEGER NOT NULL,
  commit_order INTEGER NOT NULL,
  watermark_event_id TEXT,
  watermark_invocation_id TEXT,
  event_count INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, cache_key)
);
`

/** v33 → v34: version projection cache records independently from DB schema. */
export const MIGRATION_V34_CANONICAL_SESSION_CACHE_VERSION_SQL = `
ALTER TABLE canonical_session_projection_cache ADD COLUMN cache_version INTEGER NOT NULL DEFAULT 0;
DELETE FROM canonical_session_projection_cache WHERE cache_version <> 1;
`

/** v34 → v35：compact receipts make transcript snapshot retries auditable. */
export const MIGRATION_V35_SESSION_TURN_COMMIT_RECEIPTS_SQL = `
CREATE TABLE IF NOT EXISTS session_turn_commit_receipts (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  next_version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  event_start INTEGER,
  event_end INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn_id),
  UNIQUE(session_id, next_version)
);
`

/** v35 → v36：fence accepted turns while transcript projections are being settled/recovered. */
export const MIGRATION_V36_SESSION_TRANSCRIPT_COMMIT_STATE_SQL = `
DROP INDEX IF EXISTS idx_session_execution_queue_order;
ALTER TABLE session_execution_claims RENAME TO session_execution_claims_v35;
CREATE TABLE session_execution_claims (
  session_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')),
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO session_execution_claims SELECT * FROM session_execution_claims_v35;
DROP TABLE session_execution_claims_v35;

ALTER TABLE session_execution_queue RENAME TO session_execution_queue_v35;
CREATE TABLE session_execution_queue (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')),
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn_id)
);
INSERT INTO session_execution_queue SELECT * FROM session_execution_queue_v35;
DROP TABLE session_execution_queue_v35;
CREATE INDEX idx_session_execution_queue_order ON session_execution_queue(session_id, status, enqueued_at, turn_id);
`

/** v36 → v37: exact L2 transcript validation grants a fast-page eligibility marker; any message mutation revokes it. */
export const MIGRATION_V37_SESSION_PROJECTION_ELIGIBILITY_SQL = `
CREATE TABLE IF NOT EXISTS canonical_session_projection_eligibility (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation TEXT NOT NULL,
  validated_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS invalidate_session_projection_after_message_insert
AFTER INSERT ON messages BEGIN
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_projection_after_message_update
AFTER UPDATE ON messages BEGIN
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_projection_after_message_delete
AFTER DELETE ON messages BEGIN
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=OLD.session_id;
END;
`

/** v37 → v38: independent API fence, additive per-session rollout state, and explicit message body storage state. */
export const MIGRATION_V38_SESSION_CONTENT_CUTOVER_SQL = `
CREATE TABLE IF NOT EXISTS canonical_session_projection_eligibility (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation TEXT NOT NULL,
  validated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS canonical_session_api_context_eligibility (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation TEXT NOT NULL,
  skeleton_revision INTEGER NOT NULL,
  canonical_session_seq INTEGER NOT NULL,
  canonical_commit_order INTEGER NOT NULL,
  watermark_event_id TEXT,
  watermark_invocation_id TEXT,
  validated_at INTEGER NOT NULL,
  protocol_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_message_content_cutover (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation TEXT NOT NULL,
  message_revision INTEGER NOT NULL DEFAULT 0,
  api_read_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(api_read_mode IN ('legacy','canonical','revalidation-required')),
  write_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(write_mode IN ('legacy','dual-write','canonical')),
  cleanup_state TEXT NOT NULL DEFAULT 'retained' CHECK(cleanup_state IN ('retained','pending','complete')),
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_message_content_cleanup_progress (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation TEXT NOT NULL,
  session_message_revision INTEGER NOT NULL,
  canonical_session_seq INTEGER NOT NULL,
  canonical_commit_order INTEGER NOT NULL,
  watermark_event_id TEXT,
  watermark_invocation_id TEXT,
  next_sequence INTEGER NOT NULL DEFAULT 0 CHECK(next_sequence >= 0),
  after_message_id TEXT,
  cleaned_message_count INTEGER NOT NULL DEFAULT 0 CHECK(cleaned_message_count >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  scan_complete INTEGER NOT NULL DEFAULT 0 CHECK(scan_complete IN (0,1)),
  source_manifest_sha256 TEXT,
  verified_at INTEGER,
  verification_sha256 TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO session_message_content_cutover(session_id,session_generation,message_revision,api_read_mode,write_mode,cleanup_state,updated_at)
SELECT id,generation,0,'legacy','legacy','retained',unixepoch()*1000 FROM sessions;
CREATE TRIGGER IF NOT EXISTS ensure_session_message_content_cutover_after_session_insert
AFTER INSERT ON sessions BEGIN
  INSERT OR IGNORE INTO session_message_content_cutover(session_id,session_generation,message_revision,api_read_mode,write_mode,cleanup_state,updated_at)
  VALUES(NEW.id,NEW.generation,0,'legacy','legacy','retained',unixepoch()*1000);
END;
CREATE TRIGGER IF NOT EXISTS prepare_session_content_cleanup_for_session_delete
BEFORE DELETE ON sessions BEGIN
  DELETE FROM session_message_content_cutover WHERE session_id=OLD.id;
  DELETE FROM session_message_content_cleanup_progress WHERE session_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_state_transition
BEFORE UPDATE OF cleanup_state ON session_message_content_cutover
WHEN NEW.cleanup_state != OLD.cleanup_state AND NOT (
  (OLD.cleanup_state='retained' AND NEW.cleanup_state='write-stopped') OR
  (OLD.cleanup_state='write-stopped' AND NEW.cleanup_state='pending') OR
  (OLD.cleanup_state='pending' AND NEW.cleanup_state='complete')
) BEGIN
  SELECT RAISE(ABORT,'invalid session content cleanup state transition');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_pending_transition
BEFORE UPDATE OF cleanup_state ON session_message_content_cutover
WHEN OLD.cleanup_state='write-stopped' AND NEW.cleanup_state='pending' AND NOT EXISTS (
  SELECT 1 FROM session_message_content_cleanup_progress progress
  JOIN sessions ON sessions.id=progress.session_id
  WHERE progress.session_id=OLD.session_id
    AND progress.session_generation=sessions.generation
    AND progress.session_generation=OLD.session_generation
    AND progress.session_message_revision=OLD.message_revision
    AND progress.source_manifest_sha256 IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT,'session content cleanup progress missing');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_complete_transition
BEFORE UPDATE OF cleanup_state ON session_message_content_cutover
WHEN OLD.cleanup_state='pending' AND NEW.cleanup_state='complete' AND NOT EXISTS (
  SELECT 1 FROM session_message_content_cleanup_progress progress
  JOIN sessions ON sessions.id=progress.session_id
  WHERE progress.session_id=OLD.session_id
    AND progress.session_generation=sessions.generation
    AND progress.session_generation=OLD.session_generation
    AND progress.session_message_revision=OLD.message_revision
    AND progress.verified_at IS NOT NULL
    AND progress.verification_sha256 IS NOT NULL
    AND progress.scan_complete=1
    AND progress.source_manifest_sha256 IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM messages WHERE session_id=OLD.session_id AND (content_storage_state!='canonical-backed-only' OR content!='')
    )
) BEGIN
  SELECT RAISE(ABORT,'session content cleanup incomplete');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_progress_baseline
BEFORE UPDATE OF session_generation,session_message_revision,canonical_session_seq,canonical_commit_order,
  watermark_event_id,watermark_invocation_id,source_manifest_sha256 ON session_message_content_cleanup_progress
WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message_content_cutover') AND
  (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id) IN ('pending','complete') AND (
  NEW.session_generation IS NOT OLD.session_generation OR NEW.session_message_revision IS NOT OLD.session_message_revision OR
  NEW.canonical_session_seq IS NOT OLD.canonical_session_seq OR NEW.canonical_commit_order IS NOT OLD.canonical_commit_order OR
  NEW.watermark_event_id IS NOT OLD.watermark_event_id OR NEW.watermark_invocation_id IS NOT OLD.watermark_invocation_id OR
  NEW.source_manifest_sha256 IS NOT OLD.source_manifest_sha256
) BEGIN
  SELECT RAISE(ABORT,'session content cleanup baseline is immutable');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_complete_ledger_immutable
BEFORE UPDATE ON session_message_content_cleanup_progress
WHEN (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='complete' BEGIN
  SELECT RAISE(ABORT,'complete session cleanup ledger is immutable');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_complete_ledger_delete
BEFORE DELETE ON session_message_content_cleanup_progress
WHEN (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='complete' BEGIN
  SELECT RAISE(ABORT,'complete session cleanup ledger is immutable');
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_cleanup_state_update
AFTER UPDATE OF cleanup_state ON session_message_content_cutover
WHEN NEW.cleanup_state != OLD.cleanup_state BEGIN
  UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS reject_message_insert_after_content_write_stop
BEFORE INSERT ON messages
WHEN (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=NEW.session_id)
  IN ('write-stopped','pending','complete') BEGIN
  SELECT RAISE(ABORT,'session message content writes are stopped for cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_message_content_update_after_write_stop
BEFORE UPDATE OF content ON messages
WHEN NEW.content IS NOT OLD.content AND
  (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)
    IN ('write-stopped','pending','complete') AND NOT (
      (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='pending' AND
      NEW.content='' AND NEW.content_storage_state='canonical-backed-only' AND
      OLD.id IS NEW.id AND OLD.session_id IS NEW.session_id AND OLD.role IS NEW.role AND
      OLD.tool_use IS NEW.tool_use AND OLD.tool_calls IS NEW.tool_calls AND OLD.thinking IS NEW.thinking AND
      OLD.content_segments IS NEW.content_segments AND OLD.skill_hints IS NEW.skill_hints AND
      OLD.attachments IS NEW.attachments AND OLD.images_delivered_to_api IS NEW.images_delivered_to_api AND
      OLD.status IS NEW.status AND OLD.schema_version IS NEW.schema_version AND
      OLD.timestamp IS NEW.timestamp AND OLD.sequence IS NEW.sequence AND EXISTS (
        SELECT 1 FROM session_message_content_cleanup_progress progress
        JOIN session_message_content_cutover cutover ON cutover.session_id=progress.session_id
        JOIN sessions ON sessions.id=progress.session_id
        WHERE progress.session_id=OLD.session_id AND progress.session_generation=sessions.generation
          AND progress.session_generation=cutover.session_generation
          AND progress.session_message_revision=cutover.message_revision
      )
    ) BEGIN
  SELECT RAISE(ABORT,'session message content writes are stopped for cleanup');
END;
CREATE TRIGGER IF NOT EXISTS guard_canonical_only_message_content_immutable
BEFORE UPDATE OF content,content_storage_state ON messages
WHEN OLD.content_storage_state='canonical-backed-only' AND (
  NEW.content IS NOT OLD.content OR NEW.content_storage_state IS NOT OLD.content_storage_state
) BEGIN
  SELECT RAISE(ABORT,'canonical-backed-only message content is immutable');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_event_insert_after_content_write_stop
BEFORE INSERT ON agent_history_events
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover cutover
  WHERE cutover.cleanup_state IN ('write-stopped','pending','complete')
    AND cutover.session_id IN (NEW.session_id,(SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id))
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_event_update_after_content_write_stop
BEFORE UPDATE ON agent_history_events
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover cutover
  WHERE cutover.cleanup_state IN ('write-stopped','pending','complete')
    AND cutover.session_id IN (OLD.session_id,NEW.session_id,
      (SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id),
      (SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id))
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_event_delete_after_content_write_stop
BEFORE DELETE ON agent_history_events
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover cutover
  WHERE cutover.cleanup_state IN ('write-stopped','pending','complete')
    AND cutover.session_id IN (OLD.session_id,(SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id))
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_stream_insert_after_content_write_stop
BEFORE INSERT ON agent_history_streams
WHEN NEW.session_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM session_message_content_cutover WHERE session_id=NEW.session_id AND cleanup_state IN ('write-stopped','pending','complete')
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_stream_update_after_content_write_stop
BEFORE UPDATE OF session_id ON agent_history_streams
WHEN OLD.session_id IS NOT NEW.session_id AND EXISTS (
  SELECT 1 FROM session_message_content_cutover
  WHERE session_id IN (OLD.session_id,NEW.session_id) AND cleanup_state IN ('write-stopped','pending','complete')
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_stream_delete_after_content_write_stop
BEFORE DELETE ON agent_history_streams
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover WHERE session_id=OLD.session_id AND cleanup_state IN ('write-stopped','pending','complete')
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_generation_update
AFTER UPDATE OF generation ON sessions WHEN OLD.generation != NEW.generation BEGIN
  UPDATE session_message_content_cutover
    SET session_generation=NEW.generation,message_revision=message_revision+1,
        api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000
    WHERE session_id=NEW.id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=NEW.id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_message_insert
AFTER INSERT ON messages BEGIN
  UPDATE session_message_content_cutover
    SET message_revision=message_revision+1,
        api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000 WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_message_update
AFTER UPDATE ON messages
WHEN NOT (
  (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='pending' AND
  OLD.content IS NOT NEW.content AND NEW.content='' AND NEW.content_storage_state='canonical-backed-only' AND
  OLD.id IS NEW.id AND OLD.session_id IS NEW.session_id AND OLD.role IS NEW.role AND
  OLD.tool_use IS NEW.tool_use AND OLD.tool_calls IS NEW.tool_calls AND OLD.thinking IS NEW.thinking AND
  OLD.content_segments IS NEW.content_segments AND OLD.skill_hints IS NEW.skill_hints AND
  OLD.attachments IS NEW.attachments AND OLD.images_delivered_to_api IS NEW.images_delivered_to_api AND
  OLD.status IS NEW.status AND OLD.schema_version IS NEW.schema_version AND
  OLD.timestamp IS NEW.timestamp AND OLD.sequence IS NEW.sequence
) BEGIN
  UPDATE session_message_content_cutover
    SET message_revision=message_revision+1,
        api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000 WHERE session_id=OLD.session_id;
  UPDATE session_message_content_cutover
    SET message_revision=message_revision+1,
        api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000 WHERE session_id=NEW.session_id AND NEW.session_id != OLD.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_message_delete
AFTER DELETE ON messages BEGIN
  UPDATE session_message_content_cutover
    SET message_revision=message_revision+1,
        api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000 WHERE session_id=OLD.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=OLD.session_id;
END;
`

/** v38 → v39: persist source-truth spill collection obligations independently of session rows. */
export const MIGRATION_V39_SOURCE_TRUTH_SPILL_GC_SQL = `
CREATE TABLE IF NOT EXISTS source_truth_spill_gc_queue (
  locator TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_truth_spill_gc_pending
  ON source_truth_spill_gc_queue(status, updated_at, locator);
`

/** v39 → v40: persist resumable full-directory orphan classification progress. */
export const MIGRATION_V40_SOURCE_TRUTH_SPILL_GC_SCAN_SQL = `
CREATE TABLE IF NOT EXISTS source_truth_spill_gc_scan_state (
  root_key TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
  after_name TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO source_truth_spill_gc_scan_state(root_key,status,after_name,attempts,last_error,updated_at)
VALUES('user-data-spill','pending',NULL,0,NULL,0);
`

/** v40 → v41: any canonical History mutation revokes session API read certification. */
export const MIGRATION_V41_CANONICAL_HISTORY_API_ELIGIBILITY_SQL = `
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_event_insert
AFTER INSERT ON agent_history_events BEGIN
  UPDATE session_message_content_cutover
    SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000
    WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id);
  DELETE FROM canonical_session_api_context_eligibility
    WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_event_update
AFTER UPDATE ON agent_history_events BEGIN
  UPDATE session_message_content_cutover
    SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000
    WHERE session_id IN (
      SELECT session_id FROM agent_history_streams
      WHERE invocation_id=OLD.invocation_id OR invocation_id=NEW.invocation_id
    );
  DELETE FROM canonical_session_api_context_eligibility
    WHERE session_id IN (
      SELECT session_id FROM agent_history_streams
      WHERE invocation_id=OLD.invocation_id OR invocation_id=NEW.invocation_id
    );
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_event_delete
AFTER DELETE ON agent_history_events BEGIN
  UPDATE session_message_content_cutover
    SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000
    WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id);
  DELETE FROM canonical_session_api_context_eligibility
    WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_stream_session_update
AFTER UPDATE OF session_id ON agent_history_streams WHEN OLD.session_id IS NOT NEW.session_id BEGIN
  UPDATE session_message_content_cutover
    SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000
    WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_stream_delete
AFTER DELETE ON agent_history_streams BEGIN
  UPDATE session_message_content_cutover
    SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000
    WHERE session_id=OLD.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id;
END;
`

/** v41 → v42: invalidate detached transcript projections when persisted History facts are rewritten. */
export const MIGRATION_V42_CANONICAL_TRANSCRIPT_CACHE_INVALIDATION_SQL = `
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_event_update
AFTER UPDATE ON agent_history_events BEGIN
  DELETE FROM canonical_session_projection_cache
    WHERE session_id IN (
      SELECT session_id FROM agent_history_streams WHERE invocation_id IN (OLD.invocation_id, NEW.invocation_id)
      UNION SELECT OLD.session_id WHERE OLD.session_id IS NOT NULL
      UNION SELECT NEW.session_id WHERE NEW.session_id IS NOT NULL
    );
END;
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_event_delete
AFTER DELETE ON agent_history_events BEGIN
  DELETE FROM canonical_session_projection_cache
    WHERE session_id IN (
      SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id
      UNION SELECT OLD.session_id WHERE OLD.session_id IS NOT NULL
    );
END;
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_stream_session_update
AFTER UPDATE OF session_id ON agent_history_streams WHEN OLD.session_id IS NOT NEW.session_id BEGIN
  DELETE FROM canonical_session_projection_cache WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_stream_delete
AFTER DELETE ON agent_history_streams BEGIN
  DELETE FROM canonical_session_projection_cache WHERE session_id=OLD.session_id;
END;
`

/** v42 → v43: checksum detached transcript cache bytes and discard pre-checksum projections. */
export const MIGRATION_V43_CANONICAL_TRANSCRIPT_CACHE_CHECKSUM_SQL = `
ALTER TABLE canonical_session_projection_cache ADD COLUMN value_sha256 TEXT NOT NULL DEFAULT '';
`

export const MIGRATION_V44_SESSION_CONTENT_WRITE_STOPPED_STATE_SQL = `
CREATE TABLE IF NOT EXISTS session_message_content_cleanup_progress (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation TEXT NOT NULL,
  session_message_revision INTEGER NOT NULL,
  canonical_session_seq INTEGER NOT NULL,
  canonical_commit_order INTEGER NOT NULL,
  watermark_event_id TEXT,
  watermark_invocation_id TEXT,
  next_sequence INTEGER NOT NULL DEFAULT 0 CHECK(next_sequence >= 0),
  after_message_id TEXT,
  cleaned_message_count INTEGER NOT NULL DEFAULT 0 CHECK(cleaned_message_count >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  scan_complete INTEGER NOT NULL DEFAULT 0 CHECK(scan_complete IN (0,1)),
  source_manifest_sha256 TEXT,
  verified_at INTEGER,
  verification_sha256 TEXT,
  updated_at INTEGER NOT NULL
);
DROP TRIGGER IF EXISTS ensure_session_message_content_cutover_after_session_insert;
DROP TRIGGER IF EXISTS guard_session_content_cleanup_state_transition;
DROP TRIGGER IF EXISTS guard_session_content_cleanup_pending_transition;
DROP TRIGGER IF EXISTS guard_session_content_cleanup_complete_transition;
DROP TRIGGER IF EXISTS guard_session_content_cleanup_progress_baseline;
DROP TRIGGER IF EXISTS guard_session_content_cleanup_complete_ledger_immutable;
DROP TRIGGER IF EXISTS guard_session_content_cleanup_complete_ledger_delete;
DROP TRIGGER IF EXISTS prepare_session_content_cleanup_for_session_delete;
DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_cleanup_state_update;
DROP TRIGGER IF EXISTS reject_message_insert_after_content_write_stop;
DROP TRIGGER IF EXISTS reject_message_content_update_after_write_stop;
DROP TRIGGER IF EXISTS reject_history_event_insert_after_content_write_stop;
DROP TRIGGER IF EXISTS reject_history_event_update_after_content_write_stop;
DROP TRIGGER IF EXISTS reject_history_event_delete_after_content_write_stop;
DROP TRIGGER IF EXISTS reject_history_stream_insert_after_content_write_stop;
DROP TRIGGER IF EXISTS reject_history_stream_update_after_content_write_stop;
DROP TRIGGER IF EXISTS reject_history_stream_delete_after_content_write_stop;
DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_generation_update;
DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_message_insert;
DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_message_update;
DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_message_delete;
DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_event_insert;
DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_event_update;
DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_event_delete;
DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_stream_session_update;
DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_stream_delete;
DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_event_update;
DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_event_delete;
DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_stream_session_update;
DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_stream_delete;
DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_event_insert;
DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_stream_session_insert;
DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_stream_session_insert;
CREATE TABLE session_message_content_cutover_v44 (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_generation TEXT NOT NULL,
  message_revision INTEGER NOT NULL DEFAULT 0,
  api_read_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(api_read_mode IN ('legacy','canonical','revalidation-required')),
  write_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(write_mode IN ('legacy','dual-write','canonical')),
  cleanup_state TEXT NOT NULL DEFAULT 'retained' CHECK(cleanup_state IN (${sqlTextEnum(SESSION_CONTENT_CLEANUP_STATES)})),
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO session_message_content_cutover_v44(
  session_id,session_generation,message_revision,api_read_mode,write_mode,cleanup_state,updated_at
)
SELECT session_id,session_generation,message_revision,api_read_mode,write_mode,cleanup_state,updated_at
FROM session_message_content_cutover;
DROP TABLE session_message_content_cutover;
ALTER TABLE session_message_content_cutover_v44 RENAME TO session_message_content_cutover;
CREATE TRIGGER IF NOT EXISTS ensure_session_message_content_cutover_after_session_insert
AFTER INSERT ON sessions BEGIN
  INSERT OR IGNORE INTO session_message_content_cutover(session_id,session_generation,message_revision,api_read_mode,write_mode,cleanup_state,updated_at)
  VALUES(NEW.id,NEW.generation,0,'legacy','legacy','retained',unixepoch()*1000);
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_state_transition
BEFORE UPDATE OF cleanup_state ON session_message_content_cutover
WHEN NEW.cleanup_state != OLD.cleanup_state AND NOT (
  (OLD.cleanup_state='retained' AND NEW.cleanup_state='write-stopped') OR
  (OLD.cleanup_state='write-stopped' AND NEW.cleanup_state='pending') OR
  (OLD.cleanup_state='pending' AND NEW.cleanup_state='complete')
) BEGIN
  SELECT RAISE(ABORT,'invalid session content cleanup state transition');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_pending_transition
BEFORE UPDATE OF cleanup_state ON session_message_content_cutover
WHEN OLD.cleanup_state='write-stopped' AND NEW.cleanup_state='pending' AND NOT EXISTS (
  SELECT 1 FROM session_message_content_cleanup_progress progress
  JOIN sessions ON sessions.id=progress.session_id
  WHERE progress.session_id=OLD.session_id
    AND progress.session_generation=sessions.generation
    AND progress.session_generation=OLD.session_generation
    AND progress.session_message_revision=OLD.message_revision
    AND progress.source_manifest_sha256 IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT,'session content cleanup progress missing');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_complete_transition
BEFORE UPDATE OF cleanup_state ON session_message_content_cutover
WHEN OLD.cleanup_state='pending' AND NEW.cleanup_state='complete' AND NOT EXISTS (
  SELECT 1 FROM session_message_content_cleanup_progress progress
  JOIN sessions ON sessions.id=progress.session_id
  WHERE progress.session_id=OLD.session_id
    AND progress.session_generation=sessions.generation
    AND progress.session_generation=OLD.session_generation
    AND progress.session_message_revision=OLD.message_revision
    AND progress.verified_at IS NOT NULL
    AND progress.verification_sha256 IS NOT NULL
    AND progress.scan_complete=1
    AND progress.source_manifest_sha256 IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM messages WHERE session_id=OLD.session_id AND (content_storage_state!='canonical-backed-only' OR content!='')
    )
) BEGIN
  SELECT RAISE(ABORT,'session content cleanup incomplete');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_progress_baseline
BEFORE UPDATE OF session_generation,session_message_revision,canonical_session_seq,canonical_commit_order,
  watermark_event_id,watermark_invocation_id,source_manifest_sha256 ON session_message_content_cleanup_progress
WHEN (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id) IN ('pending','complete') AND (
  NEW.session_generation IS NOT OLD.session_generation OR NEW.session_message_revision IS NOT OLD.session_message_revision OR
  NEW.canonical_session_seq IS NOT OLD.canonical_session_seq OR NEW.canonical_commit_order IS NOT OLD.canonical_commit_order OR
  NEW.watermark_event_id IS NOT OLD.watermark_event_id OR NEW.watermark_invocation_id IS NOT OLD.watermark_invocation_id OR
  NEW.source_manifest_sha256 IS NOT OLD.source_manifest_sha256
) BEGIN
  SELECT RAISE(ABORT,'session content cleanup baseline is immutable');
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_cleanup_state_update
AFTER UPDATE OF cleanup_state ON session_message_content_cutover
WHEN NEW.cleanup_state != OLD.cleanup_state BEGIN
  UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS reject_message_insert_after_content_write_stop
BEFORE INSERT ON messages
WHEN (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=NEW.session_id)
  IN ('write-stopped','pending','complete') BEGIN
  SELECT RAISE(ABORT,'session message content writes are stopped for cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_message_content_update_after_write_stop
BEFORE UPDATE OF content ON messages
WHEN NEW.content IS NOT OLD.content AND
  (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)
    IN ('write-stopped','pending','complete') AND NOT (
      (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='pending' AND
      NEW.content='' AND NEW.content_storage_state='canonical-backed-only' AND
      OLD.id IS NEW.id AND OLD.session_id IS NEW.session_id AND OLD.role IS NEW.role AND
      OLD.tool_use IS NEW.tool_use AND OLD.tool_calls IS NEW.tool_calls AND OLD.thinking IS NEW.thinking AND
      OLD.content_segments IS NEW.content_segments AND OLD.skill_hints IS NEW.skill_hints AND
      OLD.attachments IS NEW.attachments AND OLD.images_delivered_to_api IS NEW.images_delivered_to_api AND
      OLD.status IS NEW.status AND OLD.schema_version IS NEW.schema_version AND
      OLD.timestamp IS NEW.timestamp AND OLD.sequence IS NEW.sequence AND EXISTS (
        SELECT 1 FROM session_message_content_cleanup_progress progress
        JOIN session_message_content_cutover cutover ON cutover.session_id=progress.session_id
        JOIN sessions ON sessions.id=progress.session_id
        WHERE progress.session_id=OLD.session_id AND progress.session_generation=sessions.generation
          AND progress.session_generation=cutover.session_generation
          AND progress.session_message_revision=cutover.message_revision
      )
    ) BEGIN
  SELECT RAISE(ABORT,'session message content writes are stopped for cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_event_insert_after_content_write_stop
BEFORE INSERT ON agent_history_events
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover cutover
  WHERE cutover.cleanup_state IN ('write-stopped','pending','complete')
    AND cutover.session_id IN (NEW.session_id,(SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id))
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_event_update_after_content_write_stop
BEFORE UPDATE ON agent_history_events
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover cutover
  WHERE cutover.cleanup_state IN ('write-stopped','pending','complete')
    AND cutover.session_id IN (OLD.session_id,NEW.session_id,
      (SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id),
      (SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id))
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_event_delete_after_content_write_stop
BEFORE DELETE ON agent_history_events
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover cutover
  WHERE cutover.cleanup_state IN ('write-stopped','pending','complete')
    AND cutover.session_id IN (OLD.session_id,(SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id))
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_stream_insert_after_content_write_stop
BEFORE INSERT ON agent_history_streams
WHEN NEW.session_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM session_message_content_cutover WHERE session_id=NEW.session_id AND cleanup_state IN ('write-stopped','pending','complete')
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_stream_update_after_content_write_stop
BEFORE UPDATE OF session_id ON agent_history_streams
WHEN OLD.session_id IS NOT NEW.session_id AND EXISTS (
  SELECT 1 FROM session_message_content_cutover
  WHERE session_id IN (OLD.session_id,NEW.session_id) AND cleanup_state IN ('write-stopped','pending','complete')
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS reject_history_stream_delete_after_content_write_stop
BEFORE DELETE ON agent_history_streams
WHEN EXISTS (
  SELECT 1 FROM session_message_content_cutover WHERE session_id=OLD.session_id AND cleanup_state IN ('write-stopped','pending','complete')
) BEGIN
  SELECT RAISE(ABORT,'canonical History writes are stopped for session content cleanup');
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_generation_update
AFTER UPDATE OF generation ON sessions WHEN OLD.generation != NEW.generation BEGIN
  UPDATE session_message_content_cutover
    SET session_generation=NEW.generation,message_revision=message_revision+1,
        api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000
    WHERE session_id=NEW.id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=NEW.id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_message_insert
AFTER INSERT ON messages BEGIN
  UPDATE session_message_content_cutover
    SET message_revision=message_revision+1,
        api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000 WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=NEW.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_message_update
AFTER UPDATE ON messages
WHEN NOT (
  (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='pending' AND
  OLD.content IS NOT NEW.content AND NEW.content='' AND NEW.content_storage_state='canonical-backed-only' AND
  OLD.id IS NEW.id AND OLD.session_id IS NEW.session_id AND OLD.role IS NEW.role AND
  OLD.tool_use IS NEW.tool_use AND OLD.tool_calls IS NEW.tool_calls AND OLD.thinking IS NEW.thinking AND
  OLD.content_segments IS NEW.content_segments AND OLD.skill_hints IS NEW.skill_hints AND
  OLD.attachments IS NEW.attachments AND OLD.images_delivered_to_api IS NEW.images_delivered_to_api AND
  OLD.status IS NEW.status AND OLD.schema_version IS NEW.schema_version AND
  OLD.timestamp IS NEW.timestamp AND OLD.sequence IS NEW.sequence
) BEGIN
  UPDATE session_message_content_cutover SET message_revision=message_revision+1,
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=OLD.session_id;
  UPDATE session_message_content_cutover SET message_revision=message_revision+1,
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=NEW.session_id AND NEW.session_id != OLD.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_content_eligibility_after_message_delete
AFTER DELETE ON messages BEGIN
  UPDATE session_message_content_cutover SET message_revision=message_revision+1,
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=OLD.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id;
  DELETE FROM canonical_session_projection_eligibility WHERE session_id=OLD.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_event_insert
AFTER INSERT ON agent_history_events BEGIN
  UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id);
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=NEW.invocation_id);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_event_update
AFTER UPDATE ON agent_history_events BEGIN
  UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id IN (SELECT session_id FROM agent_history_streams WHERE invocation_id IN (OLD.invocation_id,NEW.invocation_id));
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id IN (SELECT session_id FROM agent_history_streams WHERE invocation_id IN (OLD.invocation_id,NEW.invocation_id));
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_event_delete
AFTER DELETE ON agent_history_events BEGIN
  UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id);
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=(SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_stream_session_update
AFTER UPDATE OF session_id ON agent_history_streams WHEN OLD.session_id IS NOT NEW.session_id BEGIN
  UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_api_eligibility_after_history_stream_delete
AFTER DELETE ON agent_history_streams BEGIN
  UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=unixepoch()*1000 WHERE session_id=OLD.session_id;
  DELETE FROM canonical_session_api_context_eligibility WHERE session_id=OLD.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_event_update
AFTER UPDATE ON agent_history_events BEGIN
  DELETE FROM canonical_session_projection_cache WHERE session_id IN (
    SELECT session_id FROM agent_history_streams WHERE invocation_id IN (OLD.invocation_id,NEW.invocation_id)
    UNION SELECT OLD.session_id WHERE OLD.session_id IS NOT NULL UNION SELECT NEW.session_id WHERE NEW.session_id IS NOT NULL);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_event_delete
AFTER DELETE ON agent_history_events BEGIN
  DELETE FROM canonical_session_projection_cache WHERE session_id IN (
    SELECT session_id FROM agent_history_streams WHERE invocation_id=OLD.invocation_id
    UNION SELECT OLD.session_id WHERE OLD.session_id IS NOT NULL);
END;
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_stream_session_update
AFTER UPDATE OF session_id ON agent_history_streams WHEN OLD.session_id IS NOT NEW.session_id BEGIN
  DELETE FROM canonical_session_projection_cache WHERE session_id=OLD.session_id OR session_id=NEW.session_id;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_canonical_transcript_cache_after_history_stream_delete
AFTER DELETE ON agent_history_streams BEGIN
  DELETE FROM canonical_session_projection_cache WHERE session_id=OLD.session_id;
END;
`

/** v44 → v45: preserve final cleanup verification evidence after complete. */
export const MIGRATION_V45_SESSION_CONTENT_COMPLETE_LEDGER_SQL = `
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_complete_ledger_immutable
BEFORE UPDATE ON session_message_content_cleanup_progress
WHEN (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='complete' BEGIN
  SELECT RAISE(ABORT,'complete session cleanup ledger is immutable');
END;
CREATE TRIGGER IF NOT EXISTS guard_session_content_cleanup_complete_ledger_delete
BEFORE DELETE ON session_message_content_cleanup_progress
WHEN (SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=OLD.session_id)='complete' BEGIN
  SELECT RAISE(ABORT,'complete session cleanup ledger is immutable');
END;
CREATE TRIGGER IF NOT EXISTS prepare_session_content_cleanup_for_session_delete
BEFORE DELETE ON sessions BEGIN
  DELETE FROM session_message_content_cutover WHERE session_id=OLD.id;
  DELETE FROM session_message_content_cleanup_progress WHERE session_id=OLD.id;
END;
`

/** v32 → v33: stable session incarnation identity for cache watermarks. */
export const MIGRATION_V35_SESSION_GENERATION_SQL = `
ALTER TABLE sessions ADD COLUMN generation TEXT NOT NULL DEFAULT '';
UPDATE sessions SET generation = lower(hex(randomblob(16))) WHERE generation = '';
`

/** v31 → v32 deterministic backfill and indexes; invoked when both History tables exist. */
export const MIGRATION_V34_AGENT_HISTORY_SESSION_ORDER_SQL = `
WITH global_order AS (
  SELECT invocation_id, sequence,
    ROW_NUMBER() OVER (ORDER BY created_at, invocation_id, sequence) AS commit_order
  FROM agent_history_events
), session_order AS (
  SELECT streams.session_id, events.invocation_id, events.sequence,
    ROW_NUMBER() OVER (PARTITION BY streams.session_id ORDER BY events.created_at, events.invocation_id, events.sequence) AS session_seq
  FROM agent_history_events events
  JOIN agent_history_streams streams ON streams.invocation_id = events.invocation_id
  WHERE streams.session_id IS NOT NULL
)
UPDATE agent_history_events
SET session_id = (SELECT session_id FROM session_order WHERE session_order.invocation_id = agent_history_events.invocation_id AND session_order.sequence = agent_history_events.sequence),
    commit_order = (SELECT commit_order FROM global_order WHERE global_order.invocation_id = agent_history_events.invocation_id AND global_order.sequence = agent_history_events.sequence),
    session_seq = (SELECT session_seq FROM session_order WHERE session_order.invocation_id = agent_history_events.invocation_id AND session_order.sequence = agent_history_events.sequence)
WHERE commit_order IS NULL;

INSERT OR IGNORE INTO agent_history_commit_cursor(id, allocated_at)
SELECT commit_order, created_at FROM agent_history_events ORDER BY commit_order;
INSERT INTO session_event_cursor(session_id, next_seq)
SELECT session_id, MAX(session_seq) FROM agent_history_events WHERE session_id IS NOT NULL GROUP BY session_id
ON CONFLICT(session_id) DO UPDATE SET next_seq=MAX(next_seq, excluded.next_seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_history_events_commit_order ON agent_history_events(commit_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_history_events_session_seq ON agent_history_events(session_id, session_seq)
  WHERE session_id IS NOT NULL AND session_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_history_events_session_commit_order ON agent_history_events(session_id, commit_order);
`

/**
 * Thinking 强度（v17）：会话级覆盖列。
 * NULL = 继承全局 config.thinkingEffort（§4.2 继承语义）——存量行不加默认值即天然兼容，禁止回填。
 */
export const MIGRATION_V17_SESSION_THINKING_EFFORT_SQL = `
ALTER TABLE sessions ADD COLUMN thinking_effort TEXT;
`

export const SCHEMA_META_KEYS = {
  schemaVersion: 'schema_version',
  migratedFromJsonAt: 'migrated_from_json_at',
  migratedFromJsonPath: 'migrated_from_json_path',
  legacyWorkspaceLayoutCleanedAt: 'legacy_workspace_layout_cleaned_at',
  /** 用量统计一次性历史回填完成时间（C7）；缺失时启动重试，成功即写。 */
  usageStatsBackfillAt: 'usage_stats_backfill_at'
} as const


/** v45 → v46: keep canonical-only rows immutable if their cutover fence is damaged or missing. */
export const MIGRATION_V48_CANONICAL_ONLY_MESSAGE_CONTENT_IMMUTABLE_SQL = `
CREATE TRIGGER IF NOT EXISTS guard_canonical_only_message_content_immutable
BEFORE UPDATE OF content,content_storage_state ON messages
WHEN OLD.content_storage_state='canonical-backed-only' AND (
  NEW.content IS NOT OLD.content OR NEW.content_storage_state IS NOT OLD.content_storage_state
) BEGIN
  SELECT RAISE(ABORT,'canonical-backed-only message content is immutable');
END;

`

/** v46: tables and integrity backfill for the global History allocator. */
export const MIGRATION_V49_HISTORY_CURSOR_INVALIDATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS agent_history_cursor_integrity (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  invalid INTEGER NOT NULL DEFAULT 0 CHECK(invalid IN (0,1))
);
INSERT OR IGNORE INTO agent_history_cursor_integrity(singleton_id,invalid) VALUES(1,0);
CREATE TABLE IF NOT EXISTS agent_history_pending_commit_cursor (
  cursor_id INTEGER PRIMARY KEY
);
DELETE FROM agent_history_pending_commit_cursor;
INSERT INTO agent_history_pending_commit_cursor(cursor_id)
SELECT cursor.id FROM agent_history_commit_cursor cursor
LEFT JOIN agent_history_events events ON events.commit_order=cursor.id
WHERE events.commit_order IS NULL;
UPDATE agent_history_cursor_integrity SET invalid=CASE WHEN
  (SELECT COUNT(*) FROM agent_history_events) != COALESCE((SELECT MAX(id) FROM agent_history_commit_cursor),0) OR
  ((SELECT COUNT(*) FROM agent_history_events) > 0 AND (
    (SELECT MIN(commit_order) FROM agent_history_events) != 1 OR
    (SELECT MAX(commit_order) FROM agent_history_events) != (SELECT COUNT(*) FROM agent_history_events)
  )) THEN 1 ELSE 0 END WHERE singleton_id=1;
`

/** v46 triggers are kept separate so a failed replay of earlier table rebuilds can restore them. */
export const MIGRATION_V49_HISTORY_CURSOR_INVALIDATION_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS track_pending_history_cursor_allocation
AFTER INSERT ON agent_history_commit_cursor BEGIN
  INSERT OR IGNORE INTO agent_history_pending_commit_cursor(cursor_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS settle_pending_history_cursor_allocation
AFTER INSERT ON agent_history_events BEGIN
  DELETE FROM agent_history_pending_commit_cursor WHERE cursor_id=NEW.commit_order;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_projections_after_history_cursor_update
AFTER UPDATE ON agent_history_commit_cursor BEGIN
  UPDATE agent_history_cursor_integrity SET invalid=1 WHERE singleton_id=1;
  DELETE FROM canonical_session_projection_cache WHERE cache_key='transcript';
  DELETE FROM canonical_session_projection_eligibility;
  UPDATE session_message_content_cutover
    SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000;
  DELETE FROM canonical_session_api_context_eligibility;
END;
CREATE TRIGGER IF NOT EXISTS invalidate_session_projections_after_history_cursor_delete
AFTER DELETE ON agent_history_commit_cursor BEGIN
  UPDATE agent_history_cursor_integrity SET invalid=1 WHERE singleton_id=1;
  DELETE FROM canonical_session_projection_cache WHERE cache_key='transcript';
  DELETE FROM canonical_session_projection_eligibility;
  UPDATE session_message_content_cutover
    SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
        updated_at=unixepoch()*1000;
  DELETE FROM canonical_session_api_context_eligibility;
END;
`

/** v46: complete allocator integrity migration. */
export const MIGRATION_V49_HISTORY_CURSOR_INVALIDATION_SQL = `
${MIGRATION_V49_HISTORY_CURSOR_INVALIDATION_TABLES_SQL}
${MIGRATION_V49_HISTORY_CURSOR_INVALIDATION_TRIGGERS_SQL}
`
