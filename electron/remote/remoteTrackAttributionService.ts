import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getDbConnection, runInTransaction } from '../database'
import { appendRemoteTrackEvent, createRemoteTrack, mapRemoteTrackMessage, resolveRemoteTrackMessageReference } from '../database/remoteTrackStore'
import type { RemoteTrackContext, RemoteTrackChannel } from '../../src/shared/remoteTrack'
import { getImInboxMessageContext } from '../database/imInbox'
import { attributeRemoteMessage, REMOTE_TRACK_ATTRIBUTION_POLICY_VERSION, REMOTE_TRACK_CONTINUATION_SCORE_MARGIN,
  REMOTE_TRACK_CONTINUATION_SCORE_THRESHOLD, type IntentAttributor, type IntentAttributorMetering, type TrackCandidateSummary,
  type RemoteAttributionDecision } from './trackAttribution'
import { recordRemoteTrackAttributionObservation } from '../database/remoteTrackAttributionObservationStore'
import type { SessionQueries } from '../sessionStorage/public/ports'

type AttributionScope = {
  channel: RemoteTrackChannel
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  platformMessageId: string
  replyToPlatformMessageId?: string
  text: string
  originSessionId?: string
  resolveNewTrackSession?: () => Promise<string>
  now?: number
}

export type RemoteAttributionObservationScope = Omit<AttributionScope, 'originSessionId' | 'resolveNewTrackSession'>

/** Classifies and records a redacted shadow observation without creating or routing any Track. */
export async function observeRemoteMessageAttribution(
  db: AppDatabase,
  scope: RemoteAttributionObservationScope,
  classifier: IntentAttributor,
  sessionQueries: Pick<SessionQueries, 'readMessage' | 'readSession'>
): Promise<{ decision: RemoteAttributionDecision; created: boolean; latencyMs: number }> {
  if (!scope.platformMessageId.trim() || !scope.identityKey.trim() || !scope.ownerId.trim() ||
    !Number.isSafeInteger(scope.authorizationEpoch) || scope.authorizationEpoch <= 0) {
    throw new Error('REMOTE_TRACK_ATTRIBUTION_SCOPE_INVALID')
  }
  const startedAt = Date.now()
  const now = scope.now ?? startedAt
  const conn = getDbConnection(db)
  const durableEpoch = conn.prepare('SELECT epoch FROM remote_authorization_epochs WHERE channel=?').get(scope.channel) as { epoch: number } | undefined
  if (!durableEpoch || durableEpoch.epoch !== scope.authorizationEpoch) throw new Error('REMOTE_TRACK_ATTRIBUTION_EPOCH_STALE')
  const prior = conn.prepare(`SELECT owner_id FROM remote_track_attribution_observations
    WHERE channel=? AND identity_key=? AND authorization_epoch=? AND platform_message_id=?`)
    .get(scope.channel, scope.identityKey, scope.authorizationEpoch, scope.platformMessageId) as { owner_id: string } | undefined
  if (prior) {
    if (prior.owner_id !== scope.ownerId) throw new Error('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_COLLISION')
    return { decision: { kind: 'rejected', reasonCode: 'observation-already-recorded' }, created: false, latencyMs: 0 }
  }

  const candidates = readCandidates(db, { ...scope, text: scope.text }, sessionQueries)
  let explicitReference: Parameters<typeof attributeRemoteMessage>[0]['explicitReference']
  if (scope.replyToPlatformMessageId) {
    const reference = resolveRemoteTrackMessageReference(db, { channel: scope.channel,
      platformMessageId: scope.replyToPlatformMessageId, identityKey: scope.identityKey,
      ownerId: scope.ownerId, authorizationEpoch: scope.authorizationEpoch })
    if (reference) explicitReference = { trackId: reference.trackId, state: stateForCandidate(reference.state) ?? 'unavailable' }
    else explicitReference = { trackId: '', state: 'unavailable' }
  }
  let scores: Array<{ trackId: string; score: number }> = []
  let classifierInvoked = false
  let metering: import('./trackAttribution').IntentAttributorMetering | undefined
  const measuredClassifier: IntentAttributor = {
    async classify(input) {
      classifierInvoked = true
      const result = await classifier.classify(input)
      metering = result.metering
      if (result.kind === 'scores') {
        const allowed = new Set(input.candidates.map(({ trackId }) => trackId))
        scores = result.scores.filter(({ trackId }) => allowed.has(trackId)).map(({ trackId, score }) => ({ trackId, score }))
      }
      return result
    }
  }
  const decision = await attributeRemoteMessage({ text: scope.text, candidates, classifier: measuredClassifier, explicitReference })
  const latencyMs = Math.max(0, Date.now() - startedAt)
  const decisionKind = decision.kind === 'reserved-protocol' ? 'rejected' : decision.kind
  const reasonCode = 'reasonCode' in decision ? decision.reasonCode : decision.kind === 'continuation'
    ? 'semantic-unique-above-threshold' : decision.kind === 'successor' ? 'explicit-or-semantic-successor' : 'reserved-protocol'
  const candidateTrackIds = decision.kind === 'ambiguous' ? decision.candidateTrackIds : candidates.map(({ trackId }) => trackId)
  const created = recordRemoteTrackAttributionObservation(db, {
    channel: scope.channel, identityKey: scope.identityKey, ownerId: scope.ownerId,
    authorizationEpoch: scope.authorizationEpoch, platformMessageId: scope.platformMessageId,
    classifierVersion: classifier.classifierVersion ?? 'injected-classifier-v1', decisionKind, reasonCode, candidateTrackIds,
    scores: scores.slice(0, 10), latencyMs, classifierInvoked, ...(metering ? { metering } : {}), occurredAt: now
  }).created
  return { decision, created, latencyMs }
}

