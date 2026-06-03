import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Message, MessageStatus, Session } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_LLM_TEMPERATURE, DEFAULT_SESSION_SKILLS_STATE, normalizeSessionSkillsState } from '../src/shared/domainTypes'
import {
  rowToMessage,
  serializeContentSegmentsForDb,
  serializeSkillHintsForDb,
  serializeThinkingForDb,
  serializeToolCallsForDb,
  serializeToolUseForDb
} from './messageCodec'
import { createDebouncedDbSave } from './dbSaveScheduler'

export type StoredMessage = {
  id: string
  sessionId: string
  role: string
  content: string
  toolUse: string | null
  toolCalls: string | null
  thinking: string | null
  contentSegments?: string | null
  skillHints?: string | null
  status: string
  schemaVersion: number
  timestamp: number
  sequence: number
}

type DbSnapshot = {
  sessions: Session[]
  messages: StoredMessage[]
  configs: Record<string, { value: string; createdAt: number; updatedAt: number }>
  searchHistory: Array<{ id: string; query: string; timestamp: number }>
}

export type AppDatabase = {
  readonly filePath: string
  data: DbSnapshot
  /** 防抖合并写入 */
  save: () => void
  /** 立即落盘（删会话、退出应用等关键路径） */
  flushSave: () => void
}

function emptySnapshot(): DbSnapshot {
  return {
    sessions: [],
    messages: [],
    configs: {},
    searchHistory: []
  }
}

function loadSnapshot(filePath: string): DbSnapshot {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<DbSnapshot>
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      messages: Array.isArray(parsed.messages)
        ? (parsed.messages as StoredMessage[]).map((m) => ({
            ...m,
            toolCalls: m.toolCalls ?? null,
            skillHints: m.skillHints ?? null
          }))
        : [],
      configs: parsed.configs && typeof parsed.configs === 'object' ? (parsed.configs as DbSnapshot['configs']) : {},
      searchHistory: Array.isArray(parsed.searchHistory) ? parsed.searchHistory : []
    }
  } catch {
    return emptySnapshot()
  }
}

function atomicWriteJson(filePath: string, data: DbSnapshot): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

/** 无原生依赖的本地持久化（JSON 文件）；接口与原先 SQLite 版保持一致，便于日后迁回 better-sqlite3。 */
export function openDatabase(filePath: string): AppDatabase {
  const data = loadSnapshot(filePath)
  const writeImmediate = () => atomicWriteJson(filePath, data)
  const { schedule, flushNow } = createDebouncedDbSave(writeImmediate)
  const db: AppDatabase = {
    filePath,
    data,
    save: schedule,
    flushSave: flushNow
  }
  writeImmediate()
  return db
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    skillsState: normalizeSessionSkillsState(session.skillsState)
  }
}

