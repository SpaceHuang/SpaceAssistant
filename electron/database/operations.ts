import { randomUUID } from 'crypto'
import type { Message, MessageStatus, Session } from '../../src/shared/domainTypes'
import type { SessionUsage } from '../../src/shared/sessionUsage'
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_SESSION_SKILLS_STATE,
  normalizeSessionSkillsState
} from '../../src/shared/domainTypes'
import {
  rowToMessage,
  serializeAttachmentsForDb,
  serializeContentSegmentsForDb,
  serializeSkillHintsForDb,
  serializeThinkingForDb,
  serializeToolCallsForDb,
  serializeToolUseForDb
} from '../messageCodec'
import { getDbConnection, type AppDatabase } from './sqliteStore'

type SessionRow = {
  id: string
  name: string
  preview: string
  model: string
  llm_service_id: string | null
  temperature: number
  max_tokens: number
  created_at: number
  updated_at: number
  message_count: number
  skills_state: string
  metadata: string
  schema_version: number
  work_dir_profile_id: string | null
}

type MessageRow = {
  id: string
  session_id: string
  role: string
  content: string
  tool_use: string | null
  tool_calls: string | null
  thinking: string | null
  content_segments: string | null
  skill_hints: string | null
  attachments: string | null
  images_delivered_to_api: number | null
  status: string
  schema_version: number
  timestamp: number
  sequence: number
}

function parseJsonObject<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToSession(row: SessionRow): Session {
  return normalizeSession({
    id: row.id,
    name: row.name,
    preview: row.preview,
    model: row.model,
    ...(row.llm_service_id ? { llmServiceId: row.llm_service_id } : {}),
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    skillsState: parseJsonObject(row.skills_state, { ...DEFAULT_SESSION_SKILLS_STATE }),
    metadata: parseJsonObject(row.metadata, {}),
    schemaVersion: row.schema_version,
    ...(row.work_dir_profile_id ? { workDirProfileId: row.work_dir_profile_id } : {})
  })
}

function rowToStoredMessage(row: MessageRow): Message {
  return rowToMessage({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolUse: row.tool_use,
    toolCalls: row.tool_calls,
    thinking: row.thinking,
    contentSegments: row.content_segments,
    skillHints: row.skill_hints,
    attachments: row.attachments,
    imagesDeliveredToApi: row.images_delivered_to_api == null ? null : row.images_delivered_to_api === 1,
    status: row.status,
    schemaVersion: row.schema_version,
    timestamp: row.timestamp,
    sequence: row.sequence
  })
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    skillsState: normalizeSessionSkillsState(session.skillsState)
  }
}

export function listSessions(db: AppDatabase): Session[] {
  const conn = getDbConnection(db)
  const rows = conn.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[]
  return rows.map(rowToSession)
}

export function getSession(db: AppDatabase, sessionId: string): Session | undefined {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined
  return row ? rowToSession(row) : undefined
}

export function createSession(
  db: AppDatabase,
  input: {
    name: string
    model?: string
    llmServiceId?: string
    temperature?: number
    maxTokens?: number
    metadata?: Record<string, unknown>
    workDirProfileId?: string
  }
): Session {
  const now = Date.now()
  const id = randomUUID()
  const model = input.model ?? 'claude-sonnet-4-20250514'
  const temperature = input.temperature ?? DEFAULT_LLM_TEMPERATURE
  const maxTokens = input.maxTokens ?? 4096
  const session: Session = {
    id,
    name: input.name,
    preview: '',
    model,
    ...(input.llmServiceId ? { llmServiceId: input.llmServiceId } : {}),
    temperature,
    maxTokens,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    skillsState: { ...DEFAULT_SESSION_SKILLS_STATE },
    metadata: input.metadata ? { ...input.metadata } : {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workDirProfileId: input.workDirProfileId
  }

  const conn = getDbConnection(db)
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
      preview: session.preview,
      model: session.model,
      llmServiceId: session.llmServiceId ?? null,
      temperature: session.temperature,
      maxTokens: session.maxTokens,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      skillsState: JSON.stringify(session.skillsState),
      metadata: JSON.stringify(session.metadata),
      schemaVersion: session.schemaVersion,
      workDirProfileId: session.workDirProfileId ?? null
    })
  db.save()
  return session
}