export type PersistedRemoteAttribution =
  | { kind: 'attributed'; decision: PersistedAttributionDecision; context: RemoteTrackContext }
  | { kind: 'unresolved'; decision: Extract<RemoteAttributionDecision, { kind: 'ambiguous' | 'rejected' | 'reserved-protocol' }> }

type PersistedAttributionDecision =
  | Extract<RemoteAttributionDecision, { kind: 'new-track' | 'continuation' }>
  | { kind: 'successor'; trackId: string; parentTrackId: string; confidence: number; evidenceCodes: readonly string[] }

function stateForCandidate(state: string): TrackCandidateSummary['state'] | null {
  if (state === 'open' || state === 'processing' || state === 'waiting-user' || state === 'waiting-async-approval' || state === 'resuming' || state === 'completed') return state
  return null
}

function readCandidates(db: AppDatabase, scope: AttributionScope, sessionQueries: Pick<SessionQueries, 'readMessage' | 'readSession'>): TrackCandidateSummary[] {
  const conn = getDbConnection(db)
  const rows = conn.prepare(`SELECT track.track_id,track.state,track.updated_at,track.origin_session_id,
      COALESCE((SELECT event.message_id FROM remote_track_events event WHERE event.track_id=track.track_id AND event.event_kind='track.model.message'
        ORDER BY event.occurred_at DESC,event.event_id DESC LIMIT 1),track.root_message_id) AS summary_message_id,
      COALESCE((SELECT json_extract(event.payload_json,'$.sessionId') FROM remote_track_events event WHERE event.track_id=track.track_id AND event.event_kind='track.model.message'
        ORDER BY event.occurred_at DESC,event.event_id DESC LIMIT 1),track.origin_session_id) AS summary_session_id
    FROM remote_tracks track
    WHERE track.channel=? AND track.identity_key=? AND track.owner_id=? AND track.authorization_epoch=?
      AND (track.state IN ('open','processing','waiting-user','waiting-async-approval','resuming') OR
        (track.state='completed' AND track.updated_at>=?))
      AND track.origin_session_id IS NOT NULL
    ORDER BY track.updated_at DESC,track.track_id LIMIT 10`).all(
    scope.channel, scope.identityKey, scope.ownerId, scope.authorizationEpoch, (scope.now ?? Date.now()) - 30 * 60_000
  ) as Array<{ track_id: string; state: string; updated_at: number; origin_session_id: string | null; summary_message_id: string | null; summary_session_id: string | null }>
  return rows.flatMap((row) => {
    const state = stateForCandidate(row.state)
    if (!state) return []
    const sessionId = row.summary_session_id ?? row.origin_session_id
    const summary = sessionId && sessionQueries.readSession(sessionId) && row.summary_message_id
      ? sessionQueries.readMessage({ sessionId, messageId: row.summary_message_id })?.content ?? '' : ''
    return [{ trackId: row.track_id, state, summary: summary.slice(0, 240), updatedAt: row.updated_at }]
  })
}

