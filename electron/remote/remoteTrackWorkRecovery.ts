import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { getPersistedTurn } from '../database/operations'
import { readAcceptedTurn } from '../database/acceptedTurnStorage'
import { buildTrackModelInputViewRef } from './trackModelInputViewStore'
import type { SessionQueries } from '../sessionStorage/public/ports'
import { settleRemoteTrackWork, type RemoteTrackWorkClaim } from '../database/remoteTrackStore'

export type RemoteTrackWorkRecoveryFacts = Readonly<{
  workState: 'queued' | 'claimed' | 'completed' | 'needs-reconciliation'
  hasStableMapping: boolean
  frozenConfigAvailable: boolean
  modelInputViewAvailable: boolean
  startupRecoveryTerminalized: boolean
  turnState: 'absent' | 'configuring' | 'prepared' | 'executing' | 'waiting-confirm' | 'terminal'
  canonicalTerminal?: 'completed' | 'parked' | 'failed' | 'cancelled' | 'interrupted' | 'outcome-unknown'
  dispatchOutcome?: 'not-dispatched' | 'dispatched' | 'unknown'
  hasRecoverableAsyncApproval?: boolean
  evidenceConsistent?: boolean
}>

export type RemoteTrackWorkRecoveryDecision =
  | { kind: 'prepare-new-turn' }
  | { kind: 'resume-prepared-turn' }
  | { kind: 'delegate-async-recovery' }
  | { kind: 'ack-completed' | 'ack-parked' | 'ack-failed' | 'terminalize-interrupted' | 'terminalize-outcome-unknown' | 'fail-before-start' | 'reconcile' }

/** Terminal work must be acknowledged without trying to acquire a lease again. */
export function isRemoteTrackWorkSettled(state: string | null | undefined): boolean {
  return state === 'completed' || state === 'needs-reconciliation'
}

/** Shared settlement owner for a Track work item whose canonical turn is already terminal. */
export function settleRemoteTrackWorkFromTurn(db: AppDatabase, input: {
  claim: RemoteTrackWorkClaim
  outcome: string | null | undefined
  now: number
  noticeText?: string
}): boolean {
  const state = input.outcome === 'completed' || input.outcome === 'parked' ? 'completed'
    : ['failed', 'cancelled', 'interrupted', 'outcome-unknown'].includes(input.outcome ?? '') ? 'needs-reconciliation'
      : null
  if (!state) return false
  return settleRemoteTrackWork(db, {
    workId: input.claim.workId,
    workerId: input.claim.workerId,
    attempt: input.claim.attempt,
    state,
    now: input.now,
    ...(state === 'needs-reconciliation' && input.noticeText ? { noticeText: input.noticeText } : {})
  })
}

export type InspectedRemoteTrackWorkRecovery = Readonly<{
  workId: string
  decision: RemoteTrackWorkRecoveryDecision
  facts: RemoteTrackWorkRecoveryFacts
}>

