export type HistoryEvent = { eventId: string; kind: 'approval-updated' | 'invocation-parked' | 'invocation-interrupted'; payload: unknown }
export type HistorySnapshot = { version: number; events: HistoryEvent[] }
export type RebuiltInvocationState = { invocationId: string; state: 'parked' | 'interrupted'; lastEventId: string }

function invocationIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = (payload as { invocationId?: unknown }).invocationId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Restart boundary: a parked invocation is never resumed automatically as an executable turn. */
export function rebuildInvocationStates(snapshot: HistorySnapshot): Map<string, RebuiltInvocationState> {
  const states = new Map<string, RebuiltInvocationState>()
  for (const event of snapshot.events) {
    const invocationId = invocationIdFromPayload(event.payload)
    if (!invocationId) continue
    if (event.kind === 'invocation-parked') {
      states.set(invocationId, { invocationId, state: 'interrupted', lastEventId: event.eventId })
    } else if (event.kind === 'invocation-interrupted') {
      states.set(invocationId, { invocationId, state: 'interrupted', lastEventId: event.eventId })
    }
  }
  return states
}

export interface HistoryPort {
  append(event: HistoryEvent, expectedVersion: number): Promise<{ version: number; duplicate: boolean }>
  read(): Promise<HistorySnapshot>
}

export class HistoryVersionConflict extends Error {
  readonly code = 'version-conflict'
  constructor(readonly expected: number, readonly actual: number) { super(`history version ${actual} does not match ${expected}`) }
}

/** Host-neutral History Port implementation used by SDK sequencing tests and adapters. */
export class MemoryHistory implements HistoryPort {
  private version = 0
  private readonly events: HistoryEvent[] = []

  async append(event: HistoryEvent, expectedVersion: number): Promise<{ version: number; duplicate: boolean }> {
    const previous = this.events.find((item) => item.eventId === event.eventId)
    if (previous) return { version: this.version, duplicate: true }
    if (expectedVersion !== this.version) throw new HistoryVersionConflict(expectedVersion, this.version)
    this.events.push(structuredClone(event))
    this.version += 1
    return { version: this.version, duplicate: false }
  }

  async read(): Promise<HistorySnapshot> {
    return { version: this.version, events: structuredClone(this.events) }
  }
}