function readPersistedAttributionReceipt(db: AppDatabase, scope: AttributionScope): PersistedRemoteAttribution | null {
  const conn = getDbConnection(db)
  const existing = conn.prepare(`SELECT map.track_id,map.event_id,event.event_kind,event.payload_json,track.root_message_id,track.parent_track_id,track.origin_session_id,
      track.identity_key,track.owner_id,track.authorization_epoch
    FROM remote_track_message_map map JOIN remote_tracks track ON track.track_id=map.track_id
    JOIN remote_track_events event ON event.event_id=map.event_id
    WHERE map.channel=? AND map.platform_message_id=? AND map.direction='inbound'`)
    .get(scope.channel, scope.platformMessageId) as { track_id: string; event_id: string; event_kind: string; payload_json: string; root_message_id: string;
      parent_track_id: string | null; origin_session_id: string | null; identity_key: string; owner_id: string; authorization_epoch: number } | undefined
  if (!existing) return null
  if (existing.identity_key !== scope.identityKey || existing.owner_id !== scope.ownerId || existing.authorization_epoch !== scope.authorizationEpoch) {
    throw new Error('REMOTE_TRACK_INBOUND_RECEIPT_SCOPE_COLLISION')
  }
  let payload: { confidence?: unknown; evidenceCodes?: unknown; attributionReasonCode?: unknown } = {}
  try { payload = JSON.parse(existing.payload_json) as typeof payload } catch { throw new Error('REMOTE_TRACK_INBOUND_RECEIPT_CORRUPT') }
  const evidenceCodes = Array.isArray(payload.evidenceCodes) ? payload.evidenceCodes.filter((value): value is string => typeof value === 'string') : ['idempotent-receipt']
  const decision: PersistedAttributionDecision = existing.event_kind === 'track.inbound.accepted'
    ? (existing.parent_track_id
      ? { kind: 'successor', trackId: existing.track_id, parentTrackId: existing.parent_track_id,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : 1, evidenceCodes }
      : { kind: 'new-track', reasonCode: typeof payload.attributionReasonCode === 'string' ? payload.attributionReasonCode : 'no-eligible-candidates' })
    : { kind: 'continuation', trackId: existing.track_id,
      confidence: typeof payload.confidence === 'number' ? payload.confidence : 1, evidenceCodes }
  return { kind: 'attributed', decision, context: { trackId: existing.track_id, channel: scope.channel, identityKey: scope.identityKey,
    ownerId: scope.ownerId, authorizationEpoch: scope.authorizationEpoch, rootMessageId: existing.root_message_id,
    ...(existing.parent_track_id ? { parentTrackId: existing.parent_track_id } : {}),
    ...(existing.origin_session_id ? { originSessionId: existing.origin_session_id } : {}), attributionEventId: existing.event_id } }
}