export function updateSession(
  db: AppDatabase,
  sessionId: string,
  patch: Partial<
    Pick<
      Session,
      | 'name'
      | 'preview'
      | 'model'
      | 'llmServiceId'
      | 'temperature'
      | 'maxTokens'
      | 'metadata'
      | 'messageCount'
      | 'skillsState'
      | 'workDirProfileId'
    >
  >
): Session | undefined {
  const cur = getSession(db, sessionId)
  if (!cur) return undefined
  const next: Session = {
    ...cur,
    ...patch,
    metadata: patch.metadata ?? cur.metadata,
    skillsState: patch.skillsState ? normalizeSessionSkillsState(patch.skillsState) : cur.skillsState,
    updatedAt: Date.now()
  }

  const conn = getDbConnection(db)
  conn
    .prepare(
      `UPDATE sessions SET
        name = @name,
        preview = @preview,
        model = @model,
        llm_service_id = @llmServiceId,
        temperature = @temperature,
        max_tokens = @maxTokens,
        updated_at = @updatedAt,
        message_count = @messageCount,
        skills_state = @skillsState,
        metadata = @metadata,
        work_dir_profile_id = @workDirProfileId
      WHERE id = @id`
    )
    .run({
      id: next.id,
      name: next.name,
      preview: next.preview,
      model: next.model,
      llmServiceId: next.llmServiceId ?? null,
      temperature: next.temperature,
      maxTokens: next.maxTokens,
      updatedAt: next.updatedAt,
      messageCount: next.messageCount,
      skillsState: JSON.stringify(next.skillsState),
      metadata: JSON.stringify(next.metadata),
      workDirProfileId: next.workDirProfileId ?? null
    })
  db.save()
  return next
}

export function deleteSession(db: AppDatabase, sessionId: string): void {
  const conn = getDbConnection(db)
  conn.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  deleteSessionUsage(db, sessionId)
  db.flushSave()
}

export function getSessionUsage(db: AppDatabase, sessionId: string): SessionUsage | undefined {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT data FROM session_usages WHERE session_id = ?').get(sessionId) as
    | { data: string }
    | undefined
  if (!row) return undefined
  return parseJsonObject<SessionUsage>(row.data, { input_tokens: 0 })
}

export function setSessionUsage(db: AppDatabase, sessionId: string, usage: SessionUsage): void {
  const conn = getDbConnection(db)
  conn
    .prepare('INSERT OR REPLACE INTO session_usages (session_id, data) VALUES (?, ?)')
    .run(sessionId, JSON.stringify(usage))
  db.save()
}

export function deleteSessionUsage(db: AppDatabase, sessionId: string): void {
  const conn = getDbConnection(db)
  conn.prepare('DELETE FROM session_usages WHERE session_id = ?').run(sessionId)
}

export function getAllSessionUsages(db: AppDatabase): Record<string, SessionUsage> {
  const conn = getDbConnection(db)
  const rows = conn.prepare('SELECT session_id, data FROM session_usages').all() as Array<{
    session_id: string
    data: string
  }>
  const out: Record<string, SessionUsage> = {}
  for (const row of rows) {
    out[row.session_id] = parseJsonObject<SessionUsage>(row.data, { input_tokens: 0 })
  }
  return out
}

