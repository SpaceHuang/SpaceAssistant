import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Message } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { hasCurrentProjectionEligibility, iterateLegacyTurnRoutingSkeletons, readLegacyProjectionMessages,
  readLegacyTurnContextSkeleton } from '../sessionStorage/sqliteRuntimeBindings'

export type SessionStorageShadowReport<T = unknown> = Readonly<{
  consumer: 'api-context' | 'turn-routing'
  sessionId: string
  source: string
  status: 'matched' | 'mismatched' | 'unavailable'
  differenceCount: number
  fields: readonly string[]
  legacyHash: string
  canonicalHash?: string
  acceptedInputFingerprint?: 'matched' | 'mismatched' | 'unavailable'
  canonicalWatermark?: Readonly<{
    sessionGeneration: string
    sessionSeq: number
    commitOrder: number
    watermarkEventId: string | null
    watermarkInvocationId: string | null
  }>
  canonicalSourceValidated?: boolean
  candidate?: T
}>

export type CanonicalTurnContextCandidate = Readonly<{
  status: 'available' | 'unavailable'
  source: string
  reason?: string
  errorCode?: 'TURN_REQUIRED_USER_INVALID' | 'TURN_REQUIRED_USER_EXCLUDED' | 'CANONICAL_CONTENT_UNAVAILABLE'
  canonicalWatermark?: SessionStorageShadowReport['canonicalWatermark']
  canonicalSourceValidated?: boolean
  messages?: readonly Message[]
}>

type CanonicalBodyRead = Readonly<{
  source: string
  messagesById?: ReadonlyMap<string, Message>
  canonicalWatermark?: SessionStorageShadowReport['canonicalWatermark']
  canonicalSourceValidated?: boolean
  reason?: string
}>

function hash(value: unknown): string {
  let serialized = 'null'
  try { serialized = JSON.stringify(value ?? null) } catch { serialized = '[unserializable]' }
  return createHash('sha256').update(serialized).digest('hex')
}

// SQLite TRIM(text) without a trim-set removes only U+0020; keep the legacy predicate byte-compatible.
function hasSqliteTrimmedContent(value: string): boolean {
  return value.replace(/^ +| +$/g, '').length > 0
}