/** Reads durable recovery evidence. It never mutates the work lease or replays a turn. */
export function inspectRemoteTrackWorkRecovery(db: AppDatabase, workId: string,
  sessionQueries: Pick<SessionQueries, 'readMessage' | 'readMessageSkeleton'>): InspectedRemoteTrackWorkRecovery | null {
  const conn = getDbConnection(db)
  const row = conn.prepare(`SELECT work.work_id,work.track_id,work.clarification_id,work.state AS work_state,
      work.session_id,work.request_id,work.turn_id,work.user_message_id,work.model_view_version,
      track.channel,track.identity_key,track.owner_id,track.authorization_epoch,track.root_message_id
    FROM remote_track_work_queue work JOIN remote_tracks track ON track.track_id=work.track_id WHERE work.work_id=?`)
    .get(workId) as { work_id: string; track_id: string; clarification_id: string | null; work_state: string;
      session_id: string | null; request_id: string | null; turn_id: string | null; user_message_id: string | null;
      model_view_version: string | null; channel: 'wechat' | 'feishu'; identity_key: string; owner_id: string;
      authorization_epoch: number; root_message_id: string } | undefined
  if (!row || !['queued', 'claimed', 'completed', 'needs-reconciliation'].includes(row.work_state)) return null

  const hasStableMapping = Boolean(row.session_id?.trim() && row.request_id?.trim() && row.turn_id?.trim() &&
    row.user_message_id?.trim() && row.model_view_version?.trim())
  const turn = row.turn_id ? getPersistedTurn(db, row.turn_id) : undefined
  const accepted = row.session_id && row.request_id ? readAcceptedTurn(db, row.session_id, row.request_id) : undefined
  let modelInputViewAvailable = false
  if (hasStableMapping && row.session_id && row.turn_id && row.user_message_id && row.model_view_version && turn?.state === 'prepared') {
    const attribution = conn.prepare(`SELECT event_id FROM remote_track_events WHERE track_id=? AND event_kind IN ('track.inbound.consumed','track.inbound.accepted')
      AND idempotency_key=?`).get(row.track_id, row.clarification_id ? `clarification:${row.clarification_id}` : '') as { event_id: string } | undefined
    if (attribution) {
      try {
        const view = buildTrackModelInputViewRef(db, { trackId: row.track_id, sessionId: row.session_id,
          acceptedUserMessageId: row.user_message_id, currentInvocationId: row.turn_id, channel: row.channel,
          identityKey: row.identity_key, ownerId: row.owner_id, authorizationEpoch: row.authorization_epoch,
          rootMessageId: row.root_message_id, attributionEventId: attribution.event_id }, sessionQueries)
        modelInputViewAvailable = view.completeness === 'complete' && view.viewVersion === row.model_view_version
      } catch { modelInputViewAvailable = false }
    }
  }
  const turnState: RemoteTrackWorkRecoveryFacts['turnState'] = !turn ? 'absent'
    : turn.state === 'terminal' ? 'terminal'
      : turn.state === 'configuring' || turn.state === 'prepared' || turn.state === 'executing' || turn.state === 'waiting-confirm'
        ? turn.state : 'absent'
  const knownTurnState = !turn || ['configuring', 'prepared', 'executing', 'waiting-confirm', 'terminal'].includes(turn.state)
  const canonicalTerminal: RemoteTrackWorkRecoveryFacts['canonicalTerminal'] = turnState !== 'terminal' ? undefined
    : turn?.outcome === 'completed' ? 'completed'
      : turn?.outcome === 'parked' ? 'parked'
        : turn?.outcome === 'failed' ? 'failed'
          : turn?.outcome === 'cancelled' ? 'cancelled'
            : turn?.outcome === 'commit-uncertain' ? 'outcome-unknown'
              : turn?.outcome === 'timed-out' || turn?.outcome === 'recovered' ? 'interrupted' : undefined
  const hasRecoverableAsyncApproval = Boolean(conn.prepare(`SELECT 1 FROM deferred_todos WHERE track_id=? AND state IN ('pending','dispatching') LIMIT 1`)
    .get(row.track_id))
  const turnConfig = turn?.executionConfig
  const acceptedMatchesTurn = Boolean(turn && accepted && canResumePreparedRemoteTurn({
    turnState: turn.state, turnId: turn.turnId, requestId: turn.requestId, sessionId: turn.sessionId,
    userMessageId: turn.userMessageId, turnConfig,
    accepted: { turnId: accepted.turnId, requestId: accepted.requestId, sessionId: accepted.sessionId,
      currentUserMessageId: accepted.currentUserMessageId, config: accepted.config },
    ...(row.clarification_id ? { clarificationWorkMapping: { sessionId: row.session_id, requestId: row.request_id,
      turnId: row.turn_id, userMessageId: row.user_message_id, modelViewVersion: row.model_view_version } } : {})
  }))
  const facts: RemoteTrackWorkRecoveryFacts = {
    workState: row.work_state as RemoteTrackWorkRecoveryFacts['workState'], hasStableMapping,
    frozenConfigAvailable: Boolean(acceptedMatchesTurn), modelInputViewAvailable,
    startupRecoveryTerminalized: turnState === 'terminal' && ['recovered', 'timed-out', 'commit-uncertain'].includes(turn?.outcome ?? ''),
    turnState, ...(canonicalTerminal ? { canonicalTerminal } : {}),
    ...(turnState === 'executing' ? { dispatchOutcome: 'unknown' as const } : {}), hasRecoverableAsyncApproval,
    evidenceConsistent: knownTurnState
  }
  return { workId: row.work_id, facts, decision: decideRemoteTrackWorkRecovery(facts) }
}

