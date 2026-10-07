export type HistoryEvent = {
  eventId: string
  idempotencyKey: string
  invocationId: string
  turnId: string
  sequence: number
  schemaVersion: number
  kind: 'session-input-committed' | 'invocation-context-committed' | 'transcript-compacted' | 'model-request-started' | 'provider-retry-scheduled' | 'model-attempt-discarded' | 'model-response-committed' | 'replay-message-committed' | 'tool-call-started' | 'tool-call-finished' | 'tool-call-not-dispatched' | 'approval-waiting' | 'approval-resolved' | 'approval-updated' | 'invocation-parked' | 'invocation-interrupted' | 'invocation-completed' | 'invocation-failed'
  payload: unknown
}

export type HistorySnapshot = { invocationId: string; version: number; schemaVersion: number; events: HistoryEvent[] }
export type RebuiltInvocationState = { invocationId: string; state: 'interrupted' | 'completed' | 'failed' | 'denied' | 'cancelled'; lastEventId: string }
export type HistoryAppendResult = { version: number; duplicate: boolean }
export type InvocationHistoryAppendResult = HistoryAppendResult & { events: readonly HistoryEvent[] }
export type SessionTranscriptCommitIntent = Readonly<{
  sessionId: string
  baseVersion: number
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'
  messages: readonly Readonly<Record<string, unknown>>[]
  /** Atomic mirror into the authoritative desktop message skeleton, when this turn owns one. */
  messageMirror?: Readonly<{ messageId: string; status: 'completed' | 'failed' | 'cancelled'; content?: string }>
}>

export interface HistoryPort {
  appendBatch(events: readonly HistoryEvent[], expectedVersion: number, transcriptCommit?: SessionTranscriptCommitIntent): Promise<HistoryAppendResult>
  read(invocationId: string): Promise<HistorySnapshot>
}

/** Serializes concurrent event producers for one invocation into a contiguous append stream. */
export class InvocationHistoryWriter {
  private tail: Promise<void> = Promise.resolve()
  private version?: number

  get currentVersion(): number | undefined { return this.version }
  async currentOrPersistedVersion(): Promise<number> {
    await this.tail
    return this.version ?? (await this.history.read(this.identity.invocationId)).version
  }

  constructor(private readonly history: HistoryPort, private readonly identity: { invocationId: string; turnId: string; schemaVersion?: number }) {
    if (!identity.invocationId.trim() || !identity.turnId.trim()) throw new Error('history writer identity is required')
  }

  append(events: readonly Readonly<{ kind: HistoryEvent['kind']; payload: unknown }>[], transcriptCommit?: SessionTranscriptCommitIntent): Promise<InvocationHistoryAppendResult> {
    return this.enqueue(events, undefined, transcriptCommit)
  }

