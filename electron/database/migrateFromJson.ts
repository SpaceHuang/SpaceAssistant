import fs from 'fs'
import path from 'path'
import type { Session } from '../../src/shared/domainTypes'
import {
  DEFAULT_SESSION_SKILLS_STATE,
  normalizeSessionSkillsState
} from '../../src/shared/domainTypes'
import { loadSnapshotFromJson } from './jsonSnapshot'
import { SCHEMA_META_KEYS } from './schema'
import { getDbConnection, getSchemaMeta, isDatabaseEmpty, setSchemaMeta, type AppDatabase } from './sqliteStore'
import type { DbSnapshot, StoredMessage } from './types'

export type MigrationResult = {
  sessions: number
  messages: number
  configs: number
  searchHistory: number
  sessionUsages: number
  durationMs: number
  jsonPath: string
  jsonBytes: number
}

const DEFAULT_RECOVERED_MODEL = 'claude-sonnet-4-20250514'

export type PreparedMigrationSnapshot = {
  snapshot: DbSnapshot
  recoveredSessionIds: string[]
  skippedMessageCount: number
}

/** Repair inconsistent legacy JSON (orphan messages, duplicate sessions) before SQLite import. */
export function prepareSnapshotForMigration(snapshot: DbSnapshot): PreparedMigrationSnapshot {
  const sessionsById = new Map<string, Session>()
  for (const session of snapshot.sessions) {
    if (session?.id && typeof session.id === 'string' && !sessionsById.has(session.id)) {
      sessionsById.set(session.id, session)
    }
  }

  const messages: StoredMessage[] = []
  let skippedMessageCount = 0
  for (const message of snapshot.messages) {
    if (!message?.id || !message.sessionId) {
      skippedMessageCount++
      continue
    }
    messages.push(message)
  }

  const defaultModel =
    [...sessionsById.values()].find((s) => typeof s.model === 'string' && s.model)?.model ??
    DEFAULT_RECOVERED_MODEL

  const referencedSessionIds = new Set<string>()
  for (const message of messages) referencedSessionIds.add(message.sessionId)
  for (const sessionId of Object.keys(snapshot.sessionUsages ?? {})) referencedSessionIds.add(sessionId)

  const recoveredSessionIds: string[] = []
  for (const sessionId of referencedSessionIds) {
    if (sessionsById.has(sessionId)) continue
    const related = messages.filter((m) => m.sessionId === sessionId)
    const ts = related.reduce((min, m) => Math.min(min, m.timestamp), Date.now())
    sessionsById.set(sessionId, {
      id: sessionId,
      name: '(迁移恢复)',
      preview: related[0]?.content?.slice(0, 80) ?? '',
      model: defaultModel,
      temperature: 0.7,
      maxTokens: 4096,
      createdAt: ts,
      updatedAt: ts,
      messageCount: related.length,
      skillsState: { ...DEFAULT_SESSION_SKILLS_STATE },
      metadata: { migrationRecovered: true },
      schemaVersion: 1
    })
    recoveredSessionIds.push(sessionId)
  }

  return {
    snapshot: {
      ...snapshot,
      sessions: [...sessionsById.values()],
      messages
    },
    recoveredSessionIds,
    skippedMessageCount
  }
}

function insertSession(conn: ReturnType<typeof getDbConnection>, session: Session): void {
  const skillsState = normalizeSessionSkillsState(session.skillsState ?? DEFAULT_SESSION_SKILLS_STATE)
  conn
    .prepare(
      `INSERT INTO sessions (
        id, name, preview, model, llm_service_id, temperature, max_tokens,
        created_at, updated_at, message_count, skills_state, metadata, schema_version, work_dir_profile_id
      ) VALUES (
        @id, @name, @preview, @model, @llmServiceId, @temperature, @maxTokens,
        @createdAt, @updatedAt, @messageCount, @skillsState, @metadata, @schemaVersion, @workDirProfileId
      )`
    )
    .run({
      id: session.id,
      name: session.name,
      preview: session.preview ?? '',
      model: session.model,
      llmServiceId: session.llmServiceId ?? null,
      temperature: session.temperature,
      maxTokens: session.maxTokens,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount ?? 0,
      skillsState: JSON.stringify(skillsState),
      metadata: JSON.stringify(session.metadata ?? {}),
      schemaVersion: session.schemaVersion,
      workDirProfileId: session.workDirProfileId ?? null
    })
}

function insertMessage(conn: ReturnType<typeof getDbConnection>, row: StoredMessage): void {
  conn
    .prepare(
      `INSERT INTO messages (
        id, session_id, role, content, tool_use, tool_calls, thinking,
        content_segments, skill_hints, attachments, images_delivered_to_api,
        status, schema_version, timestamp, sequence
      ) VALUES (
        @id, @sessionId, @role, @content, @toolUse, @toolCalls, @thinking,
        @contentSegments, @skillHints, @attachments, @imagesDeliveredToApi,
        @status, @schemaVersion, @timestamp, @sequence
      )`
    )
    .run({
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      toolUse: row.toolUse,
      toolCalls: row.toolCalls,
      thinking: row.thinking,
      contentSegments: row.contentSegments ?? null,
      skillHints: row.skillHints ?? null,
      attachments: row.attachments ?? null,
      imagesDeliveredToApi: row.imagesDeliveredToApi == null ? null : row.imagesDeliveredToApi ? 1 : 0,
      status: row.status,
      schemaVersion: row.schemaVersion,
      timestamp: row.timestamp,
      sequence: row.sequence
    })
}