export function getMessages(db: AppDatabase, sessionId: string, limit = 500, offset = 0): Message[] {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY sequence ASC
       LIMIT ? OFFSET ?`
    )
    .all(sessionId, limit, offset) as MessageRow[]
  return rows.map(rowToStoredMessage)
}

export function appendMessage(db: AppDatabase, msg: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }): Message {
  const conn = getDbConnection(db)
  const seqRow = conn
    .prepare('SELECT COALESCE(MAX(sequence), -1) AS maxSeq FROM messages WHERE session_id = ?')
    .get(msg.sessionId) as { maxSeq: number }
  const maxSeq = seqRow.maxSeq + 1

  const full: Message = {
    ...msg,
    schemaVersion: msg.schemaVersion ?? CURRENT_SCHEMA_VERSION
  }

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
      id: full.id,
      sessionId: full.sessionId,
      role: full.role,
      content: full.content,
      toolUse: serializeToolUseForDb(full.toolUse),
      toolCalls: serializeToolCallsForDb(full.toolCalls),
      thinking: serializeThinkingForDb(full.thinking),
      contentSegments: serializeContentSegmentsForDb(full.contentSegments),
      skillHints: serializeSkillHintsForDb(full.skillHints),
      attachments: serializeAttachmentsForDb(full.attachments),
      imagesDeliveredToApi: full.imagesDeliveredToApi == null ? null : full.imagesDeliveredToApi ? 1 : 0,
      status: full.status,
      schemaVersion: full.schemaVersion,
      timestamp: full.timestamp,
      sequence: maxSeq
    })

  const countRow = conn
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?')
    .get(full.sessionId) as { c: number }
  updateSession(db, full.sessionId, {
    preview: full.content.slice(0, 120),
    messageCount: countRow.c
  })
  return full
}

export function deleteQueuedUserMessage(
  db: AppDatabase,
  messageId: string
): { ok: true; sessionId: string } | { ok: false; error: string } {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined
  if (!row) return { ok: false, error: 'message_not_found' }
  if (row.role !== 'user' || row.status !== 'queued') return { ok: false, error: 'message_not_queued' }

  const sessionId = row.session_id
  conn.prepare('DELETE FROM messages WHERE id = ?').run(messageId)

  const last = conn
    .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1')
    .get(sessionId) as { content: string } | undefined
  const countRow = conn
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?')
    .get(sessionId) as { c: number }

  updateSession(db, sessionId, {
    messageCount: countRow.c,
    preview: last ? last.content.slice(0, 120) : ''
  })
  return { ok: true, sessionId }
}

export function updateMessageContent(
  db: AppDatabase,
  messageId: string,
  patch: Partial<
    Pick<
      Message,
      | 'content'
      | 'status'
      | 'toolUse'
      | 'thinking'
      | 'toolCalls'
      | 'contentSegments'
      | 'skillHints'
      | 'attachments'
      | 'imagesDeliveredToApi'
    >
  >
): void {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined
  if (!row) return

  const content = patch.content ?? row.content
  const status = patch.status ?? (row.status as MessageStatus)
  const toolUse = patch.toolUse !== undefined ? serializeToolUseForDb(patch.toolUse) : row.tool_use
  const toolCalls = patch.toolCalls !== undefined ? serializeToolCallsForDb(patch.toolCalls) : row.tool_calls
  const thinking = patch.thinking !== undefined ? serializeThinkingForDb(patch.thinking) : row.thinking
  const contentSegments =
    patch.contentSegments !== undefined ? serializeContentSegmentsForDb(patch.contentSegments) : row.content_segments
  const skillHints = patch.skillHints !== undefined ? serializeSkillHintsForDb(patch.skillHints) : row.skill_hints
  const attachments = patch.attachments !== undefined ? serializeAttachmentsForDb(patch.attachments) : row.attachments
  const imagesDeliveredToApi =
    patch.imagesDeliveredToApi !== undefined
      ? patch.imagesDeliveredToApi == null
        ? null
        : patch.imagesDeliveredToApi
          ? 1
          : 0
      : row.images_delivered_to_api

  conn
    .prepare(
      `UPDATE messages SET
        content = @content,
        status = @status,
        tool_use = @toolUse,
        tool_calls = @toolCalls,
        thinking = @thinking,
        content_segments = @contentSegments,
        skill_hints = @skillHints,
        attachments = @attachments,
        images_delivered_to_api = @imagesDeliveredToApi
      WHERE id = @id`
    )
    .run({
      id: messageId,
      content,
      status,
      toolUse,
      toolCalls,
      thinking,
      contentSegments,
      skillHints,
      attachments,
      imagesDeliveredToApi
    })
  db.save()
}

export function getConfigValue(db: AppDatabase, key: string): string | undefined {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT value FROM configs WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setConfigValue(db: AppDatabase, key: string, value: string): void {
  const now = Date.now()
  const conn = getDbConnection(db)
  const cur = conn.prepare('SELECT created_at FROM configs WHERE key = ?').get(key) as { created_at: number } | undefined
  conn
    .prepare(
      `INSERT INTO configs (key, value, created_at, updated_at) VALUES (@key, @value, @createdAt, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run({
      key,
      value,
      createdAt: cur?.created_at ?? now,
      updatedAt: now
    })
  db.save()
}

export function deleteConfigValue(db: AppDatabase, key: string): boolean {
  const conn = getDbConnection(db)
  const result = conn.prepare('DELETE FROM configs WHERE key = ?').run(key)
  if (result.changes === 0) return false
  db.save()
  return true
}

export function appendSearchHistory(db: AppDatabase, query: string): void {
  const conn = getDbConnection(db)
  conn.prepare('INSERT INTO search_history (id, query, timestamp) VALUES (?, ?, ?)').run(
    randomUUID(),
    query,
    Date.now()
  )
  db.save()
}

export function listSearchHistory(db: AppDatabase, limit = 20): string[] {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare('SELECT query FROM search_history ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as Array<{ query: string }>
  return rows.map((r) => r.query)
}

export type MessageSearchHit = {
  messageId: string
  sessionId: string
  content: string
  sessionName: string
}

export function searchMessages(
  db: AppDatabase,
  query: string,
  activeProfileId: string,
  limit = 50
): MessageSearchHit[] {
  const conn = getDbConnection(db)
  const q = query.trim()
  if (!q) return []

  const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const likePattern = `%${escaped}%`
  const rows = conn
    .prepare(
      `SELECT m.id AS message_id, m.session_id, m.content, s.name AS session_name, s.work_dir_profile_id
       FROM messages m
       INNER JOIN sessions s ON s.id = m.session_id
       WHERE m.content LIKE ? ESCAPE '\\'
         AND (s.work_dir_profile_id IS NULL OR s.work_dir_profile_id = ?)
       ORDER BY m.timestamp DESC
       LIMIT ?`
    )
    .all(likePattern, activeProfileId, limit) as Array<{
    message_id: string
    session_id: string
    content: string
    session_name: string
  }>

  return rows.map((row) => ({
    messageId: row.message_id,
    sessionId: row.session_id,
    content: row.content,
    sessionName: row.session_name
  }))
}

export function listSessionsMissingWorkDirProfile(db: AppDatabase): Session[] {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare('SELECT * FROM sessions WHERE work_dir_profile_id IS NULL OR work_dir_profile_id = ?')
    .all('') as SessionRow[]
  return rows.map(rowToSession)
}