  /** SDK-internal replacement hook: version validation and append share the normal writer queue. */
  appendAtVersion(
    events: readonly Readonly<{ kind: HistoryEvent['kind']; payload: unknown }>[],
    expectedVersion: number,
    transcriptCommit?: SessionTranscriptCommitIntent,
    beforeAppend?: () => void
  ): Promise<InvocationHistoryAppendResult> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return Promise.reject(new HistoryBatchError('expected history version must be a non-negative integer'))
    return this.enqueue(events, expectedVersion, transcriptCommit, beforeAppend)
  }

  private enqueue(
    events: readonly Readonly<{ kind: HistoryEvent['kind']; payload: unknown }>[],
    requiredVersion: number | undefined,
    transcriptCommit?: SessionTranscriptCommitIntent,
    beforeAppend?: () => void
  ): Promise<InvocationHistoryAppendResult> {
    if (!events.length) return Promise.reject(new HistoryBatchError('history append must not be empty'))
    const operation = this.tail.then(async () => {
      const snapshot = await this.history.read(this.identity.invocationId)
      const writerVersion = this.version ?? snapshot.version
      if (requiredVersion !== undefined && writerVersion !== requiredVersion) throw new HistoryVersionConflict(requiredVersion, writerVersion)
      const expectedVersion = requiredVersion ?? writerVersion
      if (snapshot.version !== expectedVersion) throw new HistoryVersionConflict(expectedVersion, snapshot.version)
      beforeAppend?.()
      const batch = events.map(({ kind, payload }, index): HistoryEvent => {
        const sequence = expectedVersion + index + 1
        return {
          invocationId: this.identity.invocationId,
          turnId: this.identity.turnId,
          sequence,
          schemaVersion: this.identity.schemaVersion ?? snapshot.schemaVersion,
          eventId: `${this.identity.invocationId}:history:${sequence}`,
          idempotencyKey: `${this.identity.invocationId}:${kind}:${sequence}`,
          kind,
          payload
        }
      })
      const result = await this.history.appendBatch(batch, expectedVersion, transcriptCommit)
      this.version = result.version
      return { ...result, events: batch }
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

export class HistoryVersionConflict extends Error {
  readonly code = 'version-conflict'
  constructor(readonly expected: number, readonly actual: number) { super(`history version ${actual} does not match ${expected}`) }
}

export class HistorySequenceConflict extends Error {
  readonly code = 'sequence-conflict'
  constructor(readonly expected: number, readonly actual: number) { super(`history sequence ${actual} does not match ${expected}`) }
}

export class HistoryIdempotencyConflict extends Error {
  readonly code = 'idempotency-conflict'
  constructor(readonly idempotencyKey: string) { super(`history idempotency key conflicts with an existing event: ${idempotencyKey}`) }
}

export class HistoryBatchError extends Error {
  readonly code = 'invalid-history-batch'
  constructor(message: string) { super(message) }
}

export class HistoryCorruptionError extends Error {
  readonly code = 'history-corrupt'
  constructor(readonly invocationId: string, message: string) { super(`history stream ${invocationId} is corrupt: ${message}`) }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function firstNonCanonicalPath(value: unknown, path = 'payload', seen = new WeakSet<object>()): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : path
  if (typeof value !== 'object') return path
  if (seen.has(value)) return path
  seen.add(value)
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return path
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return path
      const keys = Reflect.ownKeys(value)
      if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return path
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return `${path}[${index}]`
        const invalid = firstNonCanonicalPath(descriptor.value, `${path}[${index}]`, seen)
        if (invalid) return invalid
      }
      seen.delete(value)
      return undefined
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return path
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return path
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return `${path}.${key}`
      const invalid = firstNonCanonicalPath(descriptor.value, `${path}.${key}`, seen)
      if (invalid) return invalid
    }
    seen.delete(value)
    return undefined
  } catch {
    return path
  }
}

export function historyEventsEqual(left: HistoryEvent, right: HistoryEvent): boolean {
  return stable(left) === stable(right)
}

const HISTORY_EVENT_KINDS = new Set<string>([
  'session-input-committed', 'invocation-context-committed', 'transcript-compacted',
  'model-request-started', 'provider-retry-scheduled', 'model-attempt-discarded',
  'model-response-committed', 'replay-message-committed', 'tool-call-started',
  'tool-call-finished', 'tool-call-not-dispatched', 'approval-waiting', 'approval-resolved',
  'approval-updated', 'invocation-parked', 'invocation-interrupted',
  'invocation-completed', 'invocation-failed'
])

export function validateHistoryBatch(events: readonly HistoryEvent[]): void {
  if (events.length === 0) throw new HistoryBatchError('history batch must not be empty')
  const first = events[0]
  const eventIds = new Set<string>()
  const idempotencyKeys = new Set<string>()
  for (const event of events) {
    if (!HISTORY_EVENT_KINDS.has(event.kind)) throw new HistoryBatchError(`unsupported history event kind ${String(event.kind)}`)
    if (!event.eventId.trim() || !event.idempotencyKey.trim() || !event.invocationId.trim() || !event.turnId.trim()) {
      throw new HistoryBatchError('history event identity fields are required')
    }
    if (event.invocationId !== first.invocationId || event.turnId !== first.turnId || event.schemaVersion !== first.schemaVersion) {
      throw new HistoryBatchError('a history batch must share invocation, turn, and schema version')
    }
    if (!Number.isInteger(event.sequence) || event.sequence <= 0 || !Number.isInteger(event.schemaVersion) || event.schemaVersion <= 0) {
      throw new HistoryBatchError('history sequence and schema version must be positive integers')
    }
    try {
      const invalidPath = firstNonCanonicalPath(event.payload)
      if (invalidPath) throw new Error(`payload contains a non-canonical value at ${invalidPath}`)
      const serializedPayload = JSON.stringify(event.payload)
      if (serializedPayload === undefined || stable(JSON.parse(serializedPayload)) !== stable(event.payload)) {
        throw new Error('payload does not round-trip as canonical JSON')
      }
    } catch {
      const path = firstNonCanonicalPath(event.payload)
      throw new HistoryBatchError(`history payload is not canonical JSON: ${event.eventId} (${path ?? 'non-canonical object'})`)
    }
    if (eventIds.has(event.eventId) || idempotencyKeys.has(event.idempotencyKey)) throw new HistoryBatchError('history batch contains duplicate identities')
    eventIds.add(event.eventId)
    idempotencyKeys.add(event.idempotencyKey)
  }
}