function importSnapshot(conn: ReturnType<typeof getDbConnection>, snapshot: DbSnapshot): void {
  const insertConfig = conn.prepare(
    'INSERT INTO configs (key, value, created_at, updated_at) VALUES (@key, @value, @createdAt, @updatedAt)'
  )
  const insertSearch = conn.prepare(
    'INSERT INTO search_history (id, query, timestamp) VALUES (@id, @query, @timestamp)'
  )
  const insertUsage = conn.prepare('INSERT INTO session_usages (session_id, data) VALUES (@sessionId, @data)')

  const tx = conn.transaction(() => {
    for (const [key, entry] of Object.entries(snapshot.configs)) {
      insertConfig.run({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      })
    }
    for (const session of snapshot.sessions) {
      insertSession(conn, session)
    }
    for (const message of snapshot.messages) {
      insertMessage(conn, message)
    }
    for (const item of snapshot.searchHistory) {
      insertSearch.run(item)
    }
    for (const [sessionId, usage] of Object.entries(snapshot.sessionUsages ?? {})) {
      insertUsage.run({ sessionId, data: JSON.stringify(usage) })
    }
  })
  tx()
}

function verifyCounts(conn: ReturnType<typeof getDbConnection>, snapshot: DbSnapshot): void {
  const sessionCount = (conn.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c
  const messageCount = (conn.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c
  const configCount = (conn.prepare('SELECT COUNT(*) AS c FROM configs').get() as { c: number }).c
  const searchCount = (conn.prepare('SELECT COUNT(*) AS c FROM search_history').get() as { c: number }).c
  const usageCount = (conn.prepare('SELECT COUNT(*) AS c FROM session_usages').get() as { c: number }).c

  if (sessionCount !== snapshot.sessions.length) {
    throw new Error(`Migration verify failed: sessions ${sessionCount} !== ${snapshot.sessions.length}`)
  }
  if (messageCount !== snapshot.messages.length) {
    throw new Error(`Migration verify failed: messages ${messageCount} !== ${snapshot.messages.length}`)
  }
  if (configCount !== Object.keys(snapshot.configs).length) {
    throw new Error(`Migration verify failed: configs ${configCount} !== ${Object.keys(snapshot.configs).length}`)
  }
  if (searchCount !== snapshot.searchHistory.length) {
    throw new Error(`Migration verify failed: search_history ${searchCount} !== ${snapshot.searchHistory.length}`)
  }
  const expectedUsages = Object.keys(snapshot.sessionUsages ?? {}).length
  if (usageCount !== expectedUsages) {
    throw new Error(`Migration verify failed: session_usages ${usageCount} !== ${expectedUsages}`)
  }
}

function sampleVerifyMessages(conn: ReturnType<typeof getDbConnection>, snapshot: DbSnapshot): void {
  const samples = snapshot.messages.slice(0, 3)
  for (const sample of samples) {
    const row = conn
      .prepare('SELECT content FROM messages WHERE id = ?')
      .get(sample.id) as { content: string } | undefined
    if (!row || row.content !== sample.content) {
      throw new Error(`Migration sample verify failed for message ${sample.id}`)
    }
  }
}

function renameJsonBackup(jsonPath: string): string {
  const backupPath = `${jsonPath}.migrated-${Date.now()}`
  fs.renameSync(jsonPath, backupPath)
  return backupPath
}

export function migrateFromJsonIfNeeded(db: AppDatabase, jsonPath: string): MigrationResult | null {
  if (!fs.existsSync(jsonPath)) return null

  const conn = getDbConnection(db)
  if (getSchemaMeta(conn, SCHEMA_META_KEYS.migratedFromJsonAt)) return null
  if (!isDatabaseEmpty(conn)) return null

  const started = Date.now()
  const jsonStat = fs.statSync(jsonPath)
  const rawSnapshot = loadSnapshotFromJson(jsonPath)
  const { snapshot, recoveredSessionIds, skippedMessageCount } = prepareSnapshotForMigration(rawSnapshot)
  if (recoveredSessionIds.length > 0 || skippedMessageCount > 0) {
    console.warn('[database] migration repaired JSON snapshot', {
      recoveredSessionIds,
      skippedMessageCount
    })
  }

  try {
    importSnapshot(conn, snapshot)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`JSON migration failed for ${jsonPath}: ${msg}`)
  }
  verifyCounts(conn, snapshot)
  sampleVerifyMessages(conn, snapshot)

  const migratedAt = String(Date.now())
  setSchemaMeta(conn, SCHEMA_META_KEYS.migratedFromJsonAt, migratedAt)
  setSchemaMeta(conn, SCHEMA_META_KEYS.migratedFromJsonPath, jsonPath)

  db.flushSave()
  const backupPath = renameJsonBackup(jsonPath)

  console.info('[database] migrated JSON to SQLite', {
    jsonPath,
    backupPath,
    sessions: snapshot.sessions.length,
    messages: snapshot.messages.length,
    configs: Object.keys(snapshot.configs).length,
    durationMs: Date.now() - started
  })

  return {
    sessions: snapshot.sessions.length,
    messages: snapshot.messages.length,
    configs: Object.keys(snapshot.configs).length,
    searchHistory: snapshot.searchHistory.length,
    sessionUsages: Object.keys(snapshot.sessionUsages ?? {}).length,
    durationMs: Date.now() - started,
    jsonPath: backupPath,
    jsonBytes: jsonStat.size
  }
}
