import type { HistoryEvent } from '../../../../packages/agent-sdk/src/history'
import type { ProjectionHistoryChunkEvent } from '../../domain/projectionSource'
import type { ProjectionHistoryReducerPort } from '../../application/projectionBuildCoordinator'
import { createCanonicalHistoryReductionState, finalizeCanonicalHistoryReduction, foldCanonicalHistoryChunk,
  parseCanonicalHistoryReductionState } from '../../../runtime/canonicalHistory'

/** Adapts durable session-ordered History rows to the pure canonical invocation reducer. */
export function createProjectionCanonicalHistoryReducer(): ProjectionHistoryReducerPort {
  return Object.freeze({
    createState: () => JSON.stringify(createCanonicalHistoryReductionState()),
    fold(stateJson: string, rows: readonly ProjectionHistoryChunkEvent[], _messageFacts?: readonly import('../../domain/projectionSource').ProjectionMessageFact[]) {
      let state = parseCanonicalHistoryReductionState(stateJson)
      if (!state) throw new Error('projection history reducer checkpoint is invalid')
      const events: HistoryEvent[] = rows.map((row) => ({ invocationId: row.invocationId, turnId: row.turnId,
        sequence: row.sequence, schemaVersion: row.schemaVersion, eventId: row.eventId,
        idempotencyKey: row.idempotencyKey, kind: row.kind as HistoryEvent['kind'], payload: parsePayload(row.payloadJson) }))
      const seenInvocationIds = new Set<string>()
      const outputOperations: unknown[] = []
      for (let start = 0; start < events.length;) {
        const first = events[start]!
        if (seenInvocationIds.has(first.invocationId)) throw new Error('projection History invocation rows are not contiguous')
        seenInvocationIds.add(first.invocationId)
        let end = start + 1
        while (end < events.length && events[end]!.invocationId === first.invocationId) end += 1
        if (state.invocationId !== null && state.invocationId !== first.invocationId) {
          if (!state.terminalEvent) throw new Error('projection History changed invocation before a terminal event')
          outputOperations.push(...finalizeCanonicalHistoryReduction(state).outputOperations)
          state = createCanonicalHistoryReductionState(state.options)
        }
        const folded = foldCanonicalHistoryChunk(state, events.slice(start, end))
        state = folded.state
        outputOperations.push(...folded.outputOperations)
        start = end
      }
      return Object.freeze({ stateJson: JSON.stringify(state), outputOperations: Object.freeze(outputOperations),
        resetOutput: outputOperations.some((operation) => operation && typeof operation === 'object' && 'type' in operation && operation.type === 'replace') })
    },
    finalize(stateJson: string) {
      const state = parseCanonicalHistoryReductionState(stateJson)
      if (!state) throw new Error('projection history reducer checkpoint is invalid')
      return finalizeCanonicalHistoryReduction(state)
    },
  })
}

function parsePayload(json: string): unknown {
  const value: unknown = JSON.parse(json)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('projection History event payload must be an object')
  return value
}