const TERMINAL_INVOCATION_EVENTS = new Set<HistoryEvent['kind']>([
  'invocation-parked', 'invocation-interrupted', 'invocation-completed', 'invocation-failed'
])

/** A persisted terminal or parked event closes an invocation stream permanently. */
export function validateHistoryTransition(previous: readonly HistoryEvent[], incoming: readonly HistoryEvent[]): void {
  const invocationTurnId = previous[0]?.turnId ?? incoming[0]?.turnId
  if (invocationTurnId && (previous.some((event) => event.turnId !== invocationTurnId) || incoming.some((event) => event.turnId !== invocationTurnId))) {
    throw new HistoryBatchError('an invocation history stream cannot change turn identity')
  }
  if (previous.some((event) => TERMINAL_INVOCATION_EVENTS.has(event.kind))) {
    throw new HistoryBatchError('cannot append after a terminal invocation event')
  }
  let terminalSeen = false
  const pendingToolCalls = new Set<string>()
  const pendingApprovals = new Set<string>()
  const approvalIdentityByPendingId = new Map<string, string>()
  const history = [...previous, ...incoming]
  for (const event of history) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as {
      status?: unknown; toolCallId?: unknown; approvalId?: unknown; approved?: unknown; outcome?: unknown; settledAt?: unknown; cause?: unknown
      answerer?: unknown; reasonCode?: unknown; requestedAt?: unknown; message?: { toolCalls?: readonly { id?: unknown }[] }
    } : undefined
    if (event.kind === 'invocation-completed' && payload?.status !== 'completed') {
      throw new HistoryBatchError('completed invocation terminal requires completed status')
    }
    if (event.kind === 'invocation-failed' && payload?.status !== 'failed' && payload?.status !== 'denied') {
      throw new HistoryBatchError('failed invocation terminal requires failed or denied status')
    }
    if (event.kind === 'invocation-interrupted' && payload?.status !== 'interrupted' && payload?.status !== 'cancelled') {
      throw new HistoryBatchError('interrupted invocation terminal requires interrupted or cancelled status')
    }
    if (event.kind === 'model-response-committed') {
      for (const call of payload?.message?.toolCalls ?? []) {
        if (typeof call.id === 'string' && call.id.trim()) pendingToolCalls.add(call.id)
      }
    }
    if (event.kind === 'tool-call-started' && typeof payload?.toolCallId === 'string' && payload.toolCallId.trim()) {
      pendingToolCalls.add(payload.toolCallId)
    }
    if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') && typeof payload?.toolCallId === 'string') {
      pendingToolCalls.delete(payload.toolCallId)
    }
    const approvalId = typeof payload?.toolCallId === 'string'
      ? payload.toolCallId
      : typeof payload?.approvalId === 'string' ? payload.approvalId : undefined
    if (event.kind === 'approval-waiting') {
      const pendingId = approvalId ?? event.eventId
      if (pendingApprovals.has(pendingId)) throw new HistoryBatchError(`approval is already pending: ${pendingId}`)
      const hasMetadata = ['answerer', 'reasonCode', 'requestedAt'].some((key) => key in (payload ?? {}))
      if (hasMetadata && (typeof payload?.approvalId !== 'string' || !payload.approvalId.trim() ||
        (payload.answerer !== 'user' && payload.answerer !== 'agent') || typeof payload.reasonCode !== 'string' || !payload.reasonCode.trim() ||
        typeof payload.requestedAt !== 'number' || !Number.isFinite(payload.requestedAt))) {
        throw new HistoryBatchError(`approval waiting metadata is invalid: ${pendingId}`)
      }
      pendingApprovals.add(pendingId)
      if (hasMetadata && typeof payload?.approvalId === 'string') approvalIdentityByPendingId.set(pendingId, payload.approvalId)
    }
    if (event.kind === 'approval-resolved') {
      if (typeof payload?.approved !== 'boolean') throw new HistoryBatchError('approval resolution requires an approved boolean')
      if (payload.outcome !== undefined) {
        const outcomes = ['approved', 'denied', 'timeout', 'unavailable', 'cancelled']
        if (typeof payload.outcome !== 'string' || !outcomes.includes(payload.outcome) || payload.approved !== (payload.outcome === 'approved')) {
          throw new HistoryBatchError('approval outcome conflicts with approved boolean')
        }
        if (payload.settledAt !== undefined && (typeof payload.settledAt !== 'number' || !Number.isFinite(payload.settledAt))) {
          throw new HistoryBatchError('approval resolution settledAt is invalid')
        }
      }
      if (payload.answerer !== undefined && payload.answerer !== 'user' && payload.answerer !== 'agent') {
        throw new HistoryBatchError('approval resolution answerer is invalid')
      }
      if (payload.cause !== undefined && (typeof payload.cause !== 'string' || !payload.cause.trim())) {
        throw new HistoryBatchError('approval resolution cause is invalid')
      }
      if (!approvalId || !pendingApprovals.has(approvalId)) throw new HistoryBatchError(`approval is not pending: ${approvalId ?? event.eventId}`)
      const expectedApprovalId = approvalIdentityByPendingId.get(approvalId)
      if (expectedApprovalId && payload.approvalId !== expectedApprovalId) throw new HistoryBatchError(`approval resolution identity mismatch: ${approvalId}`)
      pendingApprovals.delete(approvalId)
      approvalIdentityByPendingId.delete(approvalId)
    }
    if ((event.kind === 'invocation-completed' || event.kind === 'invocation-failed') && (pendingToolCalls.size > 0 || pendingApprovals.size > 0)) {
      throw new HistoryBatchError('cannot terminally settle an invocation with pending tool calls or approvals')
    }
  }
  for (const event of incoming) {
    if (terminalSeen) throw new HistoryBatchError('terminal invocation event must be the final event in its batch')
    if (TERMINAL_INVOCATION_EVENTS.has(event.kind)) terminalSeen = true
  }
}

