import { randomUUID } from 'crypto'
import type { Message, MessageStatus, Session } from '../../src/shared/domainTypes'
import type { SessionUsage } from '../../src/shared/sessionUsage'
import type { TurnExecutionConfig } from '../../src/shared/assistantFactAggregator'
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
import { changesToNumber, runInTransaction } from './transaction'
import { isMessageEligibleForChatApi } from '../../src/shared/chatMessageQueue'
import { queueInputFingerprint } from '../queueInputFingerprint'
import {
  estimateThinkingTokensFromMessage,
  estimateTokensFromHistoryImages
} from '../../src/shared/contextUsageEstimate'

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
  const metadata = patch.metadata ?? cur.metadata
  const next: Session = {
    ...cur,
    ...patch,
    metadata,
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
  runInTransaction(conn, () => {
    conn.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  })
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

/**
 * 供 turn prepare 的 skill 路由使用的最近上下文。这里不能复用 `getMessages()`：它按升序
 * 截断会在超长会话中取到最早的消息。SQL 先按与 `getTurnContext()` 一致的资格和逻辑顺序
 * 取尾部窗口，避免为路由反序列化整段历史。
 */
export function getRecentTurnRoutingMessages(
  db: AppDatabase,
  sessionId: string,
  limit = 50,
  boundarySequence?: number,
  excludeMessageIds: string[] = []
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const conn = getDbConnection(db)
  const excludedClause = excludeMessageIds.length
    ? ` AND m.id NOT IN (${excludeMessageIds.map(() => '?').join(', ')})`
    : ''
  const rows = conn.prepare(
    `SELECT m.role, m.content,
            CASE WHEN m.role = 'user' THEN COALESCE((
              SELECT MIN(anchor.sequence)
              FROM turns linked_turn
              JOIN messages anchor ON anchor.id = linked_turn.assistant_message_id AND anchor.session_id = linked_turn.session_id
              WHERE linked_turn.session_id = m.session_id AND linked_turn.user_message_id = m.id
            ), m.sequence) ELSE m.sequence END AS context_sequence
     FROM messages m
     WHERE m.session_id = ?
       AND (? IS NULL OR m.sequence <= ?)
       AND m.role IN ('user', 'assistant')
       AND m.status NOT IN ('streaming', 'queued')
       ${excludedClause}
       AND (m.role != 'assistant' OR NOT EXISTS (
         SELECT 1 FROM turns linked_turn
         WHERE linked_turn.session_id = m.session_id
           AND linked_turn.assistant_message_id = m.id
       ) OR EXISTS (
         SELECT 1 FROM turns linked_turn
         WHERE linked_turn.session_id = m.session_id
           AND linked_turn.assistant_message_id = m.id
           AND linked_turn.state = 'terminal'
       ))
       AND TRIM(m.content) != ''
     ORDER BY context_sequence DESC,
              CASE m.role WHEN 'user' THEN 0 ELSE 1 END DESC,
              m.id DESC
     LIMIT ?`
  ).all(sessionId, boundarySequence ?? null, boundarySequence ?? null, ...excludeMessageIds, limit) as Array<Pick<MessageRow, 'role' | 'content'>>
  return rows.reverse().map(({ role, content }) => ({
    // SQL 已将 role 限定为 user/assistant；显式收窄以维持跨层消息类型边界。
    role: role as 'user' | 'assistant',
    content
  }))
}

/** 与 turn 上下文相同的边界及资格规则下，是否存在图片附件。 */
export function hasVisionInTurnRoutingContext(
  db: AppDatabase,
  sessionId: string,
  boundarySequence?: number,
  excludeMessageIds: string[] = []
): boolean {
  const conn = getDbConnection(db)
  const excludedClause = excludeMessageIds.length
    ? ` AND m.id NOT IN (${excludeMessageIds.map(() => '?').join(', ')})`
    : ''
  const row = conn.prepare(
    `SELECT 1
     FROM messages m
     WHERE m.session_id = ?
       AND (? IS NULL OR m.sequence <= ?)
       AND m.role IN ('user', 'assistant')
       AND m.status NOT IN ('streaming', 'queued')
       ${excludedClause}
       AND m.attachments IS NOT NULL
       AND m.attachments != '[]'
       AND (m.role != 'assistant' OR NOT EXISTS (
         SELECT 1 FROM turns linked_turn
         WHERE linked_turn.session_id = m.session_id
           AND linked_turn.assistant_message_id = m.id
       ) OR EXISTS (
         SELECT 1 FROM turns linked_turn
         WHERE linked_turn.session_id = m.session_id
           AND linked_turn.assistant_message_id = m.id
           AND linked_turn.state = 'terminal'
       ))
     LIMIT 1`
  ).get(sessionId, boundarySequence ?? null, boundarySequence ?? null, ...excludeMessageIds)
  return Boolean(row)
}

export function getTurnContext(db: AppDatabase, sessionId: string, boundarySequence: number | undefined, requiredUserMessageId: string | undefined, excludeMessageIds: string[]): Message[] {
  const conn = getDbConnection(db)
  const excluded = new Set(excludeMessageIds)
  const rows = conn.prepare('SELECT * FROM messages WHERE session_id = ? AND (? IS NULL OR sequence <= ?) ORDER BY sequence ASC').all(sessionId, boundarySequence ?? null, boundarySequence ?? null) as MessageRow[]
  if (requiredUserMessageId && excluded.has(requiredUserMessageId)) throw new Error('TURN_REQUIRED_USER_EXCLUDED')
  if (requiredUserMessageId && !rows.some((row) => row.id === requiredUserMessageId)) {
    const required = conn.prepare("SELECT * FROM messages WHERE session_id = ? AND id = ? AND role = 'user'").get(sessionId, requiredUserMessageId) as MessageRow | undefined
    if (!required) throw new Error('TURN_REQUIRED_USER_INVALID')
    rows.push(required)
  }
  const turnLinks = conn.prepare(`
    SELECT t.user_message_id AS userMessageId,
           t.assistant_message_id AS assistantMessageId,
           t.state,
           m.sequence AS assistantSequence
    FROM turns t
    JOIN messages m ON m.id = t.assistant_message_id AND m.session_id = t.session_id
    WHERE t.session_id = ?
    ORDER BY m.sequence ASC, t.turn_id ASC
  `).all(sessionId) as Array<{ userMessageId?: string; assistantMessageId: string; state: string; assistantSequence: number }>
  const userAnchors = new Map<string, number>()
  const assistantTurnStates = new Map<string, string[]>()
  for (const link of turnLinks) {
    if (link.userMessageId && !userAnchors.has(link.userMessageId)) userAnchors.set(link.userMessageId, link.assistantSequence)
    const states = assistantTurnStates.get(link.assistantMessageId) ?? []
    states.push(link.state)
    assistantTurnStates.set(link.assistantMessageId, states)
  }
  const selectedRows = rows.filter((row) => {
    if (excluded.has(row.id)) return false
    const message = rowToStoredMessage(row)
    if (!isMessageEligibleForChatApi(message)) return false
    if (message.role !== 'assistant') return true
    const linkedStates = assistantTurnStates.get(message.id)
    return !linkedStates || linkedStates.some((state) => state === 'terminal')
  })
  if (requiredUserMessageId && !selectedRows.some((row) => row.id === requiredUserMessageId)) throw new Error('TURN_REQUIRED_USER_INVALID')
  return selectedRows
    .sort((a, b) => {
      const aAnchor = a.role === 'user' ? (userAnchors.get(a.id) ?? a.sequence) : a.sequence
      const bAnchor = b.role === 'user' ? (userAnchors.get(b.id) ?? b.sequence) : b.sequence
      if (aAnchor !== bAnchor) return aAnchor - bAnchor
      const roleOrderDifference = (a.role === 'user' ? 0 : 1) - (b.role === 'user' ? 0 : 1)
      if (roleOrderDifference !== 0) return roleOrderDifference
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map(rowToStoredMessage)
}

export function getMessage(db: AppDatabase, messageId: string): Message | undefined {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined
  return row ? rowToStoredMessage(row) : undefined
}

export type QueueInputReceipt = {
  sessionId: string; requestId: string; fingerprint: string; queuedMessageId?: string; turnId?: string; state: string
}

export function getQueueInputReceipt(db: AppDatabase, sessionId: string, requestId: string): QueueInputReceipt | undefined {
  return getDbConnection(db).prepare('SELECT session_id AS sessionId, request_id AS requestId, fingerprint, queued_message_id AS queuedMessageId, turn_id AS turnId, state FROM queue_input_requests WHERE session_id = ? AND request_id = ?').get(sessionId, requestId) as QueueInputReceipt | undefined
}

export function createQueueInputReceipt(db: AppDatabase, receipt: QueueInputReceipt): QueueInputReceipt {
  const now = Date.now()
  getDbConnection(db).prepare('INSERT INTO queue_input_requests (session_id, request_id, fingerprint, queued_message_id, turn_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(receipt.sessionId, receipt.requestId, receipt.fingerprint, receipt.queuedMessageId ?? null, receipt.turnId ?? null, receipt.state, now, now)
  db.save()
  return receipt
}

export function updateQueueInputReceiptState(db: AppDatabase, sessionId: string, requestId: string, state: string): boolean {
  const result = getDbConnection(db).prepare('UPDATE queue_input_requests SET state = ?, updated_at = ? WHERE session_id = ? AND request_id = ?').run(state, Date.now(), sessionId, requestId)
  const changed = changesToNumber(result.changes) === 1
  if (changed) db.save()
  return changed
}

export function enqueueQueuedUserMessage(
  db: AppDatabase,
  input: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }
): { receipt: QueueInputReceipt; persisted: PersistedMessageEntry; duplicate: boolean } {
  const fingerprint = queueInputFingerprint({ text: input.content, attachments: input.attachments })
  const existing = getQueueInputReceipt(db, input.sessionId, input.requestId)
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error('QUEUE_REQUEST_FINGERPRINT_MISMATCH')
    const message = existing.queuedMessageId ? getMessage(db, existing.queuedMessageId) : undefined
    if (!message) throw new Error('QUEUE_RECEIPT_MESSAGE_MISSING')
    const sequence = getMessageSequence(db, input.sessionId, message.id)
    if (sequence == null) throw new Error('QUEUE_RECEIPT_MESSAGE_MISSING')
    return { receipt: existing, persisted: { message, sequence }, duplicate: true }
  }
  const id = randomUUID()
  const now = Date.now()
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const persisted = appendMessage(db, { id, sessionId: input.sessionId, role: 'user', content: input.content.trim(), attachments: input.attachments, timestamp: now, status: 'queued' })
    const receipt: QueueInputReceipt = { sessionId: input.sessionId, requestId: input.requestId, fingerprint, queuedMessageId: id, state: 'queued' }
    createQueueInputReceipt(db, receipt)
    return { receipt, persisted, duplicate: false }
  })
}

