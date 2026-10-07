import type { AppDatabase } from '../../database'
import { getConfigValue, getRecentTurnRoutingMessages, getSessionMessageRevisionSnapshot, getTurnContext, setConfigValue } from '../../database/operations'
import { getDbConnection } from '../../database/sqliteStore'
import { runInTransaction } from '../../database/transaction'
import { SqliteAgentHistory } from '../../runtime/sqliteAgentHistory'
import { fieldDifferences, readCanonicalTurnContextCandidate, shadowAcceptedTurnContext, shadowTurnRoutingInput,
  type CanonicalTurnContextCandidate, type TurnRouteInput } from '../../runtime/sessionStorageShadow'
import { queueInputFingerprint } from '../../queueInputFingerprint'

const API_READ_PROTOCOL_VERSION = 1
export const CANONICAL_API_READ_FEATURE_CONFIG_KEY = 'config.sessionStorageCanonicalApiRead'

type EligibilityRow = Readonly<{
  sessionGeneration: string
  messageRevision: number
  apiReadMode: string
  writeMode: string
  cleanupState: string
  eligibleSessionGeneration: string
  skeletonRevision: number
  canonicalSessionSeq: number
  canonicalCommitOrder: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
  protocolVersion: number
}>

type CanonicalWatermark = Readonly<{
  sessionGeneration: string
  sessionSeq: number
  commitOrder: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
}>

export type CanonicalApiReadCertification = Readonly<{
  status: 'eligible' | 'ineligible'
  reason?: string
  apiReadMode: 'canonical' | 'legacy' | 'revalidation-required'
  apiDifferenceCount?: number
  routeDifferenceCount?: number
  watermark?: CanonicalWatermark
}>

export type CanonicalApiReadFence = Readonly<{
  sessionGeneration: string
  messageRevision: number
  canonicalSessionSeq: number
  canonicalCommitOrder: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
}>
function revokeEligibility(db: AppDatabase, sessionId: string): void {
  const conn = getDbConnection(db)
  conn.prepare('DELETE FROM canonical_session_api_context_eligibility WHERE session_id=?').run(sessionId)
  conn.prepare(`UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=? WHERE session_id=?`).run(Date.now(), sessionId)
}

function canonicalApiReadFeatureEnabled(db: AppDatabase): boolean {
  return getConfigValue(db, CANONICAL_API_READ_FEATURE_CONFIG_KEY) === 'true'
}