function readCanonicalBodies(db: AppDatabase, sessionId: string, validateLegacyRoles = true): CanonicalBodyRead {
  try {
    if (!validateLegacyRoles && hasCurrentProjectionEligibility(db, sessionId)) {
      const conn = getDbConnection(db)
      const canonicalOnly = conn.prepare(`SELECT 1 FROM messages WHERE session_id=?
        AND content_storage_state='canonical-backed-only' LIMIT 1`).get(sessionId)
      if (!canonicalOnly) {
        const watermarkRow = conn.prepare(`SELECT sessions.generation,
            (SELECT session_seq FROM agent_history_events WHERE session_id=sessions.id ORDER BY session_seq DESC,commit_order DESC LIMIT 1) AS session_seq,
            (SELECT commit_order FROM agent_history_events WHERE session_id=sessions.id ORDER BY session_seq DESC,commit_order DESC LIMIT 1) AS commit_order,
            (SELECT event_id FROM agent_history_events WHERE session_id=sessions.id ORDER BY session_seq DESC,commit_order DESC LIMIT 1) AS watermark_event_id,
            (SELECT invocation_id FROM agent_history_events WHERE session_id=sessions.id ORDER BY session_seq DESC,commit_order DESC LIMIT 1) AS watermark_invocation_id,
            (SELECT COUNT(*) FROM agent_history_events WHERE session_id=sessions.id) AS event_count
          FROM sessions WHERE id=?`).get(sessionId) as { generation: string; session_seq: number | null; commit_order: number | null;
            watermark_event_id: string | null; watermark_invocation_id: string | null; event_count: number } | undefined
        if (watermarkRow) {
          const canonicalWatermark = { sessionGeneration: watermarkRow.generation,
            sessionSeq: watermarkRow.session_seq ?? -1, commitOrder: watermarkRow.commit_order ?? -1,
            watermarkEventId: watermarkRow.watermark_event_id, watermarkInvocationId: watermarkRow.watermark_invocation_id }
          const messagesById = new Map(readLegacyProjectionMessages(db, sessionId).map((message) => [message.id, message]))
          return { source: 'canonical:L1', messagesById, canonicalWatermark, canonicalSourceValidated: true }
        }
      }
    }
    const legacyMessages = validateLegacyRoles ? readLegacyProjectionMessages(db, sessionId) : []
    if (legacyMessages.some((message) => message.role !== 'user' && message.role !== 'assistant')) {
      return { source: 'legacy', reason: 'field-not-eligible' }
    }
    const history = new SqliteAgentHistory(getDbConnection(db))
    const read = history.readCanonicalSessionTranscriptForShadow(sessionId)
    if (read.kind === 'unavailable') return { source: 'canonical:unavailable', reason: read.reason }
    const hasCanonicalSnapshot = read.eventCount > 0
    if (!hasCanonicalSnapshot) return { source: 'canonical:unavailable', reason: 'canonical-snapshot-missing' }
    const canonicalWatermark = {
      sessionGeneration: read.sessionGeneration,
      sessionSeq: read.sessionSeq,
      commitOrder: read.commitOrder,
      watermarkEventId: read.watermarkEventId,
      watermarkInvocationId: read.watermarkInvocationId
    }
    const canonicalMessages = read.messages
    const canonicalSourceValidated = true
    const canonicalById = new Map(canonicalMessages.map((message) => [message.id, message]))
    const messagesById = new Map<string, Message>()
    for (const legacy of legacyMessages) {
      const canonical = canonicalById.get(legacy.id)
      if (!canonical || canonical.role !== legacy.role || typeof canonical.content !== 'string' || typeof canonical.timestamp !== 'number') {
        continue
      }
      messagesById.set(legacy.id, { ...legacy, content: canonical.content, timestamp: canonical.timestamp })
    }
    // Include canonical-only identities too, so shadow comparison can detect additions and identity drift.
    for (const canonical of canonicalMessages) {
      if ((canonical.role !== 'user' && canonical.role !== 'assistant') || typeof canonical.id !== 'string' ||
        typeof canonical.content !== 'string' || typeof canonical.timestamp !== 'number') continue
      if (!messagesById.has(canonical.id)) messagesById.set(canonical.id, { id: canonical.id, role: canonical.role, content: canonical.content, timestamp: canonical.timestamp } as Message)
    }
    return { source: 'canonical:L2', messagesById, canonicalWatermark, canonicalSourceValidated }
  } catch {
    return { source: 'unavailable', reason: 'canonical-read-failed' }
  }
}

/** Read the same frozen turn skeleton as getTurnContext, then resolve only selected stable IDs from canonical History. */
export function readCanonicalTurnContextCandidate(
  db: AppDatabase,
  sessionId: string,
  boundarySequence: number | undefined,
  requiredUserMessageId: string | undefined,
  excludeMessageIds: string[]
): CanonicalTurnContextCandidate {
  try {
    return runInTransaction(getDbConnection(db), () => {
      let legacySkeleton
      try {
        legacySkeleton = readLegacyTurnContextSkeleton(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message === 'TURN_REQUIRED_USER_INVALID' || message === 'TURN_REQUIRED_USER_EXCLUDED') {
          return { status: 'unavailable', source: 'canonical:not-read', errorCode: message }
        }
        return { status: 'unavailable', source: 'canonical:not-read', errorCode: 'CANONICAL_CONTENT_UNAVAILABLE' }
      }
      const canonical = readCanonicalBodies(db, sessionId, false)
      if (!canonical.messagesById) return {
        status: 'unavailable', source: canonical.source, reason: canonical.reason, errorCode: 'CANONICAL_CONTENT_UNAVAILABLE'
      }
      const messages: Message[] = []
      for (const skeleton of legacySkeleton) {
        const body = canonical.messagesById.get(skeleton.id)
        if (!body || body.id !== skeleton.id || body.role !== skeleton.role || typeof body.content !== 'string' ||
          typeof body.timestamp !== 'number') {
        return { status: 'unavailable', source: canonical.source, reason: 'message-identity-or-body-missing',
            errorCode: 'CANONICAL_CONTENT_UNAVAILABLE', canonicalWatermark: canonical.canonicalWatermark,
            canonicalSourceValidated: canonical.canonicalSourceValidated }
        }
        messages.push({ ...skeleton, content: body.content, timestamp: body.timestamp })
      }
      return { status: 'available', source: canonical.source, messages, canonicalWatermark: canonical.canonicalWatermark,
        canonicalSourceValidated: canonical.canonicalSourceValidated }
    })
  } catch {
    return { status: 'unavailable', source: 'canonical:unavailable', reason: 'snapshot-read-failed',
      errorCode: 'CANONICAL_CONTENT_UNAVAILABLE' }
  }
}