export function claimQueuedTurnAtomically(
  db: AppDatabase,
  input: { sessionId: string; userMessageId: string; turnId: string; assistantMessageId: string; requestId: string; state?: string; startToken?: string; intentFingerprint?: string; excludeMessageIds?: string[]; executionConfig?: TurnExecutionConfig }
): { user: PersistedMessageEntry; assistant: PersistedMessageEntry } {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const active = conn.prepare("SELECT 1 FROM turns WHERE session_id = ? AND state IN ('configuring', 'prepared', 'executing', 'waiting-confirm') LIMIT 1").get(input.sessionId)
    if (active) throw new Error('SESSION_TURN_BUSY')
    const boundary = (conn.prepare('SELECT MAX(sequence) AS sequence FROM messages WHERE session_id = ?').get(input.sessionId) as { sequence?: number | null }).sequence ?? -1
    const row = conn.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = 'user' AND status = 'queued'").get(input.userMessageId, input.sessionId) as MessageRow | undefined
    if (!row) throw new Error('QUEUE_MESSAGE_NOT_CLAIMABLE')
    const userResult = updateMessageContent(db, input.userMessageId, { status: 'sent' })
    if (!userResult) throw new Error('QUEUE_MESSAGE_NOT_CLAIMABLE')
    const assistant = appendMessage(db, { id: input.assistantMessageId, sessionId: input.sessionId, role: 'assistant', content: '', timestamp: Date.now(), status: 'streaming' })
    createPersistedTurn(db, { turnId: input.turnId, requestId: input.requestId, sessionId: input.sessionId, assistantMessageId: input.assistantMessageId, userMessageId: input.userMessageId, contextBoundarySequence: boundary, state: input.state ?? 'prepared', startToken: input.startToken, intentFingerprint: input.intentFingerprint, excludeMessageIds: input.excludeMessageIds, executionConfig: input.executionConfig })
    const receipt = conn.prepare('UPDATE queue_input_requests SET turn_id = ?, state = ?, updated_at = ? WHERE session_id = ? AND request_id = ? AND state = ?').run(input.turnId, 'claimed', Date.now(), input.sessionId, input.requestId, 'queued')
    if (changesToNumber(receipt.changes) !== 1) throw new Error('QUEUE_RECEIPT_NOT_CLAIMABLE')
    return { user: userResult, assistant }
  })
}

