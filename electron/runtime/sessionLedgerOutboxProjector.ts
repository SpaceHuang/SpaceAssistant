import { ensureToolResultEvent, type SessionEventInput, type SessionEventSink } from '../sessionEvents'
import type { CanonicalLedgerProjectionTarget } from '../sessionLedgerOutbox'

/** Applies a canonical outbox target through the existing idempotent ledger projection primitive. */
export async function projectCanonicalSessionLedgerTarget(
  sink: SessionEventSink,
  target: CanonicalLedgerProjectionTarget
): Promise<{ eventIds: readonly string[]; events: readonly SessionEventInput[] }> {
  if (target.projectionKind !== 'tool-result' || target.expectedEvents.length !== 1 || target.expectedEvents[0].type !== 'tool_result') {
    throw new Error('SESSION_LEDGER_PROJECTION_KIND_UNSUPPORTED')
  }
  const expected = target.expectedEvents[0]
  const committed = await ensureToolResultEvent(sink, expected.payload as unknown as Parameters<typeof ensureToolResultEvent>[1])
  if (!committed) throw new Error('SESSION_LEDGER_PROJECTION_EVENT_NOT_COMMITTED')
  return {
    eventIds: [`tool_result:${String(expected.payload.toolUseId)}`],
    events: [{ type: committed.type, payload: committed.payload }]
  }
}