function enumerableKeys(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value) : []
}

export function fieldDifferences<T>(legacy: T, candidate: T): string[] {
  if (isDeepStrictEqual(legacy, candidate)) return []
  if (Array.isArray(legacy) && Array.isArray(candidate)) {
    const differences = new Set<string>()
    if (legacy.length !== candidate.length) differences.add('length')
    const count = Math.min(legacy.length, candidate.length)
    for (let index = 0; index < count; index += 1) {
      const leftItem = legacy[index]
      const rightItem = candidate[index]
      if (isDeepStrictEqual(leftItem, rightItem) &&
        Object.prototype.hasOwnProperty.call(legacy, index) === Object.prototype.hasOwnProperty.call(candidate, index)) continue
      const beforeItem = differences.size
      if (Object.prototype.hasOwnProperty.call(legacy, index) !== Object.prototype.hasOwnProperty.call(candidate, index)) {
        differences.add(`[${index}]`)
        continue
      }
      for (const field of new Set([...enumerableKeys(leftItem), ...enumerableKeys(rightItem)])) {
        const left = (leftItem as Record<string, unknown> | null)?.[field]
        const right = (rightItem as Record<string, unknown> | null)?.[field]
        if (!isDeepStrictEqual(left, right)) differences.add(field)
      }
      if (differences.size === beforeItem) differences.add(`[${index}]`)
    }
    return [...differences]
  }
  const leftValue = legacy as Record<string, unknown> | null
  const rightValue = candidate as Record<string, unknown> | null
  const fields = [...new Set([...enumerableKeys(legacy), ...enumerableKeys(candidate)])].filter((field) => {
    const left = leftValue?.[field]
    const right = rightValue?.[field]
    return !isDeepStrictEqual(left, right)
  })
  return fields.length > 0 ? fields : ['$value']
}

/** Report the exact already-folded API pair without re-reading History a second time. */
export function reportCanonicalApiContextComparison(input: {
  sessionId: string
  source: string
  legacy: readonly Message[]
  candidate: readonly Message[]
  canonicalWatermark?: SessionStorageShadowReport['canonicalWatermark']
  canonicalSourceValidated?: boolean
  acceptedInput?: Readonly<{ messageId: string; fingerprint: string }>
}): SessionStorageShadowReport<readonly Message[]> {
  const fields = fieldDifferences(input.legacy, input.candidate)
  let acceptedInputFingerprint: SessionStorageShadowReport['acceptedInputFingerprint']
  if (input.acceptedInput) {
    const user = input.candidate.find((message) => message.id === input.acceptedInput!.messageId && message.role === 'user')
    acceptedInputFingerprint = user && queueInputFingerprint({ text: user.content, attachments: user.attachments }) === input.acceptedInput.fingerprint
      ? 'matched' : 'mismatched'
    if (acceptedInputFingerprint !== 'matched') fields.push('accepted-input-fingerprint')
  }
  const legacyHash = hash(input.legacy)
  return emitReport({
    consumer: 'api-context', sessionId: input.sessionId, source: input.source,
    status: fields.length === 0 ? 'matched' : 'mismatched', differenceCount: fields.length, fields,
    legacyHash, canonicalHash: fields.length === 0 ? legacyHash : hash(input.candidate),
    canonicalWatermark: input.canonicalWatermark, canonicalSourceValidated: input.canonicalSourceValidated,
    ...(acceptedInputFingerprint ? { acceptedInputFingerprint } : {}), candidate: input.candidate
  })
}