export type PersistedTurn = {
  turnId: string; requestId: string; sessionId: string; assistantMessageId: string; state: string
  userMessageId?: string; contextBoundarySequence?: number; excludeMessageIds?: string[]; executionConfig?: TurnExecutionConfig; version: number; outcome?: string; usage?: unknown; error?: { code: string; message: string }; intentFingerprint?: string; startToken?: string
}

type PersistedTurnRow = Omit<PersistedTurn, 'usage' | 'error'> & {
  usageJson?: string
  errorJson?: string
  usage?: unknown
  error?: { code: string; message: string }
}

function decodePersistedTurnRow(row: PersistedTurnRow): PersistedTurn {
  if (row.usageJson) row.usage = parseJsonObject(row.usageJson, undefined)
  if (row.errorJson) row.error = parseJsonObject<{ code: string; message: string } | undefined>(row.errorJson, undefined)
  const { usageJson: _usageJson, errorJson: _errorJson, ...turn } = row
  return turn
}

const TURN_SELECT = 'turn_id AS turnId, request_id AS requestId, session_id AS sessionId, assistant_message_id AS assistantMessageId, user_message_id AS userMessageId, context_boundary_sequence AS contextBoundarySequence, exclude_message_ids_json AS excludeMessageIdsJson, execution_config_json AS executionConfigJson, state, version, outcome, COALESCE(terminal_usage_json, usage_json) AS usageJson, error_json AS errorJson, intent_fingerprint AS intentFingerprint, start_token AS startToken'