/** The global kill switch forces all per-session API reads back to the retained legacy copy. */
function disableCanonicalReadForSession(db: AppDatabase, sessionId: string): void {
  const conn = getDbConnection(db)
  conn.prepare('DELETE FROM canonical_session_api_context_eligibility WHERE session_id=?').run(sessionId)
  conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='legacy',updated_at=?
    WHERE session_id=?`).run(Date.now(), sessionId)
}

/** Enter the persisted write-stop fence only after checking that no queued or active turn can still write bodies. */
export function setCanonicalApiReadFeatureEnabled(db: AppDatabase, enabled: boolean): void {
  runInTransaction(getDbConnection(db), () => {
    setConfigValue(db, CANONICAL_API_READ_FEATURE_CONFIG_KEY, enabled ? 'true' : 'false')
    if (!enabled) {
      getDbConnection(db).prepare('DELETE FROM canonical_session_api_context_eligibility').run()
      getDbConnection(db).prepare(`UPDATE session_message_content_cutover SET api_read_mode='legacy',updated_at=?
        WHERE api_read_mode!='legacy'`).run(Date.now())
    }
  })
}

function readEligibility(db: AppDatabase, sessionId: string): EligibilityRow | undefined {
  return getDbConnection(db).prepare(`SELECT sessions.generation AS sessionGeneration,
      cutover.message_revision AS messageRevision, cutover.api_read_mode AS apiReadMode,
      cutover.write_mode AS writeMode, cutover.cleanup_state AS cleanupState,
      eligibility.session_generation AS eligibleSessionGeneration,
      eligibility.skeleton_revision AS skeletonRevision,
      eligibility.canonical_session_seq AS canonicalSessionSeq,
      eligibility.canonical_commit_order AS canonicalCommitOrder,
      eligibility.watermark_event_id AS watermarkEventId,
      eligibility.watermark_invocation_id AS watermarkInvocationId,
      eligibility.protocol_version AS protocolVersion
    FROM sessions
    JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id
    LEFT JOIN canonical_session_api_context_eligibility eligibility ON eligibility.session_id=sessions.id
    WHERE sessions.id=?`).get(sessionId) as EligibilityRow | undefined
}

function readCanonicalState(db: AppDatabase, sessionId: string): Readonly<{ watermark?: CanonicalWatermark; cacheValidated: boolean }> {
  const history = new SqliteAgentHistory(getDbConnection(db))
  const canonical = history.readCanonicalSessionTranscriptForShadow(sessionId)
  if (canonical.kind !== 'matched' || canonical.eventCount === 0) return { cacheValidated: false }
  const cache = history.readCanonicalSessionCache({ ...canonical, cacheKey: 'transcript' })
  const watermark: CanonicalWatermark = {
    sessionGeneration: canonical.sessionGeneration,
    sessionSeq: canonical.sessionSeq,
    commitOrder: canonical.commitOrder,
    watermarkEventId: canonical.watermarkEventId,
    watermarkInvocationId: canonical.watermarkInvocationId
  }
  if (cache.kind !== 'hit') return { watermark, cacheValidated: false }
  try {
    const cached = JSON.parse(cache.value) as typeof canonical.messages
    const cacheValidated = Array.isArray(cached) && cached.length === canonical.messages.length && cached.every((message, index) => {
      const folded = canonical.messages[index]
      return !!folded && !!message && message.id === folded.id && message.role === folded.role &&
        message.timestamp === folded.timestamp && message.content === folded.content
    })
    return { watermark, cacheValidated }
  } catch { return { watermark, cacheValidated: false } }
}

function sameWatermark(a: CanonicalWatermark | undefined, b: CanonicalWatermark | undefined): boolean {
  return !!a && !!b && a.sessionGeneration === b.sessionGeneration && a.sessionSeq === b.sessionSeq &&
    a.commitOrder === b.commitOrder && a.watermarkEventId === b.watermarkEventId &&
    a.watermarkInvocationId === b.watermarkInvocationId
}

function eligibilityMatches(row: EligibilityRow | undefined, watermark: CanonicalWatermark | undefined): row is EligibilityRow {
  return !!row && !!watermark && row.apiReadMode === 'canonical' && (row.writeMode === 'legacy' || row.writeMode === 'canonical') && row.cleanupState === 'retained' &&
    row.eligibleSessionGeneration === row.sessionGeneration && row.sessionGeneration === watermark.sessionGeneration &&
    row.skeletonRevision === row.messageRevision && row.canonicalSessionSeq === watermark.sessionSeq &&
    row.canonicalCommitOrder === watermark.commitOrder && row.watermarkEventId === watermark.watermarkEventId &&
    row.watermarkInvocationId === watermark.watermarkInvocationId && row.protocolVersion === API_READ_PROTOCOL_VERSION
}

function toFence(row: EligibilityRow, watermark: CanonicalWatermark): CanonicalApiReadFence {
  return {
    sessionGeneration: row.sessionGeneration,
    messageRevision: row.messageRevision,
    canonicalSessionSeq: watermark.sessionSeq,
    canonicalCommitOrder: watermark.commitOrder,
    watermarkEventId: watermark.watermarkEventId,
    watermarkInvocationId: watermark.watermarkInvocationId
  }
}

/** Certify the complete session corpus, not a boundary-limited request, then grant the API/route read fence atomically. */
export function certifyCanonicalSessionApiRead(db: AppDatabase, sessionId: string): CanonicalApiReadCertification {
  return runInTransaction(getDbConnection(db), () => {
    const initial = getSessionMessageRevisionSnapshot(db, sessionId)
    const state = readEligibility(db, sessionId)
    if (!initial || !state) return { status: 'ineligible', reason: 'session-or-cutover-state-missing', apiReadMode: 'legacy' }
    if ((state.writeMode !== 'legacy' && state.writeMode !== 'canonical') || state.cleanupState !== 'retained') {
      revokeEligibility(db, sessionId)
      return { status: 'ineligible', reason: 'write-or-cleanup-phase-not-eligible', apiReadMode: state.apiReadMode === 'canonical' ? 'revalidation-required' : 'legacy' }
    }

    const allApiMessages = getTurnContext(db, sessionId, undefined, undefined, [])
    const apiShadow = shadowAcceptedTurnContext(db, sessionId, allApiMessages)
    const allRouteMessages = getRecentTurnRoutingMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
    const routeInput = { userInput: '', recentMessages: allRouteMessages, sessionId }
    const routeShadow = shadowTurnRoutingInput(db, {
      sessionId,
      mode: 'create-user',
      routeInput,
      boundarySequence: undefined,
      excludeMessageIds: [],
      limit: Number.MAX_SAFE_INTEGER
    } satisfies TurnRouteInput<typeof routeInput>)
    const watermark = apiShadow.canonicalWatermark
    const routeWatermark = routeShadow.canonicalWatermark
    const current = getSessionMessageRevisionSnapshot(db, sessionId)
    if (apiShadow.status !== 'matched' || routeShadow.status !== 'matched' || !watermark || !sameWatermark(watermark, routeWatermark) || !current ||
      current.generation !== initial.generation || current.messageRevision !== initial.messageRevision ||
      watermark.sessionGeneration !== initial.generation) {
      revokeEligibility(db, sessionId)
      return {
        status: 'ineligible',
        reason: !watermark ? 'canonical-watermark-unavailable' : apiShadow.status !== 'matched' ? 'api-context-not-matched' :
          routeShadow.status !== 'matched' ? 'turn-routing-not-matched' : 'session-fence-changed',
        apiReadMode: state.apiReadMode === 'canonical' ? 'revalidation-required' : 'legacy',
        apiDifferenceCount: apiShadow.differenceCount,
        routeDifferenceCount: routeShadow.differenceCount
      }
    }

    const canonicalSnapshot = new SqliteAgentHistory(getDbConnection(db)).readCanonicalSessionTranscriptForShadow(sessionId)
    if (canonicalSnapshot.kind !== 'matched' || canonicalSnapshot.eventCount === 0 ||
      canonicalSnapshot.sessionSeq !== watermark.sessionSeq || canonicalSnapshot.commitOrder !== watermark.commitOrder ||
      canonicalSnapshot.watermarkEventId !== watermark.watermarkEventId ||
      canonicalSnapshot.watermarkInvocationId !== watermark.watermarkInvocationId ||
      !new SqliteAgentHistory(getDbConnection(db)).writeCanonicalSessionCache({
        ...canonicalSnapshot, cacheKey: 'transcript', value: JSON.stringify(canonicalSnapshot.messages)
      })) {
      revokeEligibility(db, sessionId)
      return { status: 'ineligible', reason: 'canonical-cache-seed-failed', apiReadMode: state.apiReadMode === 'canonical' ? 'revalidation-required' : 'legacy',
        apiDifferenceCount: apiShadow.differenceCount, routeDifferenceCount: routeShadow.differenceCount }
    }

    const now = Date.now()
    getDbConnection(db).prepare(`INSERT INTO canonical_session_api_context_eligibility(
      session_id,session_generation,skeleton_revision,canonical_session_seq,canonical_commit_order,
      watermark_event_id,watermark_invocation_id,validated_at,protocol_version
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      session_generation=excluded.session_generation,skeleton_revision=excluded.skeleton_revision,
      canonical_session_seq=excluded.canonical_session_seq,canonical_commit_order=excluded.canonical_commit_order,
      watermark_event_id=excluded.watermark_event_id,watermark_invocation_id=excluded.watermark_invocation_id,
      validated_at=excluded.validated_at,protocol_version=excluded.protocol_version`)
      .run(sessionId, initial.generation, initial.messageRevision, watermark.sessionSeq, watermark.commitOrder,
        watermark.watermarkEventId, watermark.watermarkInvocationId, now, API_READ_PROTOCOL_VERSION)
    const changed = getDbConnection(db).prepare(`UPDATE session_message_content_cutover SET
      session_generation=?,api_read_mode='canonical',updated_at=?
      WHERE session_id=? AND session_generation=? AND message_revision=? AND write_mode IN ('legacy','canonical') AND cleanup_state='retained'`)
      .run(initial.generation, now, sessionId, initial.generation, initial.messageRevision)
    if (Number(changed.changes) !== 1) {
      revokeEligibility(db, sessionId)
      return { status: 'ineligible', reason: 'session-fence-changed', apiReadMode: 'revalidation-required',
        apiDifferenceCount: apiShadow.differenceCount, routeDifferenceCount: routeShadow.differenceCount }
    }
    return { status: 'eligible', apiReadMode: 'canonical', apiDifferenceCount: apiShadow.differenceCount,
      routeDifferenceCount: routeShadow.differenceCount, watermark }
  })
}

/** Resolve one accepted API request only while its session-wide generation/revision/watermark fence remains exact. */
export function readCanonicalApiContextIfEligible(
  db: AppDatabase,
  sessionId: string,
  boundarySequence: number | undefined,
  requiredUserMessageId: string | undefined,
  excludeMessageIds: string[],
  acceptedInput?: Readonly<{ messageId: string; fingerprint: string }>
): CanonicalTurnContextCandidate | undefined {
  return runInTransaction(getDbConnection(db), () => {
    if (!canonicalApiReadFeatureEnabled(db)) {
      disableCanonicalReadForSession(db, sessionId)
      return undefined
    }
    let row = readEligibility(db, sessionId)
    if (!row || row.apiReadMode !== 'canonical') {
      if (certifyCanonicalSessionApiRead(db, sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, sessionId)
    }
    let candidate = readCanonicalTurnContextCandidate(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
    if (candidate.status !== 'available' || !candidate.messages) {
      revokeEligibility(db, sessionId)
      return undefined
    }
    if (!candidate.canonicalCacheValidated || !eligibilityMatches(row, candidate.canonicalWatermark)) {
      revokeEligibility(db, sessionId)
      if (certifyCanonicalSessionApiRead(db, sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, sessionId)
      candidate = readCanonicalTurnContextCandidate(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
      if (!row || candidate.status !== 'available' || !candidate.messages || !candidate.canonicalCacheValidated ||
        !eligibilityMatches(row, candidate.canonicalWatermark)) {
        revokeEligibility(db, sessionId)
        return undefined
      }
    }
    if (acceptedInput) {
      const accepted = candidate.messages.find((message) => message.id === acceptedInput.messageId && message.role === 'user')
      if (!accepted || queueInputFingerprint({ text: accepted.content, attachments: accepted.attachments }) !== acceptedInput.fingerprint) {
        revokeEligibility(db, sessionId)
        return undefined
      }
    }
    if (!candidate.messages) {
      revokeEligibility(db, sessionId)
      return undefined
    }
    return candidate
  })
}

/** Resolve the request-specific route input only under a certified session fence and exact per-request shadow match. */
export function readCanonicalTurnRoutingInputIfEligible<T extends Readonly<{
  userInput: string
  recentMessages: readonly { role: 'user' | 'assistant'; content: string }[]
}>>(
  db: AppDatabase,
  input: TurnRouteInput<T>
): T | undefined {
  return readCanonicalTurnRoutingInputWithFenceIfEligible(db, input)?.routeInput
}

/** Same certified route read as above, returning its exact snapshot fence for post-await validation. */
export function readCanonicalTurnRoutingInputWithFenceIfEligible<T extends Readonly<{
  userInput: string
  recentMessages: readonly { role: 'user' | 'assistant'; content: string }[]
}>>(
  db: AppDatabase,
  input: TurnRouteInput<T>
): Readonly<{ routeInput: T; fence: CanonicalApiReadFence }> | undefined {
  return runInTransaction(getDbConnection(db), () => {
    if (!canonicalApiReadFeatureEnabled(db)) {
      disableCanonicalReadForSession(db, input.sessionId)
      return undefined
    }
    let row = readEligibility(db, input.sessionId)
    if (!row || row.apiReadMode !== 'canonical') {
      if (certifyCanonicalSessionApiRead(db, input.sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, input.sessionId)
    }
    let report = shadowTurnRoutingInput(db, input)
    if (report.status !== 'matched' || !report.candidate || fieldDifferences(input.routeInput, report.candidate).length > 0) {
      revokeEligibility(db, input.sessionId)
      return undefined
    }
    if (!report.canonicalCacheValidated || !eligibilityMatches(row, report.canonicalWatermark)) {
      revokeEligibility(db, input.sessionId)
      if (certifyCanonicalSessionApiRead(db, input.sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, input.sessionId)
      report = shadowTurnRoutingInput(db, input)
      if (!row || report.status !== 'matched' || !report.candidate || !report.canonicalCacheValidated ||
        !eligibilityMatches(row, report.canonicalWatermark) || fieldDifferences(input.routeInput, report.candidate).length > 0) {
        revokeEligibility(db, input.sessionId)
        return undefined
      }
    }
    if (!report.canonicalWatermark || !row) return undefined
    return { routeInput: report.candidate, fence: toFence(row, report.canonicalWatermark) }
  })
}

/** Async route preparation must not freeze configuration derived from a canonical snapshot that changed meanwhile. */
export function isCanonicalApiReadFenceCurrent(db: AppDatabase, sessionId: string, fence: CanonicalApiReadFence): boolean {
  return runInTransaction(getDbConnection(db), () => {
    if (!canonicalApiReadFeatureEnabled(db)) {
      disableCanonicalReadForSession(db, sessionId)
      return false
    }
    const row = readEligibility(db, sessionId)
    const current = readCanonicalState(db, sessionId)
    const watermark = current.watermark
    if (!watermark || !current.cacheValidated || !eligibilityMatches(row, watermark) || row.sessionGeneration !== fence.sessionGeneration ||
      row.messageRevision !== fence.messageRevision || watermark.sessionSeq !== fence.canonicalSessionSeq ||
      watermark.commitOrder !== fence.canonicalCommitOrder || watermark.watermarkEventId !== fence.watermarkEventId ||
      watermark.watermarkInvocationId !== fence.watermarkInvocationId) {
      revokeEligibility(db, sessionId)
      return false
    }
    return true
  })
}