export function canResumePreparedRemoteTurn(input: {
  turnState: string
  turnId: string
  requestId: string
  sessionId: string
  userMessageId?: string
  turnConfig?: Readonly<Record<string, unknown>>
  accepted?: Readonly<{ turnId: string; requestId: string; sessionId: string; currentUserMessageId: string; config: Readonly<Record<string, unknown>> }>
  clarificationWorkMapping?: Readonly<{ sessionId: string | null; requestId: string | null; turnId: string | null; userMessageId: string | null; modelViewVersion: string | null }>
}): boolean {
  if (input.turnState !== 'prepared' || !input.userMessageId || !input.turnConfig || !input.accepted) return false
  const accepted = input.accepted
  if (accepted.turnId !== input.turnId || accepted.requestId !== input.requestId || accepted.sessionId !== input.sessionId ||
    accepted.currentUserMessageId !== input.userMessageId) return false
  for (const key of ['lane', 'model', 'llmServiceId', 'thinkingEffort']) {
    const frozen = accepted.config[key]
    if (typeof frozen !== 'string' || !frozen.trim() || input.turnConfig[key] !== frozen) return false
  }
  if (input.clarificationWorkMapping && (
    input.clarificationWorkMapping.sessionId !== input.sessionId ||
    input.clarificationWorkMapping.requestId !== input.requestId ||
    input.clarificationWorkMapping.turnId !== input.turnId ||
    input.clarificationWorkMapping.userMessageId !== input.userMessageId ||
    !input.clarificationWorkMapping.modelViewVersion?.trim()
  )) return false
  return true
}

/** Pure policy: a work lease never proves that re-entering an Agent turn is safe. */
export function decideRemoteTrackWorkRecovery(facts: RemoteTrackWorkRecoveryFacts): RemoteTrackWorkRecoveryDecision {
  if (facts.evidenceConsistent === false) return { kind: 'reconcile' }
  if (facts.workState === 'needs-reconciliation') return { kind: 'reconcile' }
  if (facts.workState === 'completed') {
    return facts.canonicalTerminal === 'completed' || facts.canonicalTerminal === 'parked' || facts.canonicalTerminal === 'failed'
      ? terminalAck(facts.canonicalTerminal)
      : { kind: 'reconcile' }
  }
  if (facts.workState === 'queued' && facts.turnState === 'absent' && !facts.hasStableMapping) return { kind: 'prepare-new-turn' }
  if (facts.workState !== 'claimed' || !facts.hasStableMapping) return { kind: 'reconcile' }

  switch (facts.turnState) {
    case 'absent': return { kind: 'reconcile' }
    case 'configuring': return { kind: 'fail-before-start' }
    case 'prepared':
      if (facts.startupRecoveryTerminalized || !facts.frozenConfigAvailable || !facts.modelInputViewAvailable) return { kind: 'reconcile' }
      return { kind: 'resume-prepared-turn' }
    case 'executing':
      if (facts.canonicalTerminal) return terminalAck(facts.canonicalTerminal)
      return facts.dispatchOutcome === 'unknown'
        ? { kind: 'terminalize-outcome-unknown' }
        : { kind: 'terminalize-interrupted' }
    case 'waiting-confirm':
      return facts.hasRecoverableAsyncApproval ? { kind: 'delegate-async-recovery' } : { kind: 'terminalize-interrupted' }
    case 'terminal':
      return facts.canonicalTerminal ? terminalAck(facts.canonicalTerminal) : { kind: 'reconcile' }
  }
}

function terminalAck(terminal: NonNullable<RemoteTrackWorkRecoveryFacts['canonicalTerminal']>): RemoteTrackWorkRecoveryDecision {
  switch (terminal) {
    case 'completed': return { kind: 'ack-completed' }
    case 'parked': return { kind: 'ack-parked' }
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'outcome-unknown': return { kind: 'ack-failed' }
  }
}