/** The sole persistence boundary for accepted ordinary IM messages after authentication and dedupe. */
export async function attributeAndPersistRemoteMessage(
  db: AppDatabase,
  scope: AttributionScope,
  classifier: IntentAttributor,
  options: { semanticEnabled?: boolean; shadowObservationEnabled?: boolean; onPersisted?: (context: RemoteTrackContext) => void;
    sessionQueries: Pick<SessionQueries, 'readMessage' | 'readSession'> }
): Promise<PersistedRemoteAttribution> {
  if (!scope.platformMessageId.trim() || !scope.identityKey.trim() || !scope.ownerId.trim() ||
    !Number.isSafeInteger(scope.authorizationEpoch) || scope.authorizationEpoch <= 0) {
    throw new Error('REMOTE_TRACK_ATTRIBUTION_SCOPE_INVALID')
  }
  const now = scope.now ?? Date.now()
  const conn = getDbConnection(db)
  const durableEpoch = conn.prepare('SELECT epoch FROM remote_authorization_epochs WHERE channel=?').get(scope.channel) as { epoch: number } | undefined
  if (!durableEpoch || durableEpoch.epoch !== scope.authorizationEpoch) throw new Error('REMOTE_TRACK_ATTRIBUTION_EPOCH_STALE')
  const receipt = readPersistedAttributionReceipt(db, scope)
  if (receipt) return receipt
  const candidates = readCandidates(db, scope, options.sessionQueries)
  let explicitReference: Parameters<typeof attributeRemoteMessage>[0]['explicitReference']
  if (scope.replyToPlatformMessageId) {
    const reference = resolveRemoteTrackMessageReference(db, {
      channel: scope.channel, platformMessageId: scope.replyToPlatformMessageId,
      identityKey: scope.identityKey, ownerId: scope.ownerId, authorizationEpoch: scope.authorizationEpoch
    })
    if (reference) {
      const state = stateForCandidate(reference.state)
      explicitReference = { trackId: reference.trackId, state: state ?? 'unavailable' }
    } else {
      // A platform quote that cannot be resolved is stale evidence. It must never fall back to semantic guessing.
      explicitReference = { trackId: '', state: 'unavailable' }
    }
  }
  let classifierInvoked = false
  let classifierMetering: IntentAttributorMetering | undefined
  let classifierScores: Array<{ trackId: string; score: number }> = []
  const measuredClassifier: IntentAttributor = {
    classifierVersion: classifier.classifierVersion,
    async classify(input) {
      classifierInvoked = true
      const result = await classifier.classify(input)
      classifierMetering = result.metering
      if (result.kind === 'scores') {
        const allowed = new Set(input.candidates.map(({ trackId }) => trackId))
        const seen = new Set<string>()
        classifierScores = result.scores.flatMap(({ trackId, score }) => {
          if (!allowed.has(trackId) || seen.has(trackId) || !Number.isFinite(score) || score < 0 || score > 1) return []
          seen.add(trackId)
          return [{ trackId, score }]
        })
      }
      return result
    }
  }
  const classificationStartedAt = Date.now()
  const needsShadowOnlyClassification = options.semanticEnabled === false && options.shadowObservationEnabled === true &&
    !explicitReference && candidates.length > 0
  const classificationDecision = options.semanticEnabled !== false || explicitReference || candidates.length === 0 || needsShadowOnlyClassification
    ? await attributeRemoteMessage({ text: scope.text, candidates, classifier: measuredClassifier, explicitReference })
    : undefined
  const decision = options.semanticEnabled === false && !explicitReference && candidates.length > 0
    ? classificationDecision?.kind === 'new-track'
      ? classificationDecision
      : { kind: 'ambiguous' as const, candidateTrackIds: candidates.map(({ trackId }) => trackId), reasonCode: 'semantic-continuation-disabled' }
    : classificationDecision!
  if (options.shadowObservationEnabled) {
    const shadowDecision = classificationDecision ?? decision
    const decisionKind = shadowDecision.kind === 'reserved-protocol' ? 'rejected' : shadowDecision.kind
    const reasonCode = 'reasonCode' in shadowDecision ? shadowDecision.reasonCode : shadowDecision.kind === 'continuation'
      ? 'semantic-unique-above-threshold' : shadowDecision.kind === 'successor' ? 'explicit-or-semantic-successor' : 'reserved-protocol'
    const candidateTrackIds = shadowDecision.kind === 'ambiguous' ? shadowDecision.candidateTrackIds : candidates.map(({ trackId }) => trackId)
    recordRemoteTrackAttributionObservation(db, {
      channel: scope.channel, identityKey: scope.identityKey, ownerId: scope.ownerId, authorizationEpoch: scope.authorizationEpoch,
      platformMessageId: scope.platformMessageId, classifierVersion: classifier.classifierVersion ?? 'injected-classifier-v1',
      decisionKind, reasonCode, candidateTrackIds, scores: classifierScores.slice(0, 10),
      latencyMs: Math.max(0, Date.now() - classificationStartedAt), classifierInvoked,
      ...(classifierMetering ? { metering: classifierMetering } : {}), occurredAt: now
    })
  }
  if (decision.kind === 'ambiguous' || decision.kind === 'rejected' || decision.kind === 'reserved-protocol') {
    return { kind: 'unresolved', decision }
  }

  const eventId = randomUUID()
  const trackId = decision.kind === 'continuation' ? decision.trackId : randomUUID()
  const parentTrackId = decision.kind === 'successor' ? decision.parentTrackId : undefined
  const evidenceCodes = 'evidenceCodes' in decision ? [...decision.evidenceCodes] : []
  const attributionAudit = {
    attributionDecisionKind: decision.kind,
    ...('reasonCode' in decision ? { attributionReasonCode: decision.reasonCode } : {}),
    attributionPolicyVersion: REMOTE_TRACK_ATTRIBUTION_POLICY_VERSION,
    classifierVersion: classifier.classifierVersion ?? 'injected-classifier-v1',
    classifierInvoked,
    providerCallMade: classifierInvoked ? classifierMetering?.providerCallMade ?? null : false,
    classifierInputTokens: classifierMetering?.inputTokens ?? null,
    classifierOutputTokens: classifierMetering?.outputTokens ?? null,
    classifierCacheReadInputTokens: classifierMetering?.cacheReadInputTokens ?? null,
    classifierCacheCreationInputTokens: classifierMetering?.cacheCreationInputTokens ?? null,
    classifierEstimatedCostUsd: classifierMetering?.estimatedCostUsd ?? null,
    decisionSource: evidenceCodes.includes('explicit-platform-reference') ? 'explicit-reference'
      : evidenceCodes.includes('semantic-unique-above-threshold') ? 'semantic-classifier'
        : decision.kind === 'new-track' && decision.reasonCode === 'no-reasonable-continuation-candidate'
          ? 'semantic-no-match' : 'deterministic-new',
    continuationThreshold: REMOTE_TRACK_CONTINUATION_SCORE_THRESHOLD,
    continuationMargin: REMOTE_TRACK_CONTINUATION_SCORE_MARGIN,
    semanticContinuationEnabled: options.semanticEnabled !== false
  }
  const inheritedTrackId = decision.kind === 'continuation' ? decision.trackId : decision.kind === 'successor' ? decision.parentTrackId : null
  const originSessionId = inheritedTrackId
    ? (conn.prepare('SELECT origin_session_id FROM remote_tracks WHERE track_id=?').get(inheritedTrackId) as { origin_session_id: string | null } | undefined)?.origin_session_id
    : scope.originSessionId ?? await scope.resolveNewTrackSession?.()
  if (inheritedTrackId && !originSessionId) throw new Error('REMOTE_TRACK_ORIGIN_SESSION_UNAVAILABLE')
  const effectiveOriginSessionId = originSessionId ?? undefined
  const rootMessageId = decision.kind === 'continuation'
    ? (getDbConnection(db).prepare('SELECT root_message_id FROM remote_tracks WHERE track_id=?').get(trackId) as { root_message_id: string } | undefined)?.root_message_id
    : scope.platformMessageId
  if (!rootMessageId) throw new Error('REMOTE_TRACK_ATTRIBUTION_TARGET_MISSING')
  const actualTrackId = decision.kind === 'continuation' ? decision.trackId : trackId

  const idempotencyKey = `inbound:${scope.channel}:${scope.identityKey}:${scope.platformMessageId}`
  const explicitParent = scope.replyToPlatformMessageId
    ? resolveRemoteTrackMessageReference(db, { channel: scope.channel, platformMessageId: scope.replyToPlatformMessageId,
      identityKey: scope.identityKey, ownerId: scope.ownerId, authorizationEpoch: scope.authorizationEpoch })
    : null
  const parentEventId = explicitParent?.eventId ?? (decision.kind === 'continuation'
    ? (conn.prepare('SELECT event_id FROM remote_track_events WHERE track_id=? ORDER BY occurred_at DESC,event_id DESC LIMIT 1').get(trackId) as { event_id: string } | undefined)?.event_id
    : undefined)
  runInTransaction(conn, () => {
    // Recheck after acquiring SQLite's write transaction: simultaneous model classifications
    // for the same platform message must converge on the first durable receipt.
    if (readPersistedAttributionReceipt(db, scope)) return
    if (decision.kind === 'new-track' || decision.kind === 'successor') {
      createRemoteTrack(db, {
        trackId, eventId, idempotencyKey, channel: scope.channel, identityKey: scope.identityKey, ownerId: scope.ownerId,
        authorizationEpoch: scope.authorizationEpoch, rootMessageId: scope.platformMessageId, originSessionId: effectiveOriginSessionId,
        ...(parentTrackId ? { parentTrackId } : {}), ...(parentEventId && parentTrackId ? { parentEventId } : {}), attributionAudit, occurredAt: now
      })
    } else {
      appendRemoteTrackEvent(db, {
        eventId, trackId, eventKind: 'track.inbound.attributed', idempotencyKey,
        ...(parentEventId ? { parentEventId } : {}), messageId: scope.platformMessageId, occurredAt: now,
        payload: { confidence: decision.confidence, evidenceCodes, ...attributionAudit }
      })
    }
    const persistedEvent = conn.prepare('SELECT event_id,track_id FROM remote_track_events WHERE idempotency_key=?').get(idempotencyKey) as { event_id: string; track_id: string } | undefined
    if (!persistedEvent || persistedEvent.track_id !== trackId) throw new Error('REMOTE_TRACK_ATTRIBUTION_EVENT_PERSIST_FAILED')
    mapRemoteTrackMessage(db, { channel: scope.channel, platformMessageId: scope.platformMessageId, trackId, eventId: persistedEvent.event_id, direction: 'inbound' })
    const callbackResult = options.onPersisted?.({ trackId: actualTrackId, channel: scope.channel, identityKey: scope.identityKey,
      ownerId: scope.ownerId, authorizationEpoch: scope.authorizationEpoch, rootMessageId,
      ...(parentTrackId ? { parentTrackId } : {}), ...(effectiveOriginSessionId ? { originSessionId: effectiveOriginSessionId } : {}),
      attributionEventId: persistedEvent.event_id })
    if (callbackResult && typeof (callbackResult as { then?: unknown }).then === 'function') {
      throw new Error('REMOTE_TRACK_ATTRIBUTION_CALLBACK_MUST_BE_SYNCHRONOUS')
    }
  })
  const persistedReceipt = readPersistedAttributionReceipt(db, scope)
  if (persistedReceipt) return persistedReceipt
  const persistedEvent = conn.prepare('SELECT event_id FROM remote_track_events WHERE idempotency_key=?').get(idempotencyKey) as { event_id: string }

  const context: RemoteTrackContext = {
    trackId: actualTrackId, channel: scope.channel, identityKey: scope.identityKey, ownerId: scope.ownerId,
    authorizationEpoch: scope.authorizationEpoch, rootMessageId,
    ...(parentTrackId ? { parentTrackId } : {}), ...(effectiveOriginSessionId ? { originSessionId: effectiveOriginSessionId } : {}), attributionEventId: persistedEvent.event_id
  }
  if (decision.kind === 'successor') return { kind: 'attributed', decision: { ...decision, trackId: actualTrackId }, context }
  return { kind: 'attributed', decision, context }
}

