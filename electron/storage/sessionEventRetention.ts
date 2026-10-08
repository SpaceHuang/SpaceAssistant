import fs from 'fs/promises'
import path from 'node:path'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { readSessionEvents, type SessionRecoveryFailure } from '../sessionEvents'
import { resolveRetentionPolicyFromDb, type RetentionPolicy } from './retentionPolicy'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { getProjectedMessages } from '../runtime/sessionTranscriptProjection'

/**
 * 会话事件台账保留期(S3,偏差 24):自 sessionEvents.ts(Core 文件)归位 Storage。
 * - 保留语义:台账目录(sessions/)最多保留 maxSessions 个(按 events.index.json 的 lastAt 保留最新);
 * - 策略参数经 storage/retentionPolicy.ts 解析(可配、显式默认),调用方只触发、不持参数;
 * - 删除留痕:removed > 0 时落 retention.sessionEvents.cleaned(删了什么、多少个、依据哪条策略)。
 */

export type SessionRetentionSummary = {
  removed: number
  failures: SessionRecoveryFailure[]
  retained: Array<{ workDir: string; sessionName: string }>
}

export type SessionRetentionOptions = {
  /** Durably prepare the replacement DB projection before the legacy ledger can be removed. */
  prepareProjectionForRetention?: (sessionName: string, workDir: string) => void | Promise<void>
  /** Return true to keep a ledger directory that still has a durable canonical recovery dependency. */
  shouldRetainSessionDir?: (sessionName: string, workDir: string) => boolean | Promise<boolean>
}