function emitReport<T>(report: SessionStorageShadowReport<T>): SessionStorageShadowReport<T> {
  try {
    logAgentEvent(report.status === 'mismatched' ? 'warn' : 'info', 'session.storage.shadow', {
      sessionId: report.sessionId,
      consumer: report.consumer,
      source: report.source,
      status: report.status,
      differenceCount: report.differenceCount,
      fieldNames: report.fields,
      legacyHash: report.legacyHash,
      canonicalHash: report.canonicalHash,
      ...(report.acceptedInputFingerprint ? { acceptedInputFingerprint: report.acceptedInputFingerprint } : {})
    })
  } catch { /* Diagnostic logging cannot change a legacy user path. */ }
  return report
}

function unavailable<T>(input: {
  consumer: SessionStorageShadowReport['consumer']
  sessionId: string
  source: string
  legacy: unknown
  reason?: string
  acceptedInputFingerprint?: 'matched' | 'mismatched' | 'unavailable'
}): SessionStorageShadowReport<T> {
  return emitReport({
    consumer: input.consumer,
    sessionId: input.sessionId,
    source: input.source,
    status: 'unavailable',
    differenceCount: 0,
    fields: input.reason ? [input.reason] : [],
    legacyHash: hash(input.legacy),
    ...(input.acceptedInputFingerprint ? { acceptedInputFingerprint: input.acceptedInputFingerprint } : {})
  })
}

export function shadowAcceptedTurnContext(
  db: AppDatabase,
  sessionId: string,
  legacyMessages: readonly Message[],
  acceptedInput?: Readonly<{ messageId: string; fingerprint: string }>
): SessionStorageShadowReport<readonly Message[]> {
  try {
    return runInTransaction(getDbConnection(db), () => {
      const canonical = readCanonicalBodies(db, sessionId)
      if (!canonical.messagesById) return unavailable({
        consumer: 'api-context', sessionId, source: canonical.source, legacy: legacyMessages, reason: canonical.reason,
        ...(acceptedInput ? { acceptedInputFingerprint: 'unavailable' as const } : {})
      })
      const candidate: Message[] = []
      for (const legacy of legacyMessages) {
        const body = canonical.messagesById.get(legacy.id)
        if (!body || body.id !== legacy.id || body.role !== legacy.role || typeof body.content !== 'string' || typeof body.timestamp !== 'number') {
          return unavailable({
            consumer: 'api-context', sessionId, source: canonical.source, legacy: legacyMessages, reason: 'message-identity-or-body-missing',
            ...(acceptedInput ? { acceptedInputFingerprint: 'unavailable' as const } : {})
          })
        }
        candidate.push({ ...legacy, content: body.content, timestamp: body.timestamp })
      }
      const fields = fieldDifferences(legacyMessages, candidate)
      let acceptedInputFingerprint: SessionStorageShadowReport['acceptedInputFingerprint']
      if (acceptedInput) {
        const acceptedUser = candidate.find((message) => message.id === acceptedInput.messageId && message.role === 'user')
        acceptedInputFingerprint = acceptedUser && queueInputFingerprint({ text: acceptedUser.content, attachments: acceptedUser.attachments }) === acceptedInput.fingerprint
          ? 'matched'
          : 'mismatched'
        if (acceptedInputFingerprint !== 'matched') {
          fields.push('accepted-input-fingerprint')
        }
      }
      return emitReport({
        consumer: 'api-context', sessionId, source: canonical.source,
        status: fields.length === 0 ? 'matched' : 'mismatched', differenceCount: fields.length, fields,
        legacyHash: hash(legacyMessages), canonicalHash: hash(candidate),
        canonicalWatermark: canonical.canonicalWatermark,
        canonicalSourceValidated: canonical.canonicalSourceValidated,
        ...(acceptedInputFingerprint ? { acceptedInputFingerprint } : {}), candidate
      })
    })
  } catch {
    return unavailable({
      consumer: 'api-context', sessionId, source: 'canonical:unavailable', legacy: legacyMessages, reason: 'shadow-read-failed',
      ...(acceptedInput ? { acceptedInputFingerprint: 'unavailable' as const } : {})
    })
  }
}