/** Exported for focused tests and operational inspection without exposing mutable DB rows. */
export function listRemoteTrackAttributionCandidates(db: AppDatabase, scope: Omit<AttributionScope, 'platformMessageId' | 'text' | 'replyToPlatformMessageId' | 'now'>,
  sessionQueries: Pick<SessionQueries, 'readMessage' | 'readSession'>): TrackCandidateSummary[] {
  return readCandidates(db, { ...scope, platformMessageId: '', text: '' }, sessionQueries)
}

/** Rehydrates the exact inbox attribution and verifies it against the durable authority snapshot. */
export function readRemoteTrackContextForInbound(
  db: AppDatabase,
  inboxMessageId: string,
  scope: { channel: RemoteTrackChannel; identityKey: string; ownerId: string; authorizationEpoch: number }
): RemoteTrackContext | null {
  const inbox = getImInboxMessageContext(db, inboxMessageId)
  if (!inbox || inbox.channel !== scope.channel || !inbox.trackId || !inbox.trackEventId) return null
  const conn = getDbConnection(db)
  const row = conn.prepare(`SELECT track.channel,track.identity_key,track.owner_id,track.authorization_epoch,track.root_message_id,track.origin_session_id,
      track.parent_track_id,event.event_id,event.track_id
    FROM remote_tracks track JOIN remote_track_events event ON event.track_id=track.track_id
    WHERE track.track_id=? AND event.event_id=?`)
    .get(inbox.trackId, inbox.trackEventId) as { channel: string; identity_key: string; owner_id: string; authorization_epoch: number;
      root_message_id: string; origin_session_id: string | null; parent_track_id: string | null; event_id: string; track_id: string } | undefined
  if (!row || row.channel !== scope.channel || row.identity_key !== scope.identityKey || row.owner_id !== scope.ownerId ||
    row.authorization_epoch !== scope.authorizationEpoch || row.event_id !== inbox.trackEventId || row.track_id !== inbox.trackId) return null
  return { trackId: row.track_id, channel: scope.channel, identityKey: row.identity_key, ownerId: row.owner_id,
    authorizationEpoch: row.authorization_epoch, rootMessageId: row.root_message_id,
    ...(row.parent_track_id ? { parentTrackId: row.parent_track_id } : {}),
    ...(row.origin_session_id ? { originSessionId: row.origin_session_id } : {}), attributionEventId: row.event_id }
}

export function readDurableRemoteTrackEpoch(db: AppDatabase, channel: RemoteTrackChannel): number {
  const row = getDbConnection(db).prepare('SELECT epoch FROM remote_authorization_epochs WHERE channel=?').get(channel) as { epoch: number } | undefined
  if (!row || !Number.isSafeInteger(row.epoch) || row.epoch <= 0) throw new Error(`REMOTE_AUTHORIZATION_EPOCH_INVALID:${channel}`)
  return row.epoch
}