/** Parked or in-flight work is never resumed as executable after a process restart. */
export function rebuildInvocationStates(snapshot: HistorySnapshot): Map<string, RebuiltInvocationState> {
  let state: RebuiltInvocationState | undefined
  let openInvocationEventId: string | undefined
  const pendingToolCalls = new Map<string, string>()
  const pendingApprovals = new Map<string, string>()
  for (const event of snapshot.events) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as {
      status?: unknown; toolCallId?: unknown; approvalId?: unknown; message?: { toolCalls?: readonly { id?: unknown }[] }
    } : undefined
    if (event.kind === 'model-response-committed') {
      openInvocationEventId = event.eventId
      for (const toolCall of payload?.message?.toolCalls ?? []) {
        if (typeof toolCall.id === 'string' && toolCall.id.trim()) pendingToolCalls.set(toolCall.id, event.eventId)
      }
    }
    if (event.kind === 'session-input-committed' || event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted' || event.kind === 'model-request-started' || event.kind === 'replay-message-committed') openInvocationEventId = event.eventId
    if (event.kind === 'model-attempt-discarded') openInvocationEventId = event.eventId
    const approvalId = typeof payload?.toolCallId === 'string'
      ? payload.toolCallId
      : typeof payload?.approvalId === 'string' ? payload.approvalId : undefined
    if (event.kind === 'tool-call-started' && typeof payload?.toolCallId === 'string') pendingToolCalls.set(payload.toolCallId, event.eventId)
    if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') && typeof payload?.toolCallId === 'string') pendingToolCalls.delete(payload.toolCallId)
    if (event.kind === 'approval-waiting') pendingApprovals.set(approvalId ?? event.eventId, event.eventId)
    if (event.kind === 'approval-resolved' && approvalId) pendingApprovals.delete(approvalId)
    if (event.kind === 'invocation-parked' || event.kind === 'invocation-interrupted') {
      const terminal = event.kind === 'invocation-interrupted' && payload?.status === 'cancelled' ? 'cancelled' : 'interrupted'
      state = { invocationId: snapshot.invocationId, state: terminal, lastEventId: event.eventId }
      openInvocationEventId = undefined
    } else if (event.kind === 'invocation-completed') state = { invocationId: snapshot.invocationId, state: 'completed', lastEventId: event.eventId }
    else if (event.kind === 'invocation-failed') {
      const terminal = payload?.status === 'denied' ? 'denied' : 'failed'
      state = { invocationId: snapshot.invocationId, state: terminal, lastEventId: event.eventId }
    }
    if (event.kind === 'invocation-completed' || event.kind === 'invocation-failed') openInvocationEventId = undefined
  }
  if (state && state.state !== 'interrupted' && pendingToolCalls.size === 0 && pendingApprovals.size === 0) {
    return new Map([[snapshot.invocationId, state]])
  }
  const pendingApprovalEventId = [...pendingApprovals.values()].at(-1)
  if (pendingApprovalEventId) state = { invocationId: snapshot.invocationId, state: 'interrupted', lastEventId: pendingApprovalEventId }
  const unknownDispatch = [...pendingToolCalls.values()].at(-1)
  if (unknownDispatch) state = { invocationId: snapshot.invocationId, state: 'interrupted', lastEventId: unknownDispatch }
  if (openInvocationEventId) state = { invocationId: snapshot.invocationId, state: 'interrupted', lastEventId: openInvocationEventId }
  return state ? new Map([[snapshot.invocationId, state]]) : new Map()
}