function decodeTurnContextRow(row: PersistedTurnRow & { excludeMessageIdsJson?: string; executionConfigJson?: string }): PersistedTurn {
  const { excludeMessageIdsJson, executionConfigJson, ...persistedRow } = row
  const turn = decodePersistedTurnRow(persistedRow)
  return { ...turn, excludeMessageIds: parseJsonObject<string[]>(excludeMessageIdsJson ?? '[]', []), ...(executionConfigJson ? { executionConfig: parseJsonObject<TurnExecutionConfig>(executionConfigJson, {}) } : {}) }
}

export function getTurnByRequestId(db: AppDatabase, sessionId: string, requestId: string): PersistedTurn | undefined {
  const row = getDbConnection(db).prepare(`SELECT ${TURN_SELECT} FROM turns WHERE session_id = ? AND request_id = ?`).get(sessionId, requestId) as (PersistedTurnRow & { excludeMessageIdsJson?: string; executionConfigJson?: string }) | undefined
  return row ? decodeTurnContextRow(row) : undefined
}

export function getPersistedTurn(db: AppDatabase, turnId: string): PersistedTurn | undefined {
  const row = getDbConnection(db).prepare(`SELECT ${TURN_SELECT} FROM turns WHERE turn_id = ?`).get(turnId) as (PersistedTurnRow & { excludeMessageIdsJson?: string; executionConfigJson?: string }) | undefined
  return row ? decodeTurnContextRow(row) : undefined
}

/** configuring turn 只有在执行配置与请求指纹同时冻结后才能变为可执行的 prepared。 */
export function setPersistedTurnExecutionConfig(db: AppDatabase, turnId: string, executionConfig: TurnExecutionConfig, intentFingerprint: string): boolean {
  const result = getDbConnection(db)
    .prepare("UPDATE turns SET execution_config_json = ?, intent_fingerprint = ?, state = 'prepared', updated_at = ? WHERE turn_id = ? AND state = 'configuring'")
    .run(JSON.stringify(executionConfig), intentFingerprint, Date.now(), turnId)
  const changed = changesToNumber(result.changes) === 1
  if (changed) db.save()
  return changed
}

/** 配置阶段失败只可终结仍未冻结的 turn，不能覆盖并发取消等已写入的终态。 */
export function failConfiguringTurn(db: AppDatabase, turnId: string, version: number, error: { code: string; message: string }): boolean {
  const result = getDbConnection(db)
    .prepare("UPDATE turns SET state = 'terminal', version = ?, outcome = 'failed', error_json = ?, updated_at = ? WHERE turn_id = ? AND state = 'configuring'")
    .run(version, JSON.stringify(error), Date.now(), turnId)
  const changed = changesToNumber(result.changes) === 1
  if (changed) db.save()
  return changed
}

