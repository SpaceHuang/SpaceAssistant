import { randomUUID } from 'node:crypto'
import { getDbConnection, type AppDatabase } from '../../../database/sqliteStore'
import type { LifecycleTaskHandle, LifecycleTaskRegistration } from '../../host/ports'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, encodeProjectionScopeKey } from '../../domain/scopeKey'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { readProjectionHistoryInvocationsInWorker } from './projectionInvocationSourceReader'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { runSessionBodySourceBackfill } from './sessionBodySourceBackfill'

type PendingSourceSession = Readonly<{ session_id: string; generation: string; updated_at: number; created_at: number }>

/** Runs locator backfills as cancellable derived-index maintenance, one session at a time. */
export function createSessionBodySourceBackfillTask(input: Readonly<{
  db: AppDatabase
  blobRoot: string
  reducerSpecVersion?: number
  idleDelayMs?: number
  retryDelayMs?: number
  onResult?: (result: Readonly<{ sessionId: string; status: 'complete' | 'failed'; messageCount?: number; error?: string }>) => void
}>): LifecycleTaskRegistration {
  const reducerSpecVersion = input.reducerSpecVersion ?? CHAT_BODY_PROJECTION_SPEC_VERSION
  if (!input.blobRoot || !Number.isSafeInteger(reducerSpecVersion) || reducerSpecVersion < 1) {
    throw new Error('PROJECTION_SOURCE_BACKFILL_TASK_INPUT_INVALID')
  }
  const blobs = createSessionProjectionBlobStore(input.blobRoot)
  return Object.freeze({ taskId: 'session-body-source-backfill', category: 'derived-index', start: () => {
    const controller = new AbortController()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight: Promise<void> | undefined
    let wakePending = false
    let candidateCursor: Pick<PendingSourceSession, 'updated_at' | 'created_at' | 'session_id'> | undefined
    const delayedSessions = new Map<string, Readonly<{ retryAt: number; updatedAt: number }>>()
    const schedule = (delay: number) => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void run() }, Math.max(0, delay))
    }
    const run = async () => {
      if (stopped || inFlight) return
      inFlight = (async () => {
        try {
          const conn = getDbConnection(input.db)
          const query = candidateCursor
            ? conn.prepare(`SELECT sessions.id AS session_id,sessions.generation,state.updated_at,sessions.created_at
              FROM session_body_source_state state JOIN sessions ON sessions.id=state.session_id
              WHERE state.status IN ('pending','backfilling') AND (state.updated_at,sessions.created_at,sessions.id)>(?,?,?)
              ORDER BY state.updated_at ASC,sessions.created_at ASC,sessions.id ASC LIMIT 64`)
              .all(candidateCursor.updated_at, candidateCursor.created_at, candidateCursor.session_id)
            : conn.prepare(`SELECT sessions.id AS session_id,sessions.generation,state.updated_at,sessions.created_at
              FROM session_body_source_state state JOIN sessions ON sessions.id=state.session_id
              WHERE state.status IN ('pending','backfilling')
              ORDER BY state.updated_at ASC,sessions.created_at ASC,sessions.id ASC LIMIT 64`).all()
          const candidates = query as PendingSourceSession[]
          let session: PendingSourceSession | undefined
          const now = Date.now()
          for (const candidate of candidates) {
            const delayed = delayedSessions.get(candidate.session_id)
            if (!delayed || delayed.updatedAt !== candidate.updated_at || delayed.retryAt <= now) {
              delayedSessions.delete(candidate.session_id)
              session = candidate
              break
            }
          }
          if (!session) {
            if (candidates.length === 64) {
              candidateCursor = candidates.at(-1)
                ? { updated_at: candidates.at(-1)!.updated_at, created_at: candidates.at(-1)!.created_at,
                    session_id: candidates.at(-1)!.session_id } : undefined
              schedule(0)
            } else {
              candidateCursor = undefined
              const nextRetryAt = Math.min(...[...delayedSessions.values()].map(({ retryAt }) => retryAt))
              schedule(Number.isFinite(nextRetryAt) ? Math.max(1, nextRetryAt - now) : input.idleDelayMs ?? 30 * 60_000)
            }
            return
          }
          candidateCursor = undefined
          try {
            const sourceIdentityJson = readProjectionSourceIdentity(conn, session.session_id, session.generation)
            if (!sourceIdentityJson) throw new Error('PROJECTION_SOURCE_IDENTITY_UNAVAILABLE')
            const sourceIdentity = JSON.parse(sourceIdentityJson) as { sourceRevision?: unknown; historyWatermark?: unknown }
            const sourceRevision = sourceIdentity.sourceRevision
            if (!Number.isSafeInteger(sourceRevision) || !(sourceIdentity.historyWatermark === null ||
              (Array.isArray(sourceIdentity.historyWatermark) && Number.isSafeInteger(sourceIdentity.historyWatermark[0])))) {
              throw new Error('PROJECTION_SOURCE_IDENTITY_INVALID')
            }
            const permit = Object.freeze({ dbPath: input.db.filePath, sessionId: session.session_id,
              sessionGeneration: session.generation,
              scopeKey: encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: reducerSpecVersion }),
              specVersion: reducerSpecVersion, sourceIdentityJson, connectionEpoch: 0, processGeneration: 0, rebuildToken: randomUUID() })
            const result = await runSessionBodySourceBackfill({ db: input.db, blobs, sessionId: session.session_id,
              reducerSpecVersion, signal: controller.signal,
              invocations: readProjectionHistoryInvocationsInWorker({ permit, blobs, signal: controller.signal }) })
            delayedSessions.delete(session.session_id)
            input.onResult?.({ sessionId: session.session_id, status: 'complete', messageCount: result.messageCount })
            schedule(0)
        } catch (error) {
          if (!stopped) {
            const message = error instanceof Error ? error.message : 'unknown-error'
            const current = conn.prepare('SELECT updated_at FROM session_body_source_state WHERE session_id=?')
              .get(session.session_id) as { updated_at: number } | undefined
            delayedSessions.set(session.session_id, { retryAt: Date.now() + (input.retryDelayMs ?? 5 * 60_000),
              updatedAt: current?.updated_at ?? session.updated_at })
            input.onResult?.({ sessionId: session.session_id, status: 'failed', error: message })
            schedule(0)
          }
        }
        } catch (error) {
          if (!stopped) {
            const message = error instanceof Error ? error.message : 'unknown-error'
            try { input.onResult?.({ sessionId: '', status: 'failed', error: message }) } catch { /* Observers must not stop maintenance. */ }
            schedule(input.retryDelayMs ?? 5 * 60_000)
          }
        }
      })().finally(() => {
        inFlight = undefined
        if (wakePending && !stopped) { wakePending = false; schedule(0) }
      })
      await inFlight
    }
    schedule(0)
    const handle: LifecycleTaskHandle = Object.freeze({
      stop: () => { stopped = true; controller.abort(new Error('PROJECTION_SOURCE_BACKFILL_STOPPED')); if (timer) clearTimeout(timer) },
      quiesce: async () => { await inFlight },
      request: () => { if (stopped) return; if (inFlight) wakePending = true; else schedule(0) },
    })
    return handle
  } })
}
