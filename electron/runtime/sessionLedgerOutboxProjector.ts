import {
  ensureFinalRequestContextEvent,
  ensureCompactionTransaction,
  ensureRequestProjectionEvents,
  ensureRequestRetryEvent,
  ensureRequestUsageEvent,
  ensureToolCallEvent,
  ensureToolResultEvent,
  ensureTurnEndEvent,
  ensureTurnStartEvent,
  readSessionEvents,
  type SessionEvent,
  type SessionEventInput,
  type SessionEventSink
} from '../sessionEvents'
import type { CanonicalLedgerProjectionTarget } from '../sessionLedgerOutbox'

/** Applies a canonical outbox target through the existing idempotent ledger projection primitive. */
export async function projectCanonicalSessionLedgerTarget(
  sink: SessionEventSink,
  target: CanonicalLedgerProjectionTarget
): Promise<{ eventIds: readonly string[]; events: readonly SessionEventInput[] }> {
  if (!target.expectedEvents.length) throw new Error('SESSION_LEDGER_PROJECTION_KIND_UNSUPPORTED')
  if (target.projectionKind === 'compaction' && target.expectedEvents.length === 2) {
    await ensureCompactionTransaction(sink, target.expectedEvents[0].payload, target.expectedEvents[1].payload)
  } else if (target.projectionKind === 'request-projection' && target.expectedEvents.length === 2) {
    await ensureRequestProjectionEvents(sink, {
      requestHeader: target.expectedEvents[0].payload,
      requestContext: target.expectedEvents[1].payload
    })
  } else {
    for (const expected of target.expectedEvents) {
      if (target.projectionKind === 'tool-result' && expected.type === 'tool_result') {
        await ensureToolResultEvent(sink, expected.payload as unknown as Parameters<typeof ensureToolResultEvent>[1])
      } else if (target.projectionKind.startsWith('tool-call:') && expected.type === 'tool_call') {
        await ensureToolCallEvent(sink, expected.payload as unknown as Parameters<typeof ensureToolCallEvent>[1])
      } else if (target.projectionKind === 'request-retry' && expected.type === 'request_retry') {
        await ensureRequestRetryEvent(sink, expected.payload)
      } else if (target.projectionKind === 'request-usage' && expected.type === 'request_usage') {
        await ensureRequestUsageEvent(sink, expected.payload)
      } else if (target.projectionKind === 'request-final-context' && expected.type === 'request_context') {
        await ensureFinalRequestContextEvent(sink, expected.payload)
      } else if (target.projectionKind === 'invocation-terminal' && expected.type === 'turn_start') {
        await ensureTurnStartEvent(sink, String(expected.payload.turnId))
      } else if (target.projectionKind === 'invocation-terminal' && expected.type === 'turn_end') {
        await ensureTurnEndEvent(sink, String(expected.payload.turnId), String(expected.payload.reason))
      } else {
        throw new Error('SESSION_LEDGER_PROJECTION_KIND_UNSUPPORTED')
      }
    }
  }
  const persisted = await readSessionEvents(sink.eventsPath)
  const events = target.expectedEvents.map((expected) => {
    const match = persisted.find((event) => sameProjectionIdentity(event, expected))
    if (!match || stableJson(match.payload) !== stableJson(expected.payload)) throw new Error('SESSION_LEDGER_PROJECTION_EVENT_NOT_COMMITTED')
    return { type: match.type, payload: match.payload }
  })
  const eventIds = events.map(projectionEventIdentity)
  if (JSON.stringify(eventIds) !== JSON.stringify(target.expectedEventIds)) throw new Error('SESSION_LEDGER_PROJECTION_IDENTITY_MISMATCH')
  return { eventIds, events }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function projectionEventIdentity(event: SessionEventInput): string {
  const payload = event.payload
  switch (event.type) {
    case 'tool_call': return `tool_call:${String(payload.toolUseId)}`
    case 'tool_result': return `tool_result:${String(payload.toolUseId)}`
    case 'request_header': return `request_header:${String(payload.requestId)}:${String(payload.attempt)}`
    case 'request_context': return payload.projectionStage === 'final'
      ? `request_context_final:${String(payload.requestId)}:${String(payload.attempt)}`
      : `request_context:${String(payload.requestId)}:${String(payload.attempt)}`
    case 'request_retry': return `request_retry:${String(payload.requestId)}:${String(payload.attempt)}`
    case 'request_usage': return `request_usage:${String(payload.requestId)}`
    case 'turn_start': return `turn_start:${String(payload.turnId)}`
    case 'turn_end': return `turn_end:${String(payload.turnId)}`
    case 'compaction_start': return `compaction_start:${String(payload.compactionId)}`
    case 'compaction_summary': return `compaction_summary:${String(payload.compactionId)}`
    default: throw new Error('SESSION_LEDGER_PROJECTION_IDENTITY_UNSUPPORTED')
  }
}

function sameProjectionIdentity(event: SessionEvent, expected: SessionEventInput): boolean {
  if (event.type !== expected.type) return false
  const left = event.payload
  const right = expected.payload
  if (left.toolUseId !== undefined) return left.toolUseId === right.toolUseId
  if (left.requestId !== undefined) return left.requestId === right.requestId && left.attempt === right.attempt &&
    (expected.type !== 'request_context' || left.projectionStage === right.projectionStage)
  if (left.turnId !== undefined) return left.turnId === right.turnId
  if (left.compactionId !== undefined) return left.compactionId === right.compactionId
  return false
}