export function listPersistedTurns(db: AppDatabase, state?: string): PersistedTurn[] {
  const conn = getDbConnection(db)
  const rows = (state == null ? conn.prepare(`SELECT ${TURN_SELECT} FROM turns ORDER BY created_at ASC`).all() : conn.prepare(`SELECT ${TURN_SELECT} FROM turns WHERE state = ? ORDER BY created_at ASC`).all(state)) as unknown as Array<PersistedTurnRow & { excludeMessageIdsJson?: string; executionConfigJson?: string }>
  return rows.map(decodeTurnContextRow)
}

export function hasActiveTurn(db: AppDatabase, sessionId: string): boolean {
  const row = getDbConnection(db).prepare("SELECT 1 FROM turns WHERE session_id = ? AND state IN ('configuring', 'prepared', 'executing', 'waiting-confirm') LIMIT 1").get(sessionId)
  return Boolean(row)
}

export function createPersistedTurn(db: AppDatabase, turn: Omit<PersistedTurn, 'version'> & { version?: number }): PersistedTurn {
  const now = Date.now()
  const startToken = turn.startToken ?? randomUUID()
  getDbConnection(db).prepare('INSERT INTO turns (turn_id, request_id, session_id, assistant_message_id, user_message_id, context_boundary_sequence, exclude_message_ids_json, execution_config_json, state, version, outcome, usage_json, terminal_usage_json, error_json, intent_fingerprint, start_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(turn.turnId, turn.requestId, turn.sessionId, turn.assistantMessageId, turn.userMessageId ?? null, turn.contextBoundarySequence ?? null, JSON.stringify(turn.excludeMessageIds ?? []), turn.executionConfig == null ? null : JSON.stringify(turn.executionConfig), turn.state, turn.version ?? 0, turn.outcome ?? null, null, turn.usage == null ? null : JSON.stringify(turn.usage), turn.error == null ? null : JSON.stringify(turn.error), turn.intentFingerprint ?? null, startToken, now, now)
  db.save()
  return { ...turn, version: turn.version ?? 0, startToken }
}

export function updatePersistedTurnState(db: AppDatabase, turnId: string, state: string, patch: { version?: number; outcome?: string; usage?: unknown; error?: { code: string; message: string } } = {}): boolean {
  const result = getDbConnection(db).prepare('UPDATE turns SET state = ?, version = COALESCE(?, version), outcome = COALESCE(?, outcome), terminal_usage_json = COALESCE(?, terminal_usage_json), error_json = COALESCE(?, error_json), updated_at = ? WHERE turn_id = ?').run(state, patch.version ?? null, patch.outcome ?? null, patch.usage === undefined ? null : JSON.stringify(patch.usage), patch.error === undefined ? null : JSON.stringify(patch.error), Date.now(), turnId)
  const changed = changesToNumber(result.changes) > 0
  if (changed) db.save()
  return changed
}

export function recoverPersistedTurn(db: AppDatabase, turnId: string, assistantMessageId: string): boolean {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const turn = conn.prepare("SELECT version, state FROM turns WHERE turn_id = ? AND assistant_message_id = ? AND state IN ('configuring', 'prepared', 'executing', 'waiting-confirm')").get(turnId, assistantMessageId) as { version: number; state: string } | undefined
    if (!turn) return false
    const message = conn.prepare("SELECT status FROM messages WHERE id = ? AND status IN ('streaming', 'failed')").get(assistantMessageId)
    if (!message) return false
    const assistant = getMessage(db, assistantMessageId)
    const interruptedToolCalls = assistant?.toolCalls?.map((tool) => {
      if (tool.status === 'completed' || tool.status === 'failed' || tool.status === 'rejected') return tool
      return { ...tool, status: 'failed' as const, interrupted: true, completedAt: Date.now(), result: { success: false, error: '工具调用因应用退出中断' } }
    })
    const updated = updateMessageContent(db, assistantMessageId, { status: 'failed', ...(interruptedToolCalls ? { toolCalls: interruptedToolCalls } : {}) })
    if (!updated) return false
    const result = conn.prepare("UPDATE turns SET state = 'terminal', outcome = 'recovered', version = ?, updated_at = ? WHERE turn_id = ? AND state IN ('configuring', 'prepared', 'executing', 'waiting-confirm')").run(turn.version + 1, Date.now(), turnId)
    if (changesToNumber(result.changes) !== 1) return false
    conn.prepare("UPDATE queue_input_requests SET state = 'recovered', updated_at = ? WHERE turn_id = ? AND state = 'claimed'").run(Date.now(), turnId)
    return true
  })
}

