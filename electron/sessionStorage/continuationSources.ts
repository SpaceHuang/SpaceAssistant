import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { summarizeFailedInvocation } from '../runtime/continuationSummary'
import type { ContinuationSourceQueries, FailedSourceCandidate, ContinuationSourceInspection } from './contracts'

/** Session-scoped canonical History inspection; callers choose policy but never enumerate storage. */
export function inspectContinuationSources(db: AppDatabase): ContinuationSourceQueries {
  const queries: ContinuationSourceQueries = {
    readRecoveryFacts: (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('CONTINUATION_SOURCE_SESSION_ID_REQUIRED')
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId)
      const inherited = new Map<string, import('../runtime/agentContinuation').UnresolvedEffect>()
      const outcomes = new Map<string, { id: string; toolName?: string; outcome: 'succeeded' | 'known-failure' | 'unknown-after-dispatch' | 'not-dispatched' }>()
      const resolutions = new Set<string>()
      for (const invocationId of history.listInvocationIdsForSession(sessionId)) {
        const snapshot = history.readSync(invocationId)
        const context = snapshot.events.find((event) => event.kind === 'invocation-context-committed')?.payload as { unresolvedEffects?: unknown } | undefined
        if (Array.isArray(context?.unresolvedEffects)) for (const raw of context.unresolvedEffects) {
          if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' && typeof (raw as { originInvocationId?: unknown }).originInvocationId === 'string' && typeof (raw as { toolCallId?: unknown }).toolCallId === 'string') {
            inherited.set((raw as import('../runtime/agentContinuation').UnresolvedEffect).id, raw as import('../runtime/agentContinuation').UnresolvedEffect)
          }
        }
        const started = new Map<string, { toolName?: string; inputHash?: string }>()
        const settled = new Set<string>()
        for (const event of snapshot.events) {
          const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {}
          if (event.kind === 'tool-call-started' && typeof payload.toolCallId === 'string') started.set(payload.toolCallId, { ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}), ...(typeof payload.inputHash === 'string' ? { inputHash: payload.inputHash } : {}) })
          if (event.kind === 'tool-call-not-dispatched' && typeof payload.toolCallId === 'string') {
            settled.add(payload.toolCallId)
            outcomes.set(`${invocationId}:${payload.toolCallId}`, { id: `${invocationId}:${payload.toolCallId}`, outcome: 'not-dispatched' })
          }
          if (event.kind === 'tool-call-finished' && typeof payload.toolCallId === 'string') {
            const unknown = payload.executionOutcome === 'unknown-after-dispatch'
            if (!unknown) settled.add(payload.toolCallId)
            const start = started.get(payload.toolCallId)
            outcomes.set(`${invocationId}:${payload.toolCallId}`, { id: `${invocationId}:${payload.toolCallId}`, ...(start?.toolName ? { toolName: start.toolName } : {}), outcome: unknown ? 'unknown-after-dispatch' : payload.executionOutcome === 'succeeded' || payload.isError === false ? 'succeeded' : 'known-failure' })
          }
          if (event.kind === 'unknown-effect-resolved' && payload.trustedResolution === true && typeof payload.unknownEffectId === 'string') resolutions.add(payload.unknownEffectId)
        }
        for (const [toolCallId, start] of started) if (!settled.has(toolCallId)) {
          const id = `${invocationId}:${toolCallId}`
          inherited.set(id, { id, originInvocationId: invocationId, toolCallId, ...start })
          outcomes.set(id, { id, ...(start.toolName ? { toolName: start.toolName } : {}), outcome: 'unknown-after-dispatch' })
        }
      }
      for (const id of resolutions) inherited.delete(id)
      return { unresolvedEffects: [...inherited.values()], toolOutcomes: [...outcomes.values()] }
    },
    read: ({ sessionId, activeTurnIds, selectedAssistantMessageId }): ContinuationSourceInspection => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('CONTINUATION_SOURCE_SESSION_ID_REQUIRED')
      const conn = getDbConnection(db)
      const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
      const ids = history.listInvocationIdsForSession(sessionId)
      const active = new Set(activeTurnIds)
      const latest = ids.length ? history.readSync(ids.at(-1)!) : undefined
      const latestEvent = latest?.events.at(-1)
      const terminalKinds = ['invocation-completed', 'invocation-failed', 'invocation-interrupted']
      const superseded = Boolean(latestEvent && !terminalKinds.includes(latestEvent.kind) && active.has(latestEvent.turnId))
      if (latestEvent && !superseded && !terminalKinds.includes(latestEvent.kind)) {
        return { kind: 'unavailable', reason: 'CONTINUATION_INTENT_HISTORY_UNAVAILABLE' }
      }
      const sourceMessage = (turnId: string) => conn.prepare('SELECT turns.request_id AS requestId, turns.assistant_message_id AS assistantMessageId, messages.sequence AS assistantSequence FROM turns LEFT JOIN messages ON messages.id=turns.assistant_message_id AND messages.session_id=turns.session_id WHERE turns.session_id=? AND turns.turn_id=?').get(sessionId, turnId) as { requestId?: string; assistantMessageId?: string; assistantSequence?: number } | undefined
      const readAssistantSkeleton = (messageId: string) => conn.prepare("SELECT id,sequence FROM messages WHERE session_id=? AND id=? AND role='assistant'").get(sessionId, messageId) as { id: string; sequence: number } | undefined
      const newerUserExists = (sequence: number) => Boolean(conn.prepare("SELECT id FROM messages WHERE session_id=? AND role='user' AND sequence>? AND status IN ('sent','queued') ORDER BY sequence ASC LIMIT 1").get(sessionId, sequence))
      const makeCandidate = (snapshot: ReturnType<SqliteAgentHistory['readSync']>, assistantMessageId?: string, assistantSequence?: number): FailedSourceCandidate => {
        const terminal = snapshot.events.at(-1)!
        const checkpointSequence = snapshot.events.slice(0, -1).at(-1)?.sequence
        if (checkpointSequence == null) throw new Error('CONTINUATION_INTENT_HISTORY_UNAVAILABLE')
        const summary = summarizeFailedInvocation(snapshot, snapshot.invocationId, terminal.turnId)
        return {
          source: { sessionId, invocationId: snapshot.invocationId, turnId: terminal.turnId, checkpointSequence, expectedHistoryVersion: snapshot.version },
          ...(assistantMessageId ? { assistantMessageId } : {}), ...(assistantSequence != null ? { assistantSequence } : {}), snapshot, summary: {
            invocationId: summary.sourceInvocationId, turnId: summary.sourceTurnId, sequence: summary.historySequence, summary: summary.summary, state: summary.state
          }
        }
      }
      let boundary: 'running-turn-superseded' | 'newer-input' | 'completed-invocation' | 'history-start' = superseded ? 'running-turn-superseded' : 'history-start'
      const failedCandidates: FailedSourceCandidate[] = []
      if (!superseded) {
        for (const invocationId of [...ids].reverse()) {
          const snapshot = history.readSync(invocationId)
          const terminal = snapshot.events.at(-1)
          if (terminal?.kind === 'invocation-failed' || terminal?.kind === 'invocation-interrupted') {
            const row = sourceMessage(terminal.turnId)
            if (row?.assistantSequence != null && newerUserExists(row.assistantSequence)) { boundary = 'newer-input'; break }
            failedCandidates.push(makeCandidate(snapshot, row?.assistantMessageId, row?.assistantSequence))
            continue
          }
          if (terminal?.kind === 'invocation-completed') { boundary = 'completed-invocation'; break }
        }
      }
      let selected: { kind: 'not-requested' } | { kind: 'found'; candidate: FailedSourceCandidate } | { kind: 'not-found' | 'not-recoverable' } = { kind: 'not-requested' }
      let selectedFallback: FailedSourceCandidate | undefined
      if (selectedAssistantMessageId) {
        const selectedMessage = readAssistantSkeleton(selectedAssistantMessageId)
        const turn = selectedMessage && conn.prepare('SELECT turn_id AS turnId,request_id AS requestId FROM turns WHERE session_id=? AND assistant_message_id=?').get(sessionId, selectedMessage.id) as { turnId: string; requestId: string } | undefined
        const candidate = turn && failedCandidates.find((item) => item.source.turnId === turn.turnId || item.source.invocationId === turn.requestId)
        if (candidate) selected = { kind: 'found', candidate }
        else if (selectedMessage && turn && failedCandidates.length === 0) {
          const snapshot = history.readSync(turn.requestId)
          if (snapshot.events.at(-1)?.kind === 'invocation-failed') {
            selectedFallback = makeCandidate(snapshot, selectedMessage.id, selectedMessage.sequence)
            selected = { kind: 'found', candidate: selectedFallback }
          }
          else selected = { kind: 'not-recoverable' }
        } else selected = { kind: 'not-found' }
      }
      let fallback: FailedSourceCandidate | undefined
      const recentUser = conn.prepare("SELECT id,sequence FROM messages WHERE session_id=? AND role='user' ORDER BY sequence DESC LIMIT 1").get(sessionId) as { id: string; sequence: number } | undefined
      const failedMessages = conn.prepare("SELECT id,sequence FROM messages WHERE session_id=? AND role='assistant' AND status='failed' ORDER BY sequence ASC").all(sessionId) as Array<{ id: string; sequence: number }>
      if (failedCandidates.length === 0 && recentUser && failedMessages.length === 1) {
        const failed = failedMessages[0]!
        const turn = conn.prepare('SELECT turn_id AS turnId,request_id AS requestId FROM turns WHERE session_id=? AND assistant_message_id=?').get(sessionId, failed.id) as { turnId: string; requestId: string } | undefined
        if (turn?.requestId && recentUser.sequence < failed.sequence) {
          const snapshot = history.readSync(turn.requestId)
          if (snapshot.events.at(-1)?.kind === 'invocation-failed') fallback = makeCandidate(snapshot, failed.id, failed.sequence)
        }
      }
      return { kind: 'available', boundary, failedCandidates, selected, ...(fallback ? { fallback } : {}), ...(selectedFallback ? { selectedFallback } : {}) }
    }
  }
  return Object.freeze(queries)
}
