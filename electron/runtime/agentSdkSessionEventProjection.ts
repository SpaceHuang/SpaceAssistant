import { stripPartialJsonForPersist, type CommittedEvent, type SessionEventInput, type SessionEventSink } from '../sessionEvents'

/** Projects SDK observer events to the desktop JSONL ledger, keeping critical append failures visible. */
export function createAgentSdkSessionEventProjector(input: {
  turnId: string
  eventWriter?: SessionEventSink
  failClosedCriticalEvents?: boolean
  onCommitted?(event: CommittedEvent): void
  onChunkDropped?(): void
  onCriticalFailure?(error: unknown): void
}): (event: SessionEventInput) => Promise<void> {
  return async (event) => {
    const writer = input.eventWriter
    if (!writer) return
    const stripped = stripPartialJsonForPersist(event)
    const normalized = { ...stripped, payload: { ...stripped.payload, turnId: input.turnId } }
    if (event.type === 'assistant_chunk') {
      try {
        await writer.waitForCapacity()
        writer.appendChunk(normalized)
      } catch {
        input.onChunkDropped?.()
      }
      return
    }
    try {
      const committed = await writer.appendCritical(normalized)
      input.onCommitted?.(committed)
    } catch (error) {
      input.onCriticalFailure?.(error)
      if (input.failClosedCriticalEvents) throw error
    }
  }
}