/** 启动恢复使用：列出所有尚未终止的 assistant 消息。 */
export function listStreamingAssistantMessages(db: AppDatabase): Message[] {
  const conn = getDbConnection(db)
  const rows = conn.prepare("SELECT * FROM messages WHERE role = 'assistant' AND status = 'streaming' ORDER BY timestamp ASC").all() as MessageRow[]
  return rows.map(rowToStoredMessage)
}

export interface MessagesPage {
  messages: Message[]
  /** 下一页应从此 sequence（含）开始读取；页为空时回填传入的 fromSequence，供调用方判定翻页结束 */
  nextSequence: number
}

/**
 * 按 sequence 游标分页读取消息，不受固定条数上限约束。较 `getMessages()` 的 offset 分页更适合
 * 大会话完整导出：游标基于稳定的 sequence 而非行位置，翻页期间新增消息不会导致重复或跳过。
 * `fromSequence` 为闭区间下界，初始调用传 0（消息 sequence 从 0 开始递增）。
 */
export function getMessagesPage(
  db: AppDatabase,
  sessionId: string,
  fromSequence: number,
  pageSize: number
): MessagesPage {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND sequence >= ?
       ORDER BY sequence ASC
       LIMIT ?`
    )
    .all(sessionId, fromSequence, pageSize) as MessageRow[]
  return {
    messages: rows.map(rowToStoredMessage),
    nextSequence: rows.length > 0 ? rows[rows.length - 1]!.sequence + 1 : fromSequence
  }
}

export function appendMessage(
  db: AppDatabase,
  msg: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }
): { message: Message; sequence: number } {
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
  return { message: full, sequence: maxSeq }
}

/** 在同一连接事务中追加一组消息；用于 turn prepare，保证 user/assistant 占位不会半成功。 */
export function appendMessagesAtomically(
  db: AppDatabase,
  messages: Array<Omit<Message, 'schemaVersion'> & { schemaVersion?: number }>
): PersistedMessageEntry[] {
  if (messages.length === 0) return []
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => messages.map((message) => appendMessage(db, message)))
}

/** 将 turn prepare 的两条消息与 turns 回执放在同一个事务中提交。 */
export function prepareTurnAtomically(
  db: AppDatabase,
  input: {
    user: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }
    assistant: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }
    turn: { turnId: string; requestId: string; sessionId: string; assistantMessageId: string; state: string; contextBoundarySequence?: number; startToken?: string; intentFingerprint?: string; excludeMessageIds?: string[] }
  }
): { user: PersistedMessageEntry; assistant: PersistedMessageEntry } {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const active = conn.prepare("SELECT 1 FROM turns WHERE session_id = ? AND state IN ('configuring', 'prepared', 'executing', 'waiting-confirm') LIMIT 1").get(input.turn.sessionId)
    if (active) throw new Error('SESSION_TURN_BUSY')
    const boundary = (conn.prepare('SELECT MAX(sequence) AS sequence FROM messages WHERE session_id = ?').get(input.turn.sessionId) as { sequence?: number | null }).sequence ?? -1
    const user = appendMessage(db, input.user)
    const assistant = appendMessage(db, input.assistant)
    createPersistedTurn(db, {
      ...input.turn,
      userMessageId: user.message.id,
      contextBoundarySequence: input.turn.contextBoundarySequence ?? boundary
    })
    return { user, assistant }
  })
}

export type ApiContextBaselineRow = {
  message: Message
  sequence: number
}

export type ApiContextBaselineResult = {
  sessionId: string
  entries: ApiContextBaselineRow[]
}

/** API 上下文 DB 基线：最新窗口，返回时恢复 sequence ASC，逐条携带 sequence。 */
export function getApiContextBaseline(db: AppDatabase, sessionId: string, limit = 500): ApiContextBaselineResult {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY sequence DESC
       LIMIT ?`
    )
    .all(sessionId, limit) as MessageRow[]
  return {
    sessionId,
    entries: rows.reverse().map((row) => ({
      message: rowToStoredMessage(row),
      sequence: row.sequence
    }))
  }
}

export type ChatMessagePageEntry = {
  message: Message
  sequence: number
}

export type ChatMessagePage = {
  entries: ChatMessagePageEntry[]
  oldestSequence: number | null
  hasMoreBefore: boolean
}

/**
 * UI 最新页：按 sequence DESC 取 limit(+1 探测)，再反转为 ASC。
 * `beforeSequence` 为排他上界；缺省表示从最新消息开始。
 */
