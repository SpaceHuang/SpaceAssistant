import type { DatabaseSync } from 'node:sqlite'
import {
  CREATE_TABLES_SQL, DB_SCHEMA_VERSION, MIGRATION_V4_TABLES_SQL, MIGRATION_V5_TURN_TABLE_SQL, MIGRATION_V6_TURN_CHECKPOINT_SQL,
  MIGRATION_V7_QUEUE_RECEIPT_SQL, MIGRATION_V8_TURN_START_TOKEN_SQL, MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL,
  MIGRATION_V10_TURN_TERMINAL_USAGE_SQL, MIGRATION_V11_TURN_CONTEXT_SQL, MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL,
  MIGRATION_V13_TURN_ROUTING_INDEXES_SQL, MIGRATION_V14_SESSION_OWNERSHIP_BACKFILL_SQL, MIGRATION_V15_BUTLER_TABLES_SQL,
  MIGRATION_V16_USAGE_STATS_SQL, MIGRATION_V17_SESSION_THINKING_EFFORT_SQL, MIGRATION_V18_CONFIRMATION_COMMIT_IDENTITY_SQL,
  MIGRATION_V19_AGENT_HISTORY_SQL, MIGRATION_V20_AGENT_HISTORY_SESSION_SQL, MIGRATION_V21_AGENT_HISTORY_SESSION_BACKFILL_SQL,
  MIGRATION_V22_TURN_INPUT_HISTORY_VERSION_SQL, MIGRATION_V23_DRIVER_DELIVERY_SQL, MIGRATION_V24_SESSION_TRANSCRIPT_SQL,
  MIGRATION_V25_SESSION_EXECUTION_QUEUE_SQL, MIGRATION_V26_SESSION_TRANSCRIPT_RECONCILIATION_SQL,
  MIGRATION_V27_ACCEPTED_TURN_CONTEXT_SQL, MIGRATION_V28_USAGE_ATTRIBUTION_SQL, MIGRATION_V29_CONTINUATIONS_SQL,
  MIGRATION_V30_CONTINUATION_START_TOKEN_SQL, MIGRATION_MAIN_V31_CONTINUATION_INTENTS_SQL,
  MIGRATION_MAIN_V32_CONTINUATION_CONTEXT_SQL, MIGRATION_V31_CANONICAL_PROJECTION_REPAIRS_SQL,
  MIGRATION_V32_AGENT_HISTORY_CURSOR_TABLES_SQL, MIGRATION_V32_AGENT_HISTORY_SESSION_ORDER_SQL, MIGRATION_V33_SESSION_GENERATION_SQL,
  MIGRATION_V34_CANONICAL_SESSION_CACHE_VERSION_SQL, MIGRATION_V35_SESSION_TURN_COMMIT_RECEIPTS_SQL,
  MIGRATION_V36_SESSION_TRANSCRIPT_COMMIT_STATE_SQL, MIGRATION_V37_SESSION_PROJECTION_ELIGIBILITY_SQL,
  MIGRATION_V38_SESSION_CONTENT_CUTOVER_SQL, MIGRATION_V39_SOURCE_TRUTH_SPILL_GC_SQL,
  MIGRATION_V40_SOURCE_TRUTH_SPILL_GC_SCAN_SQL, MIGRATION_V41_CANONICAL_HISTORY_API_ELIGIBILITY_SQL,
  MIGRATION_V42_CANONICAL_TRANSCRIPT_CACHE_INVALIDATION_SQL, MIGRATION_V43_CANONICAL_TRANSCRIPT_CACHE_CHECKSUM_SQL,
  MIGRATION_V44_SESSION_CONTENT_WRITE_STOPPED_STATE_SQL, MIGRATION_V45_SESSION_CONTENT_COMPLETE_LEDGER_SQL,
  MIGRATION_V46_CANONICAL_ONLY_MESSAGE_CONTENT_IMMUTABLE_SQL, MIGRATION_V46_HISTORY_CURSOR_INVALIDATION_SQL,
  MIGRATION_V46_HISTORY_CURSOR_INVALIDATION_TRIGGERS_SQL, MIGRATION_V47_SESSION_PROJECTION_MIGRATION_SQL,
  MIGRATION_V48_SESSION_PROJECTION_LEGACY_POLICY_SQL, MIGRATION_V49_SESSION_PROJECTION_SCOPE_SQL,
  MIGRATION_V50_HISTORY_RECOVERY_WORK_SQL, MIGRATION_V50_HISTORY_RECOVERY_WORK_TRIGGERS_SQL,
  MIGRATION_V51_USAGE_MODEL_IDENTITY_COLUMNS, MIGRATION_V52_SESSION_PROJECTION_MIGRATION_CANCEL_SQL, SCHEMA_META_KEYS
} from './schema'
import { runInTransaction } from './transaction'