export type TurnRouteInput<T extends Readonly<{ userInput: string; recentMessages: readonly { role: 'user' | 'assistant'; content: string }[] }>> = Readonly<{
  sessionId: string
  mode: 'create-user' | 'reuse-user'
  reuseUserMessageId?: string
  routeInput: T
  boundarySequence?: number
  excludeMessageIds: readonly string[]
  limit?: number
}>

export function shadowTurnRoutingInput<T extends Readonly<{ userInput: string; recentMessages: readonly { role: 'user' | 'assistant'; content: string }[] }>>(
  db: AppDatabase,
  input: TurnRouteInput<T>
): SessionStorageShadowReport<T> {
  try {
    return runInTransaction(getDbConnection(db), () => {
      const canonical = readCanonicalBodies(db, input.sessionId)
      if (!canonical.messagesById) return unavailable({
        consumer: 'turn-routing', sessionId: input.sessionId, source: canonical.source, legacy: input.routeInput, reason: canonical.reason
      })

      let userInput = input.routeInput.userInput
      if (input.mode === 'reuse-user') {
        const required = input.reuseUserMessageId ? canonical.messagesById.get(input.reuseUserMessageId) : undefined
        if (!required || required.role !== 'user' || typeof required.content !== 'string') {
          return unavailable({ consumer: 'turn-routing', sessionId: input.sessionId, source: canonical.source, legacy: input.routeInput, reason: 'reuse-user-canonical-body-missing' })
        }
        userInput = required.content
      }

      const descending: Array<{ role: 'user' | 'assistant'; content: string }> = []
      const limit = input.limit ?? 50
      if (limit <= 0) {
        const candidate = { ...input.routeInput, userInput, recentMessages: [] } as T
        const fields = fieldDifferences(input.routeInput, candidate)
        return emitReport({
          consumer: 'turn-routing', sessionId: input.sessionId, source: canonical.source,
          status: fields.length === 0 ? 'matched' : 'mismatched', differenceCount: fields.length, fields,
          legacyHash: hash(input.routeInput), canonicalHash: hash(candidate), candidate
        })
      }
      for (const skeleton of iterateLegacyTurnRoutingSkeletons(db, input.sessionId, input.boundarySequence, [...input.excludeMessageIds])) {
        const body = canonical.messagesById.get(skeleton.id)
        if (!body || body.id !== skeleton.id || body.role !== skeleton.role || typeof body.content !== 'string') {
          return unavailable({ consumer: 'turn-routing', sessionId: input.sessionId, source: canonical.source, legacy: input.routeInput, reason: 'routing-canonical-body-missing' })
        }
        if (hasSqliteTrimmedContent(body.content)) descending.push({ role: skeleton.role, content: body.content })
        if (descending.length >= limit) break
      }
      const recentMessages = descending.reverse()
      const candidate = { ...input.routeInput, userInput, recentMessages } as T
      const fields = fieldDifferences(input.routeInput, candidate)
      const safeLegacy = { ...input.routeInput, getApiKey: undefined, signal: undefined }
      const safeCandidate = { ...candidate, getApiKey: undefined, signal: undefined }
      return emitReport({
        consumer: 'turn-routing', sessionId: input.sessionId, source: canonical.source,
        status: fields.length === 0 ? 'matched' : 'mismatched', differenceCount: fields.length, fields,
        legacyHash: hash(safeLegacy), canonicalHash: hash(safeCandidate), candidate
        , canonicalWatermark: canonical.canonicalWatermark,
        canonicalSourceValidated: canonical.canonicalSourceValidated
      })
    })
  } catch {
    return unavailable({ consumer: 'turn-routing', sessionId: input.sessionId, source: 'unavailable', legacy: input.routeInput, reason: 'shadow-read-failed' })
  }
}