export function getChatMessagePage(
  db: AppDatabase,
  sessionId: string,
  beforeSequence: number | null | undefined,
  limitInput?: number
): ChatMessagePage {
  const limit = Math.min(100, Math.max(20, limitInput ?? 60))
  const conn = getDbConnection(db)
  const rows = (
    beforeSequence == null
      ? conn
          .prepare(
            `SELECT * FROM messages
             WHERE session_id = ?
             ORDER BY sequence DESC
             LIMIT ?`
          )
          .all(sessionId, limit + 1)
      : conn
          .prepare(
            `SELECT * FROM messages
             WHERE session_id = ? AND sequence < ?
             ORDER BY sequence DESC
             LIMIT ?`
          )
          .all(sessionId, beforeSequence, limit + 1)
  ) as MessageRow[]

  const hasMoreBefore = rows.length > limit
  const pageRows = hasMoreBefore ? rows.slice(0, limit) : rows
  const asc = [...pageRows].reverse()
  return {
    entries: asc.map((row) => ({
      message: rowToStoredMessage(row),
      sequence: row.sequence
    })),
    oldestSequence: asc.length > 0 ? asc[0]!.sequence : null,
    hasMoreBefore
  }
}

export type ContextHistoryDbRow = {
  messageId: string
  role: Message['role']
  imageTokens: number
  thinkingTokens: number
  sequence: number
}

export type ContextHistoryDbBaseline = {
  sessionId: string
  entries: ContextHistoryDbRow[]
}

/**
 * 上下文环 DB 基线：扫描全会话，仅返回 imageTokens>0 或 thinkingTokens>0 的轻量行。
 * 不得复用 API context「最早 500 条」范围。
 */
export function getContextHistorySummaryBaseline(
  db: AppDatabase,
  sessionId: string
): ContextHistoryDbBaseline {
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY sequence ASC`
    )
    .all(sessionId) as MessageRow[]

  const entries: ContextHistoryDbRow[] = []
  for (const row of rows) {
    const message = rowToStoredMessage(row)
    const imageTokens = estimateTokensFromHistoryImages([message])
    const thinkingTokens = estimateThinkingTokensFromMessage(message.thinking)
    if (imageTokens <= 0 && thinkingTokens <= 0) continue
    entries.push({
      messageId: message.id,
      role: message.role,
      imageTokens,
      thinkingTokens,
      sequence: row.sequence
    })
  }
  return { sessionId, entries }
}

export type SearchCorpusPage = {
  entries: Array<{ message: Message; sequence: number }>
  nextSequence: number
  hasMore: boolean
}

/** 搜索语料 ASC 游标页：不受 UI 最新页 / API 500 限制。 */
export function getSearchCorpusPage(
  db: AppDatabase,
  sessionId: string,
  fromSequence: number,
  limitInput?: number
): SearchCorpusPage {
  const limit = Math.min(500, Math.max(50, limitInput ?? 200))
  const conn = getDbConnection(db)
  const rows = conn
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND sequence >= ?
       ORDER BY sequence ASC
       LIMIT ?`
    )
    .all(sessionId, fromSequence, limit + 1) as MessageRow[]
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  return {
    entries: pageRows.map((row) => ({
      message: rowToStoredMessage(row),
      sequence: row.sequence
    })),
    nextSequence:
      pageRows.length > 0 ? pageRows[pageRows.length - 1]!.sequence + 1 : fromSequence,
    hasMore
  }
}

export type QueuedMessageEntry = {
  message: Message
  sequence: number
  requestId?: string
}