/** Seed an eligible detached transcript projection before its workDir ledger becomes collectible. */
export function createCanonicalSessionProjectionRetentionPreparer(db: AppDatabase): (sessionName: string, workDir: string) => Promise<void> {
  const history = new SqliteAgentHistory(getDbConnection(db))
  return async (sessionName) => {
    const sessionId = /^(.*)-\d{8}$/.exec(sessionName)?.[1]
    if (!sessionId) return
    const messages = getProjectedMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
    if (messages.length === 0 || messages.some(({ role }) => role !== 'user' && role !== 'assistant')) return
    const legacyMessages = messages.map(({ id, role, content, timestamp, thinking, contentSegments, toolCalls, toolUse, attachments,
      imagesDeliveredToApi, skillHints }) => ({
      id, role: role as 'user' | 'assistant', content, timestamp,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(contentSegments !== undefined ? { contentSegments } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(toolUse !== undefined ? { toolUse } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(imagesDeliveredToApi !== undefined ? { imagesDeliveredToApi } : {}),
      ...(skillHints !== undefined ? { skillHints } : {})
    }))
    const folded = history.readCanonicalSessionTranscript(sessionId, legacyMessages)
    if (folded.kind !== 'matched') return
    if (!history.writeCanonicalSessionCache({ ...folded, cacheKey: 'transcript', value: JSON.stringify(folded.messages) })) {
      throw new Error(`canonical transcript projection could not be persisted for session ${sessionId}`)
    }
  }
}

/** Preload canonical dependencies once, then guard candidates against canonical or ledger-only compaction facts. */
export function createSessionLedgerCompactionDependencyGuard(db: AppDatabase): (sessionName: string, workDir: string) => Promise<boolean> {
  const compactedRows = getDbConnection(db).prepare(`SELECT streams.session_id, events.payload_json
    FROM agent_history_events events LEFT JOIN agent_history_streams streams ON streams.invocation_id=events.invocation_id
    WHERE events.kind='transcript-compacted'`).all() as Array<{ session_id: string | null; payload_json: string }>
  const compactedSessionIds = new Set<string>()
  for (const row of compactedRows) {
    if (row.session_id) compactedSessionIds.add(row.session_id)
    try {
      const payload = JSON.parse(row.payload_json) as { sessionLedger?: { location?: { sessionId?: unknown } } }
      const sessionId = payload.sessionLedger?.location?.sessionId
      if (typeof sessionId === 'string' && sessionId.trim()) compactedSessionIds.add(sessionId)
    } catch { /* Corrupt canonical payloads are handled by startup recovery; do not infer a dependency. */ }
  }
  return async (sessionName, workDir) => {
    const sessionId = /^(.*)-\d{8}$/.exec(sessionName)?.[1]
    if (sessionId && compactedSessionIds.has(sessionId)) return true
    const eventsPath = path.join(workDir, 'sessions', sessionName, 'events.jsonl')
    const events = await readSessionEvents(eventsPath)
    return events.some(({ type }) => type === 'compaction_start' || type === 'compaction_summary' || type === 'compaction_end')
  }
}

export async function enforceSessionEventRetention(workDir: string, maxSessions: number): Promise<number> {
  return (await enforceSessionEventRetentionDetailed(workDir, maxSessions)).removed
}

export async function enforceSessionEventRetentionDetailed(workDir: string, maxSessions: number, options: SessionRetentionOptions = {}): Promise<SessionRetentionSummary> {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('maxSessions must be positive')
  const root = path.join(workDir, 'sessions')
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try { entries = await fs.readdir(root, { withFileTypes: true }) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') entries = []
    else throw error
  }
  const candidates: Array<{ name: string; lastAt: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const index = JSON.parse(await fs.readFile(path.join(root, entry.name, 'events.index.json'), 'utf8')) as { lastAt?: number }
      candidates.push({ name: entry.name, lastAt: typeof index.lastAt === 'number' ? index.lastAt : 0 })
    } catch { /* no event stream, leave ordinary backups untouched */ }
  }
  candidates.sort((a, b) => b.lastAt - a.lastAt)
  const removed = candidates.slice(maxSessions)
  const failures: SessionRecoveryFailure[] = []
  const retained: Array<{ workDir: string; sessionName: string }> = []
  const removedSessions: string[] = []
  let count = 0
  for (const entry of removed) {
    try {
      if (await options.shouldRetainSessionDir?.(entry.name, workDir)) {
        retained.push({ workDir, sessionName: entry.name })
        continue
      }
      await options.prepareProjectionForRetention?.(entry.name, workDir)
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true })
      count += 1
      removedSessions.push(entry.name)
    } catch (error) {
      failures.push({ sessionName: entry.name, phase: 'retention-delete', error, jsonlCommitted: false })
    }
  }
  if (count > 0 || retained.length > 0) {
    logAgentEvent('info', 'retention.sessionEvents.cleaned', {
      strategy: 'maxSessions',
      maxSessions,
      removed: count,
      removedSessions,
      retainedDueToDependencies: retained.map(({ sessionName }) => sessionName)
    })
  }
  return { removed: count, failures, retained }
}

/**
 * 启动维护入口(S3,偏差 24):解析统一保留策略并执行台账保留清理。
 * 调用方(main.ts 启动流程)只触发——不持策略参数、不直接依赖 enforce 实现符号,
 * 策略参数从本模块(Storage)持有并解析。
 */
export async function runSessionEventRetentionMaintenance(db: AppDatabase, workDirs: string | readonly string[], options: SessionRetentionOptions = {}): Promise<{
  policy: RetentionPolicy
  summary: SessionRetentionSummary
}> {
  const policy = resolveRetentionPolicyFromDb(db)
  const roots = typeof workDirs === 'string' ? [workDirs] : workDirs
  const summary: SessionRetentionSummary = { removed: 0, failures: [], retained: [] }
  for (const workDir of new Set(roots)) {
    try {
      const rootSummary = await enforceSessionEventRetentionDetailed(workDir, policy.sessionEventMaxSessions, options)
      summary.removed += rootSummary.removed
      summary.failures.push(...rootSummary.failures)
      summary.retained.push(...rootSummary.retained)
    } catch (error) {
      summary.failures.push({ sessionName: workDir, phase: 'retention-delete', error, jsonlCommitted: false })
    }
  }
  return { policy, summary }
}