export class DatabaseUpgradeRequiredError extends Error {
  constructor(foundVersion: number) {
    super(`数据库版本 ${foundVersion} 高于当前应用支持的版本 ${DB_SCHEMA_VERSION}；请升级应用后重试。`)
    this.name = 'DatabaseUpgradeRequiredError'
  }
}

function parseSchemaVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid database schema version: ${value}`)
  return Number(value)
}

function readSchemaVersion(conn: DatabaseSync): number | undefined {
  const row = conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_META_KEYS.schemaVersion) as
    | { value: string }
    | undefined
  return parseSchemaVersion(row?.value)
}

export function runMigrations(conn: DatabaseSync): void {
  let version = readSchemaVersion(conn)
  if (version === undefined) {
    runInTransaction(conn, () => {
      conn.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(SCHEMA_META_KEYS.schemaVersion, '1')
    })
    version = 1
  }
  if (version > DB_SCHEMA_VERSION) {
    throw new DatabaseUpgradeRequiredError(version)
  }
  const replayedV46Triggers = version < 46
    ? (conn.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
        'track_pending_history_cursor_allocation','settle_pending_history_cursor_allocation',
        'invalidate_session_projections_after_history_cursor_update','invalidate_session_projections_after_history_cursor_delete'
      )`).all() as Array<{ name: string }>).map(({ name }) => name)
    : []
  if (replayedV46Triggers.length > 0) {
    conn.exec(`DROP TRIGGER IF EXISTS track_pending_history_cursor_allocation;
      DROP TRIGGER IF EXISTS settle_pending_history_cursor_allocation;
      DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_update;
      DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_delete;`)
  }
  try {
  if (version === 1) runInTransaction(conn, () => {
    conn.exec(CREATE_TABLES_SQL)
    version = 3
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 2) runInTransaction(conn, () => {
    conn.exec('DROP TABLE IF EXISTS artifact_operations')
    conn.exec('DROP TABLE IF EXISTS artifact_references')
    conn.exec('DROP TABLE IF EXISTS session_artifacts')
    version = 3
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 3) runInTransaction(conn, () => {
    // 工具确认机制框架（P3）：决策缓存表 + 用户规则覆盖表
    conn.exec(MIGRATION_V4_TABLES_SQL)
    version = 4
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 4) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V5_TURN_TABLE_SQL)
    version = 5
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 5) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V6_TURN_CHECKPOINT_SQL)
    version = 6
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 6) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V7_QUEUE_RECEIPT_SQL)
    version = 7
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 7) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V8_TURN_START_TOKEN_SQL)
    version = 8
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 8) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL)
    version = 9
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 9) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V10_TURN_TERMINAL_USAGE_SQL)
    version = 10
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 10) runInTransaction(conn, () => {
    const columns = conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'exclude_message_ids_json')) {
      conn.exec(MIGRATION_V11_TURN_CONTEXT_SQL)
    }
    version = 11
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 11) runInTransaction(conn, () => {
    const columns = conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'execution_config_json')) {
      conn.exec(MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL)
    }
    version = 12
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 12) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V13_TURN_ROUTING_INDEXES_SQL)
    // 容忍早期开发库元数据与列定义不一致；正式 v12 库都具备该列。
    const columns = conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
    if (columns.some((column) => column.name === 'user_message_id')) {
      conn.exec('CREATE INDEX IF NOT EXISTS idx_turns_session_user ON turns(session_id, user_message_id)')
    }
    version = 13
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 13) runInTransaction(conn, () => {
    // 偏差 7：sessions 归属/可见性两列（带列存在性防护，容忍重复升级的库）。
    // 无 sessions 表的开发库（部分迁移测试库）直接跳过，保持升级幂等。
    const hasSessionsTable =
      (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").all() as unknown[]).length > 0
    if (hasSessionsTable) {
      const sessionColumns = conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
      if (!sessionColumns.some((column) => column.name === 'ownership')) {
        conn.exec('ALTER TABLE sessions ADD COLUMN ownership TEXT NOT NULL DEFAULT \'user\'')
      }
      if (!sessionColumns.some((column) => column.name === 'visibility')) {
        conn.exec('ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT \'primary\'')
      }
      conn.exec(MIGRATION_V14_SESSION_OWNERSHIP_BACKFILL_SQL)
    }
    version = 14
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 14) runInTransaction(conn, () => {
    // P4：管家任务表（CREATE TABLE IF NOT EXISTS，幂等）
    conn.exec(MIGRATION_V15_BUTLER_TABLES_SQL)
    version = 15
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 15) runInTransaction(conn, () => {
    // Agent Token 用量统计事实表（CREATE TABLE IF NOT EXISTS，幂等）
    conn.exec(MIGRATION_V16_USAGE_STATS_SQL)
    version = 16
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 16) runInTransaction(conn, () => {
    // Thinking 强度：sessions.thinking_effort 覆盖列（带列存在性防护，容忍重复升级的库；
    // 无 sessions 表的开发库直接跳过，保持升级幂等）
    const hasSessionsTable =
      (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").all() as unknown[]).length > 0
    if (hasSessionsTable) {
      const sessionColumns = conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
      if (!sessionColumns.some((column) => column.name === 'thinking_effort')) {
        conn.exec(MIGRATION_V17_SESSION_THINKING_EFFORT_SQL)
      }
    }
    version = 17
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 17) runInTransaction(conn, () => {
    const hasSubmissionsTable =
      (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'confirmation_submissions'").all() as unknown[]).length > 0
    if (hasSubmissionsTable) {
      const columns = conn.prepare('PRAGMA table_info(confirmation_submissions)').all() as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'session_id')) conn.exec('ALTER TABLE confirmation_submissions ADD COLUMN session_id TEXT NOT NULL DEFAULT \'\'')
      if (!columns.some((column) => column.name === 'generation')) conn.exec('ALTER TABLE confirmation_submissions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1')
      if (!columns.some((column) => column.name === 'revision')) conn.exec('ALTER TABLE confirmation_submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
      const auditColumns = conn.prepare('PRAGMA table_info(confirmation_commit_audits)').all() as Array<{ name: string }>
      if (!auditColumns.some((column) => column.name === 'session_id')) conn.exec('ALTER TABLE confirmation_commit_audits ADD COLUMN session_id TEXT NOT NULL DEFAULT \'\'')
      if (!auditColumns.some((column) => column.name === 'generation')) conn.exec('ALTER TABLE confirmation_commit_audits ADD COLUMN generation INTEGER NOT NULL DEFAULT 1')
      if (!auditColumns.some((column) => column.name === 'revision')) conn.exec('ALTER TABLE confirmation_commit_audits ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
      conn.exec("UPDATE confirmation_submissions SET session_id = owner_id WHERE session_id = ''")
      conn.exec('UPDATE confirmation_submissions SET revision = expected_revision WHERE revision = 1 AND expected_revision <> 1')
      conn.exec("UPDATE confirmation_commit_audits SET session_id = (SELECT session_id FROM confirmation_submissions WHERE confirmation_submissions.submission_id = confirmation_commit_audits.submission_id) WHERE session_id = ''")
      conn.exec('UPDATE confirmation_commit_audits SET generation = (SELECT generation FROM confirmation_submissions WHERE confirmation_submissions.submission_id = confirmation_commit_audits.submission_id)')
      conn.exec('UPDATE confirmation_commit_audits SET revision = (SELECT revision FROM confirmation_submissions WHERE confirmation_submissions.submission_id = confirmation_commit_audits.submission_id)')
    }
    version = 18
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 18) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V19_AGENT_HISTORY_SQL)
    version = 19
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 19) runInTransaction(conn, () => {
    // 兼容迁移编号重排（cloud-parity 恢复）前的 version=19 库：旧 v19 = usage attribution，
    // 没有 agent_history 表。先幂等补建基表（CREATE IF NOT EXISTS），再加列仅当缺列，
    // 否则 V20 的 ALTER 撞「no such table: agent_history_streams」（真机打包回归）。
    conn.exec(MIGRATION_V19_AGENT_HISTORY_SQL)
    const streamColumns = conn.prepare('PRAGMA table_info(agent_history_streams)').all() as Array<{ name: string }>
    if (!streamColumns.some((column) => column.name === 'session_id')) conn.exec(MIGRATION_V20_AGENT_HISTORY_SESSION_SQL)
    version = 20
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 20) runInTransaction(conn, () => {
    // Some lightweight migration fixtures omit turns; production databases always have it.
    const hasTurnsTable = (conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get() as unknown) !== undefined
    if (hasTurnsTable) conn.exec(MIGRATION_V21_AGENT_HISTORY_SESSION_BACKFILL_SQL)
    version = 21
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 21) runInTransaction(conn, () => {
    const hasTurnsTable = (conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get() as unknown) !== undefined
    if (hasTurnsTable) {
      const columns = conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'accepted_input_history_version')) conn.exec(MIGRATION_V22_TURN_INPUT_HISTORY_VERSION_SQL)
    }
    version = 22
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 22) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V23_DRIVER_DELIVERY_SQL)
    version = 23
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 23) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V24_SESSION_TRANSCRIPT_SQL)
    version = 24
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 24) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V25_SESSION_EXECUTION_QUEUE_SQL)
    version = 25
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 25) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V26_SESSION_TRANSCRIPT_RECONCILIATION_SQL)
    version = 26
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 26) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V27_ACCEPTED_TURN_CONTEXT_SQL)
    version = 27
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 27) runInTransaction(conn, () => {
    // Some focused migration fixtures intentionally contain only the tables owned by that test.
    // Upgrade whichever optional usage fact tables exist; full v27 databases contain both.
    const hasUsageSteps = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_step_facts'").get() !== undefined
    const hasUsageTurns = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_turn_facts'").get() !== undefined
    if (hasUsageSteps || hasUsageTurns) {
      // 兼容迁移编号重排前的 version=19 库：旧 v19 = 本迁移，归因列已存在。
      // 旧 v19 单事务原子加列、无部分应用态，故以 attribution_json 列为「已应用」标记整组跳过，
      // 否则重复 ALTER 撞 duplicate column（真机打包回归）。
      const stepColumns = hasUsageSteps
        ? conn.prepare('PRAGMA table_info(usage_step_facts)').all() as Array<{ name: string }>
        : []
      const alreadyAppliedByLegacyV19 = stepColumns.some((column) => column.name === 'attribution_json')
      if (!alreadyAppliedByLegacyV19) conn.exec(MIGRATION_V28_USAGE_ATTRIBUTION_SQL)
    }
    version = 28
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 28) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V29_CONTINUATIONS_SQL)
    version = 29
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 29) runInTransaction(conn, () => {
    const continuationColumns = conn.prepare("PRAGMA table_info(agent_continuations)").all() as Array<{ name: string }>
    if (!continuationColumns.some(({ name }) => name === 'target_start_token')) {
      conn.exec(MIGRATION_V30_CONTINUATION_START_TOKEN_SQL)
    }
    const turnsExists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turns'").get() !== undefined
    const turnColumns = turnsExists ? conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }> : []
    if (turnColumns.some(({ name }) => name === 'start_token')) {
      conn.exec(`UPDATE agent_continuations SET target_start_token = COALESCE(
        (SELECT start_token FROM turns WHERE turns.turn_id = agent_continuations.target_turn_id), ''
      ) WHERE target_start_token = ''`)
    }
    conn.exec("UPDATE agent_continuations SET status = 'interrupted' WHERE target_start_token = '' AND status IN ('pending','running')")
    version = 30
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 30) runInTransaction(conn, () => {
    // Product main also has a v30→v31 migration; preserve it before applying
    // the storage branch's independently numbered canonical projection step.
    conn.exec(MIGRATION_MAIN_V31_CONTINUATION_INTENTS_SQL)
    const turnsExists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turns'").get() !== undefined
    if (turnsExists) {
      const columns = new Set((conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!columns.has('retry_of_message_id')) conn.exec('ALTER TABLE turns ADD COLUMN retry_of_message_id TEXT')
      if (!columns.has('retry_of_invocation_id')) conn.exec('ALTER TABLE turns ADD COLUMN retry_of_invocation_id TEXT')
    }
    conn.exec(MIGRATION_V31_CANONICAL_PROJECTION_REPAIRS_SQL)
    version = 31
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 31) runInTransaction(conn, () => {
    const intentsExist = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuation_intents'").get() !== undefined
    if (intentsExist) {
      const columns = new Set((conn.prepare('PRAGMA table_info(continuation_intents)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!columns.has('continuation_context_json')) conn.exec(MIGRATION_MAIN_V32_CONTINUATION_CONTEXT_SQL)
    }
    conn.exec(MIGRATION_V32_AGENT_HISTORY_CURSOR_TABLES_SQL)
    const historyEventsExists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_events'").get() !== undefined
    const historyStreamsExists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_streams'").get() !== undefined
    if (historyEventsExists && historyStreamsExists) {
      const eventColumns = conn.prepare('PRAGMA table_info(agent_history_events)').all() as Array<{ name: string }>
      if (!eventColumns.some(({ name }) => name === 'session_id')) conn.exec('ALTER TABLE agent_history_events ADD COLUMN session_id TEXT')
      if (!eventColumns.some(({ name }) => name === 'commit_order')) conn.exec('ALTER TABLE agent_history_events ADD COLUMN commit_order INTEGER')
      if (!eventColumns.some(({ name }) => name === 'session_seq')) conn.exec('ALTER TABLE agent_history_events ADD COLUMN session_seq INTEGER')
      conn.exec(MIGRATION_V32_AGENT_HISTORY_SESSION_ORDER_SQL)
    }
    version = 32
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 32) runInTransaction(conn, () => {
    const tasksExist = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_tasks'").get() !== undefined
    const runsExist = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_task_runs'").get() !== undefined
    if (tasksExist && runsExist) {
      const taskColumns = new Set((conn.prepare('PRAGMA table_info(automation_tasks)').all() as Array<{ name: string }>).map(({ name }) => name))
      const runColumns = new Set((conn.prepare('PRAGMA table_info(automation_task_runs)').all() as Array<{ name: string }>).map(({ name }) => name))
      for (const name of ['work_dir', 'model_id', 'model_service_id', 'reasoning_effort']) {
        if (!taskColumns.has(name)) conn.exec(`ALTER TABLE automation_tasks ADD COLUMN ${name} TEXT`)
      }
      if (!runColumns.has('config_snapshot_json')) conn.exec('ALTER TABLE automation_task_runs ADD COLUMN config_snapshot_json TEXT')
    }
    const sessionsExist = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get() !== undefined
    if (sessionsExist) {
      const columns = new Set((conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!columns.has('fixed_work_dir')) conn.exec('ALTER TABLE sessions ADD COLUMN fixed_work_dir TEXT')
    }
    for (const table of ['usage_step_facts', 'usage_turn_facts']) {
      const exists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!exists) continue
      const columns = new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name))
      for (const name of ['model_id', 'provider_model_name', 'route_identity']) {
        if (!columns.has(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`)
      }
    }
    const hasSessions = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get() !== undefined
    if (hasSessions) {
      const columns = conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
      if (!columns.some(({ name }) => name === 'generation')) conn.exec(MIGRATION_V33_SESSION_GENERATION_SQL)
      else conn.exec("UPDATE sessions SET generation = lower(hex(randomblob(16))) WHERE generation = ''")
    }
    version = 33
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 33) runInTransaction(conn, () => {
    // The product main branch also stamped version 33, but used v31-v33 for
    // continuation/automation fields rather than canonical projection metadata.
    // A database created there can therefore reach this storage migration
    // without the History cursor columns or session incarnation required below.
    conn.exec(MIGRATION_V31_CANONICAL_PROJECTION_REPAIRS_SQL)
    conn.exec(MIGRATION_V32_AGENT_HISTORY_CURSOR_TABLES_SQL)
    const streamsExist = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_streams'").get() !== undefined
    const eventsExist = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_events'").get() !== undefined
    if (streamsExist && eventsExist) {
      const streamColumns = new Set((conn.prepare('PRAGMA table_info(agent_history_streams)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!streamColumns.has('session_id')) conn.exec('ALTER TABLE agent_history_streams ADD COLUMN session_id TEXT')
      const eventColumns = new Set((conn.prepare('PRAGMA table_info(agent_history_events)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!eventColumns.has('session_id')) conn.exec('ALTER TABLE agent_history_events ADD COLUMN session_id TEXT')
      if (!eventColumns.has('commit_order')) conn.exec('ALTER TABLE agent_history_events ADD COLUMN commit_order INTEGER')
      if (!eventColumns.has('session_seq')) conn.exec('ALTER TABLE agent_history_events ADD COLUMN session_seq INTEGER')
      conn.exec(MIGRATION_V32_AGENT_HISTORY_SESSION_ORDER_SQL)
    }
    const sessionsExist = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get() !== undefined
    if (sessionsExist) {
      const sessionColumns = new Set((conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!sessionColumns.has('generation')) conn.exec(MIGRATION_V33_SESSION_GENERATION_SQL)
      else conn.exec("UPDATE sessions SET generation = lower(hex(randomblob(16))) WHERE generation = ''")
    }
    const hasCache = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_session_projection_cache'").get() !== undefined
    if (!hasCache) {
      conn.exec(`CREATE TABLE canonical_session_projection_cache (
        session_id TEXT NOT NULL, cache_key TEXT NOT NULL, cache_version INTEGER NOT NULL,
        session_generation TEXT NOT NULL, session_seq INTEGER NOT NULL, commit_order INTEGER NOT NULL,
        watermark_event_id TEXT, watermark_invocation_id TEXT, event_count INTEGER NOT NULL,
        value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, cache_key))`)
    } else {
      const columns = conn.prepare('PRAGMA table_info(canonical_session_projection_cache)').all() as Array<{ name: string }>
      if (!columns.some(({ name }) => name === 'cache_version')) conn.exec(MIGRATION_V34_CANONICAL_SESSION_CACHE_VERSION_SQL)
      else conn.prepare('DELETE FROM canonical_session_projection_cache WHERE cache_version <> 1').run()
    }
    version = 34
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 34) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V35_SESSION_TURN_COMMIT_RECEIPTS_SQL)
    version = 35
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 35) runInTransaction(conn, () => {
    const hasClaims = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_execution_claims'").get() !== undefined
    const hasQueue = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_execution_queue'").get() !== undefined
    // Sparse migration fixtures and older development databases may never have enabled hosted sessions.
    if (hasClaims && hasQueue) conn.exec(MIGRATION_V36_SESSION_TRANSCRIPT_COMMIT_STATE_SQL)
    version = 36
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 36) runInTransaction(conn, () => {
    const hasSessions = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get() !== undefined
    const hasMessages = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get() !== undefined
    if (hasSessions && hasMessages) conn.exec(MIGRATION_V37_SESSION_PROJECTION_ELIGIBILITY_SQL)
    version = 37
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 37) runInTransaction(conn, () => {
    const hasSessions = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get() !== undefined
    const hasMessages = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get() !== undefined
    if (hasSessions && hasMessages) {
      const messageColumns = conn.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      if (!messageColumns.some((column) => column.name === 'content_storage_state')) {
        conn.exec("ALTER TABLE messages ADD COLUMN content_storage_state TEXT NOT NULL DEFAULT 'legacy' CHECK(content_storage_state IN ('legacy','canonical-backed-dual-write','canonical-backed-only'))")
      }
      conn.exec(MIGRATION_V38_SESSION_CONTENT_CUTOVER_SQL)
    }
    version = 38
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 38) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V39_SOURCE_TRUTH_SPILL_GC_SQL)
    version = 39
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 39) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V40_SOURCE_TRUTH_SPILL_GC_SCAN_SQL)
    version = 40
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 40) runInTransaction(conn, () => {
    const hasHistory = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_events'").get() !== undefined
    const hasCutover = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message_content_cutover'").get() !== undefined
    if (hasHistory && hasCutover) conn.exec(MIGRATION_V41_CANONICAL_HISTORY_API_ELIGIBILITY_SQL)
    version = 41
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 41) runInTransaction(conn, () => {
    const hasHistory = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_events'").get() !== undefined
    const hasCache = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_session_projection_cache'").get() !== undefined
    if (hasHistory && hasCache) conn.exec(MIGRATION_V42_CANONICAL_TRANSCRIPT_CACHE_INVALIDATION_SQL)
    version = 42
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 42) runInTransaction(conn, () => {
    const hasCache = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_session_projection_cache'").get() !== undefined
    if (hasCache) {
      const columns = conn.prepare('PRAGMA table_info(canonical_session_projection_cache)').all() as Array<{ name: string }>
      if (!columns.some(({ name }) => name === 'value_sha256')) conn.exec(MIGRATION_V43_CANONICAL_TRANSCRIPT_CACHE_CHECKSUM_SQL)
      conn.exec('DELETE FROM canonical_session_projection_cache')
    }
    version = 43
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 43) runInTransaction(conn, () => {
    const hasCutover = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message_content_cutover'").get() !== undefined
    const hasMessages = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get() !== undefined
    const hasHistory = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_events'").get() !== undefined
    const hasCache = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_session_projection_cache'").get() !== undefined
    if (hasCutover && hasMessages && hasHistory && hasCache) conn.exec(MIGRATION_V44_SESSION_CONTENT_WRITE_STOPPED_STATE_SQL)
    version = 44
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 44) runInTransaction(conn, () => {
    const hasCutover = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message_content_cutover'").get() !== undefined
    const hasProgress = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message_content_cleanup_progress'").get() !== undefined
    if (hasCutover && hasProgress) conn.exec(MIGRATION_V45_SESSION_CONTENT_COMPLETE_LEDGER_SQL)
    version = 45
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 45) runInTransaction(conn, () => {
    const hasMessages = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get() !== undefined
    if (hasMessages) conn.exec(MIGRATION_V46_CANONICAL_ONLY_MESSAGE_CONTENT_IMMUTABLE_SQL)
    const hasHistoryCursor = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_history_commit_cursor'").get() !== undefined
    const hasProjectionCache = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_session_projection_cache'").get() !== undefined
    const hasProjectionEligibility = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_session_projection_eligibility'").get() !== undefined
    const hasApiEligibility = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_session_api_context_eligibility'").get() !== undefined
    const hasCutover = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message_content_cutover'").get() !== undefined
    if (hasHistoryCursor && hasProjectionCache && hasProjectionEligibility && hasApiEligibility && hasCutover) {
      conn.exec(MIGRATION_V46_HISTORY_CURSOR_INVALIDATION_SQL)
    }
    version = 46
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 46) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V47_SESSION_PROJECTION_MIGRATION_SQL)
    version = 47
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 47) runInTransaction(conn, () => {
    const hasMigrationItems = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_projection_migration_items'").get() !== undefined
    if (hasMigrationItems) {
      const columns = new Set((conn.prepare('PRAGMA table_info(session_projection_migration_items)').all() as Array<{ name: string }>).map(({ name }) => name))
      const policyColumns: Array<[string, string]> = [
        ['legacy_owner', 'TEXT'], ['legacy_decision', 'TEXT'], ['legacy_user_behavior', 'TEXT'],
        ['legacy_user_message_zh', 'TEXT'], ['legacy_user_message_en', 'TEXT'], ['legacy_decided_at', 'INTEGER']
      ]
      for (const [name, type] of policyColumns) {
        if (!columns.has(name)) conn.exec(`ALTER TABLE session_projection_migration_items ADD COLUMN ${name} ${type}`)
      }
      conn.exec(MIGRATION_V48_SESSION_PROJECTION_LEGACY_POLICY_SQL)
    }
    version = 48
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 48) runInTransaction(conn, () => {
    const hasMigrationRuns = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_projection_migration_runs'").get() !== undefined
    if (hasMigrationRuns) {
      const columns = new Set((conn.prepare('PRAGMA table_info(session_projection_migration_runs)').all() as Array<{ name: string }>).map(({ name }) => name))
      const scopeColumns: Array<[string, string]> = [
        ['database_session_count', 'INTEGER NOT NULL DEFAULT -1'], ['migration_session_count', 'INTEGER NOT NULL DEFAULT -1'],
        ['excluded_internal_hidden_session_count', 'INTEGER NOT NULL DEFAULT -1'], ['internal_history_session_count', 'INTEGER NOT NULL DEFAULT -1'],
        ['internal_history_with_events_count', 'INTEGER NOT NULL DEFAULT -1'], ['internal_history_healthy_count', 'INTEGER NOT NULL DEFAULT -1'],
        ['internal_history_sha256', "TEXT NOT NULL DEFAULT ''"]
      ]
      for (const [name, type] of scopeColumns) {
        if (!columns.has(name)) conn.exec(`ALTER TABLE session_projection_migration_runs ADD COLUMN ${name} ${type}`)
      }
      // A pre-v49 active census has no auditable scope digest and may contain internal-only sessions.
      // Do not resume or hold the single-run lock with an inventory from the old cohort definition.
      conn.exec(`UPDATE session_projection_migration_runs SET status='needs_attention'
        WHERE status IN ('running','paused','needs_retry') AND internal_history_sha256=''`)
    }
    version = 49
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 49) runInTransaction(conn, () => {
    conn.exec(MIGRATION_V50_HISTORY_RECOVERY_WORK_SQL)
    const streamColumns = new Set((conn.prepare("PRAGMA table_info('agent_history_streams')").all() as Array<{ name: string }>).map(({ name }) => name))
    const eventColumns = new Set((conn.prepare("PRAGMA table_info('agent_history_events')").all() as Array<{ name: string }>).map(({ name }) => name))
    if (['invocation_id', 'version', 'session_id'].every((name) => streamColumns.has(name)) &&
      ['invocation_id', 'sequence', 'kind'].every((name) => eventColumns.has(name))) {
      conn.exec(MIGRATION_V50_HISTORY_RECOVERY_WORK_TRIGGERS_SQL)
    }
    version = 50
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 50) runInTransaction(conn, () => {
    for (const [table, column] of MIGRATION_V51_USAGE_MODEL_IDENTITY_COLUMNS) {
      const tableExists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!tableExists) continue
      const columns = new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name))
      if (!columns.has(column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
    }
    version = 51
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 51) runInTransaction(conn, () => {
    const hasMigrationRuns = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_projection_migration_runs'").get() !== undefined
    if (hasMigrationRuns) {
      const columns = new Set((conn.prepare('PRAGMA table_info(session_projection_migration_runs)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!columns.has('cancelled_at')) conn.exec(MIGRATION_V52_SESSION_PROJECTION_MIGRATION_CANCEL_SQL)
    }
    version = 52
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  if (version === 52) runInTransaction(conn, () => {
    // 0.2.4 stamped some product-main schema-v33 profiles as storage-v46 after
    // skipping the colliding main migrations. Repair missing additive DDL by
    // shape so those already-upgraded profiles remain usable on 0.2.5+.
    const tableExists = (table: string) => conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
    const ensureColumns = (table: string, definitions: Array<[string, string]>) => {
      if (!tableExists(table)) return
      const columns = new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name))
      for (const [name, type] of definitions) {
        if (!columns.has(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }
    }

    conn.exec(MIGRATION_MAIN_V31_CONTINUATION_INTENTS_SQL)
    conn.exec(MIGRATION_V31_CANONICAL_PROJECTION_REPAIRS_SQL)
    ensureColumns('turns', [['retry_of_message_id', 'TEXT'], ['retry_of_invocation_id', 'TEXT']])
    ensureColumns('continuation_intents', [['continuation_context_json', 'TEXT']])
    ensureColumns('sessions', [['fixed_work_dir', 'TEXT']])
    if (tableExists('sessions')) {
      const columns = new Set((conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(({ name }) => name))
      if (!columns.has('generation')) conn.exec(MIGRATION_V33_SESSION_GENERATION_SQL)
      else conn.exec("UPDATE sessions SET generation = lower(hex(randomblob(16))) WHERE generation = ''")
    }
    ensureColumns('automation_tasks', [['work_dir', 'TEXT'], ['model_id', 'TEXT'], ['model_service_id', 'TEXT'], ['reasoning_effort', 'TEXT']])
    ensureColumns('automation_task_runs', [['config_snapshot_json', 'TEXT']])
    ensureColumns('usage_step_facts', [['model_id', 'TEXT'], ['provider_model_name', 'TEXT'], ['route_identity', 'TEXT']])
    ensureColumns('usage_turn_facts', [['model_id', 'TEXT'], ['provider_model_name', 'TEXT'], ['route_identity', 'TEXT']])

    conn.exec(MIGRATION_V32_AGENT_HISTORY_CURSOR_TABLES_SQL)
    conn.exec(MIGRATION_V50_HISTORY_RECOVERY_WORK_SQL)
    ensureColumns('agent_history_streams', [['session_id', 'TEXT']])
    ensureColumns('agent_history_events', [['session_id', 'TEXT'], ['commit_order', 'INTEGER'], ['session_seq', 'INTEGER']])
    if (tableExists('agent_history_streams') && tableExists('agent_history_events')) {
      conn.exec(MIGRATION_V50_HISTORY_RECOVERY_WORK_TRIGGERS_SQL)
    }
    if (tableExists('agent_history_streams') && tableExists('agent_history_events')) {
      // Existing History payload_json values can be very large. Do not rewrite
      // every legacy event during startup just to populate optional ordering
      // metadata; the append path assigns these fields for new events. Legacy
      // rows remain intact and readable by invocation id.
      conn.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_history_events_commit_order
        ON agent_history_events(commit_order);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_history_events_session_seq
        ON agent_history_events(session_id, session_seq)
        WHERE session_id IS NOT NULL AND session_seq IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_history_events_session_commit_order
        ON agent_history_events(session_id, commit_order);`)
    }
    const hasHistoryCursor = tableExists('agent_history_commit_cursor')
    const hasProjectionCache = tableExists('canonical_session_projection_cache')
    const hasProjectionEligibility = tableExists('canonical_session_projection_eligibility')
    const hasApiEligibility = tableExists('canonical_session_api_context_eligibility')
    const hasCutover = tableExists('session_message_content_cutover')
    if (hasHistoryCursor && hasProjectionCache && hasProjectionEligibility && hasApiEligibility && hasCutover) {
      conn.exec(MIGRATION_V46_HISTORY_CURSOR_INVALIDATION_SQL)
    }

    version = 53
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
  })
  } catch (migrationError) {
    if (replayedV46Triggers.length > 0) {
      try {
        conn.exec(MIGRATION_V46_HISTORY_CURSOR_INVALIDATION_TRIGGERS_SQL)
      } catch (restoreError) {
        throw new AggregateError([migrationError, restoreError], 'Migration replay failed and v46 History cursor triggers could not be restored')
      }
    }
    throw migrationError
  }
}