export function getNextQueuedMessage(db: AppDatabase, sessionId: string): QueuedMessageEntry | null {
  const conn = getDbConnection(db)
  const row = conn
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND status = 'queued' AND role = 'user'
       ORDER BY sequence ASC
       LIMIT 1`
    )
    .get(sessionId) as MessageRow | undefined
  if (!row) return null
  const receipt = conn.prepare('SELECT request_id AS requestId FROM queue_input_requests WHERE queued_message_id = ?').get(row.id) as { requestId?: string } | undefined
  return { message: rowToStoredMessage(row), sequence: row.sequence, ...(receipt?.requestId ? { requestId: receipt.requestId } : {}) }
}

export type RetryContextTarget = {
  failedAssistant: { message: Message; sequence: number }
  currentUser: { message: Message; sequence: number }
}

export function resolveRetryContext(
  db: AppDatabase,
  sessionId: string,
  failedAssistantMessageId: string
): RetryContextTarget | null {
  const conn = getDbConnection(db)
  const failedRow = conn
    .prepare(`SELECT * FROM messages WHERE session_id = ? AND id = ?`)
    .get(sessionId, failedAssistantMessageId) as MessageRow | undefined
  if (!failedRow) return null
  const failedMessage = rowToStoredMessage(failedRow)
  if (failedMessage.role !== 'assistant' || failedMessage.status !== 'failed') return null

  // 优先使用 turn 的真实因果关联。连续排队时，物理 sequence 上 failed assistant
  // 之前最近的 user 可能已经属于下一条排队输入，不能再按相邻消息猜测。
  const linked = conn
    .prepare(`
      SELECT m.* FROM turns t
      JOIN messages m ON m.id = t.user_message_id AND m.session_id = t.session_id
      WHERE t.session_id = ? AND t.assistant_message_id = ? AND m.role = 'user'
    `)
    .get(sessionId, failedAssistantMessageId) as MessageRow | undefined
  if (linked) {
    const linkedMessage = rowToStoredMessage(linked)
    if (isMessageEligibleForChatApi(linkedMessage) && linkedMessage.content.trim()) {
      const linkedSequence = linked.sequence
      return {
        failedAssistant: { message: failedMessage, sequence: failedRow.sequence },
        currentUser: { message: linkedMessage, sequence: linkedSequence }
      }
    }
  }

  const priorRows = conn
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND sequence < ?
       ORDER BY sequence DESC`
    )
    .all(sessionId, failedRow.sequence) as MessageRow[]

  for (const row of priorRows) {
    const message = rowToStoredMessage(row)
    if (!isMessageEligibleForChatApi(message)) continue
    if (message.role !== 'user') continue
    if (!message.content.trim()) continue
    return {
      failedAssistant: { message: failedMessage, sequence: failedRow.sequence },
      currentUser: { message, sequence: row.sequence }
    }
  }
  return null
}

export function getMessageSequence(db: AppDatabase, sessionId: string, messageId: string): number | null {
  const conn = getDbConnection(db)
  const row = conn
    .prepare(`SELECT sequence FROM messages WHERE session_id = ? AND id = ?`)
    .get(sessionId, messageId) as { sequence: number } | undefined
  return row?.sequence ?? null
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
  const receipt = conn.prepare('SELECT session_id, request_id FROM queue_input_requests WHERE queued_message_id = ?').get(messageId) as { session_id: string; request_id: string } | undefined
  if (receipt) updateQueueInputReceiptState(db, receipt.session_id, receipt.request_id, 'cancelled')
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

export type PersistedMessageEntry = {
  message: Message
  sequence: number
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
): PersistedMessageEntry | null {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined
  if (!row) return null

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
  const updated = conn.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow
  return { message: rowToStoredMessage(updated), sequence: updated.sequence }
}

/** 仅允许更新仍处于 streaming 的消息，防止迟到 checkpoint 覆写终态。 */
export function updateMessageContentIfStreaming(
  db: AppDatabase,
  messageId: string,
  patch: Parameters<typeof updateMessageContent>[2]
): PersistedMessageEntry | null {
  const conn = getDbConnection(db)
  const current = conn.prepare('SELECT status FROM messages WHERE id = ?').get(messageId) as { status: string } | undefined
  if (!current || current.status !== 'streaming') return null
  return updateMessageContent(db, messageId, patch)
}

/** 在同一事务内以 turn version 条件更新 assistant 与 checkpoint，拒绝迟到/重复事件。 */
export function checkpointTurnAtomically(
  db: AppDatabase,
  turnId: string,
  expectedVersion: number,
  messageId: string,
  patch: Parameters<typeof updateMessageContent>[2]
): boolean {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const turn = conn.prepare('SELECT version, assistant_message_id FROM turns WHERE turn_id = ?').get(turnId) as { version: number; assistant_message_id: string } | undefined
    // timer checkpoint 会合并多个事件；允许从任意更早版本直接推进到最新 snapshot，
    // 但拒绝重复或倒退写入，避免旧 timer 覆盖新 snapshot。
    if (!turn || turn.assistant_message_id !== messageId || turn.version >= expectedVersion) return false
    const current = conn.prepare("SELECT status FROM messages WHERE id = ? AND status = 'streaming'").get(messageId)
    if (!current) return false
    updateMessageContent(db, messageId, patch)
    const result = conn.prepare('UPDATE turns SET version = ?, updated_at = ? WHERE turn_id = ? AND version = ?').run(expectedVersion, Date.now(), turnId, turn.version)
    return changesToNumber(result.changes) === 1
  })
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
  if (changesToNumber(result.changes) === 0) return false
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