export function listSessions(db: AppDatabase): Session[] {
  return [...db.data.sessions].map(normalizeSession).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSession(db: AppDatabase, sessionId: string): Session | undefined {
  const s = db.data.sessions.find((s) => s.id === sessionId)
  return s ? normalizeSession(s) : undefined
}

export function createSession(
  db: AppDatabase,
  input: {
    name: string
    model?: string
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
  db.data.sessions.push(session)
  db.save()
  return session
}

export function updateSession(
  db: AppDatabase,
  sessionId: string,
  patch: Partial<Pick<Session, 'name' | 'preview' | 'model' | 'temperature' | 'maxTokens' | 'metadata' | 'messageCount' | 'skillsState'>>
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
  const i = db.data.sessions.findIndex((s) => s.id === sessionId)
  if (i >= 0) db.data.sessions[i] = next
  db.save()
  return next
}

export function deleteSession(db: AppDatabase, sessionId: string): void {
  db.data.sessions = db.data.sessions.filter((s) => s.id !== sessionId)
  db.data.messages = db.data.messages.filter((m) => m.sessionId !== sessionId)
  db.flushSave()
}

export function getMessages(db: AppDatabase, sessionId: string, limit = 500, offset = 0): Message[] {
  const rows = db.data.messages
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(offset, offset + limit)
  return rows.map((r) =>
    rowToMessage({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role,
      content: r.content,
      toolUse: r.toolUse,
      toolCalls: r.toolCalls ?? null,
      thinking: r.thinking,
      contentSegments: r.contentSegments ?? null,
      skillHints: r.skillHints ?? null,
      status: r.status,
      schemaVersion: r.schemaVersion,
      timestamp: r.timestamp,
      sequence: r.sequence
    })
  )
}

export function appendMessage(db: AppDatabase, msg: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }): Message {
  const seqMax = db.data.messages.filter((m) => m.sessionId === msg.sessionId).reduce((m, r) => Math.max(m, r.sequence), -1)
  const maxSeq = seqMax + 1
  const full: Message = {
    ...msg,
    schemaVersion: msg.schemaVersion ?? CURRENT_SCHEMA_VERSION
  }
  const row: StoredMessage = {
    id: full.id,
    sessionId: full.sessionId,
    role: full.role,
    content: full.content,
    toolUse: serializeToolUseForDb(full.toolUse),
    toolCalls: serializeToolCallsForDb(full.toolCalls),
    thinking: serializeThinkingForDb(full.thinking),
    contentSegments: serializeContentSegmentsForDb(full.contentSegments),
    skillHints: serializeSkillHintsForDb(full.skillHints),
    status: full.status,
    schemaVersion: full.schemaVersion,
    timestamp: full.timestamp,
    sequence: maxSeq
  }
  db.data.messages.push(row)
  const preview = full.content.slice(0, 120)
  const count = db.data.messages.filter((m) => m.sessionId === full.sessionId).length
  updateSession(db, full.sessionId, {
    preview,
    messageCount: count
  })
  return full
}

export function updateMessageContent(
  db: AppDatabase,
  messageId: string,
  patch: Partial<Pick<Message, 'content' | 'status' | 'toolUse' | 'thinking' | 'toolCalls' | 'contentSegments' | 'skillHints'>>
): void {
  const row = db.data.messages.find((m) => m.id === messageId)
  if (!row) return
  const content = patch.content ?? row.content
  const status = patch.status ?? (row.status as MessageStatus)
  const toolUse = patch.toolUse !== undefined ? serializeToolUseForDb(patch.toolUse) : row.toolUse
  const toolCalls = patch.toolCalls !== undefined ? serializeToolCallsForDb(patch.toolCalls) : row.toolCalls
  const thinking = patch.thinking !== undefined ? serializeThinkingForDb(patch.thinking) : row.thinking
  const contentSegments =
    patch.contentSegments !== undefined ? serializeContentSegmentsForDb(patch.contentSegments) : row.contentSegments ?? null
  const skillHints =
    patch.skillHints !== undefined ? serializeSkillHintsForDb(patch.skillHints) : row.skillHints ?? null
  row.content = content
  row.status = status
  row.toolUse = toolUse
  row.toolCalls = toolCalls
  row.thinking = thinking
  row.contentSegments = contentSegments
  row.skillHints = skillHints
  db.save()
}

export function getConfigValue(db: AppDatabase, key: string): string | undefined {
  return db.data.configs[key]?.value
}

export function setConfigValue(db: AppDatabase, key: string, value: string): void {
  const now = Date.now()
  const cur = db.data.configs[key]
  if (cur) {
    db.data.configs[key] = { value, createdAt: cur.createdAt, updatedAt: now }
  } else {
    db.data.configs[key] = { value, createdAt: now, updatedAt: now }
  }
  db.save()
}

export function deleteConfigValue(db: AppDatabase, key: string): boolean {
  if (!(key in db.data.configs)) return false
  delete db.data.configs[key]
  db.save()
  return true
}

export function appendSearchHistory(db: AppDatabase, query: string): void {
  db.data.searchHistory.push({ id: randomUUID(), query, timestamp: Date.now() })
  db.save()
}

export function listSearchHistory(db: AppDatabase, limit = 20): string[] {
  return [...db.data.searchHistory]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((r) => r.query)
}

export function getDefaultDbPath(userData: string): string {
  return path.join(userData, 'spaceassistant-data.json')
}