/** Host-neutral reference implementation; writes each batch atomically after full validation. */
export class MemoryHistory implements HistoryPort {
  private readonly streams = new Map<string, { schemaVersion: number; events: HistoryEvent[] }>()

  constructor(private readonly schemaVersion = 1) {}

  async appendBatch(events: readonly HistoryEvent[], expectedVersion: number): Promise<HistoryAppendResult> {
    validateHistoryBatch(events)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new HistoryBatchError('expectedVersion must be a non-negative integer')
    const invocationId = events[0].invocationId
    const stream = this.streams.get(invocationId) ?? { schemaVersion: this.schemaVersion, events: [] }
    if (events.some((event) => event.schemaVersion !== stream.schemaVersion)) throw new HistoryBatchError(`unsupported history schema version: ${events[0].schemaVersion}`)

    const duplicates = events.map((event) => stream.events.find((previous) => previous.idempotencyKey === event.idempotencyKey || previous.eventId === event.eventId))
    if (duplicates.some(Boolean)) {
      if (!duplicates.every((previous, index) => previous && historyEventsEqual(previous, events[index]))) {
        throw new HistoryIdempotencyConflict(events.find((event, index) => duplicates[index] && !historyEventsEqual(duplicates[index]!, event))?.idempotencyKey ?? events[0].idempotencyKey)
      }
      return { version: stream.events.length, duplicate: true }
    }

    if (expectedVersion !== stream.events.length) throw new HistoryVersionConflict(expectedVersion, stream.events.length)
    const eventIds = new Set(stream.events.map((event) => event.eventId))
    if (events.some((event) => eventIds.has(event.eventId))) throw new HistoryIdempotencyConflict(events.find((event) => eventIds.has(event.eventId))!.eventId)
    for (let index = 0; index < events.length; index += 1) {
      const expectedSequence = expectedVersion + index + 1
      if (events[index].sequence !== expectedSequence) throw new HistorySequenceConflict(expectedSequence, events[index].sequence)
    }
    validateHistoryTransition(stream.events, events)
    stream.events.push(...structuredClone(events))
    this.streams.set(invocationId, stream)
    return { version: stream.events.length, duplicate: false }
  }

  async read(invocationId: string): Promise<HistorySnapshot> {
    const stream = this.streams.get(invocationId) ?? { schemaVersion: this.schemaVersion, events: [] }
    return { invocationId, version: stream.events.length, schemaVersion: stream.schemaVersion, events: structuredClone(stream.events) }
  }
}
