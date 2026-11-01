import type { CanonicalModelMessage, CanonicalToolCall } from './model'
import type { HistoryEvent, HistorySnapshot } from './history'

export type ContextOutcome = Readonly<{ kind: 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'park' }>
export type ContextSelection = Readonly<{ target: 'working' | 'failure' | 'park-baseline'; messages: readonly CanonicalModelMessage[] }>
export type ContextSelectionIntent = Readonly<{ contextProtocol: 2; target: ContextSelection['target'] }>
export type ContextScope = Readonly<{ kind: 'session'; sessionId: string } | { kind: 'track'; sessionId: string; trackId: string; inputRange?: string }>
export type SessionContextEvent =
  | Readonly<{ kind: 'model-response-committed'; message: CanonicalModelMessage }>
  | Readonly<{ kind: 'replay-message-committed'; message: CanonicalModelMessage }>
  | Readonly<{ kind: 'tool-call-started'; toolCall: CanonicalToolCall }>
  | Readonly<{ kind: 'tool-call-finished'; toolCallId: string; message: Extract<CanonicalModelMessage, { role: 'tool' }> }>
  | Readonly<{ kind: 'approval-resolved'; toolCallId: string; approved: boolean }>
  | Readonly<{ kind: 'transcript-compacted'; messages: readonly CanonicalModelMessage[]; requiredUserMessageId?: string; failureCut?: number }>

export type SessionContextState = Readonly<{
  committedVersion: number
  committed: readonly CanonicalModelMessage[]
  working: readonly CanonicalModelMessage[]
  failure: readonly CanonicalModelMessage[] | null
  parkBaseline: readonly CanonicalModelMessage[]
  pendingTools: ReadonlyMap<string, CanonicalToolCall>
  completedToolResults: ReadonlyMap<string, Extract<CanonicalModelMessage, { role: 'tool' }>>
  approvedToolCallIds: ReadonlySet<string>
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  requestSystem: string
  activeInvocationId?: string
  scope?: ContextScope
}>
type ContextReplayEvent = Readonly<Pick<HistoryEvent, 'kind' | 'payload'> & Partial<Pick<HistoryEvent,
  'invocationId' | 'sequence' | 'eventId' | 'idempotencyKey' | 'turnId' | 'schemaVersion'>>>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

const ownMessage = (message: CanonicalModelMessage): CanonicalModelMessage => deepFreeze(structuredClone(message))
const ownMessages = (messages: readonly CanonicalModelMessage[]): readonly CanonicalModelMessage[] =>
  Object.freeze(messages.map(ownMessage))
const freezeMessages = (messages: readonly CanonicalModelMessage[]): readonly CanonicalModelMessage[] =>
  Object.isFrozen(messages) ? messages : Object.freeze(messages)
export const SESSION_CONTEXT_NEUTRAL_HISTORY_KINDS = [
  'model-request-started', 'provider-retry-scheduled', 'provider-attempt-result', 'model-attempt-discarded'
] as const satisfies readonly HistoryEvent['kind'][]
const contextNeutralObservationKinds: ReadonlySet<string> = new Set(SESSION_CONTEXT_NEUTRAL_HISTORY_KINDS)
const simpleCompletedHistoryKinds: ReadonlySet<string> = new Set([
  'session-input-committed', 'invocation-context-committed', 'model-response-committed', 'invocation-completed', ...SESSION_CONTEXT_NEUTRAL_HISTORY_KINDS
])
const contextTerminalKinds: ReadonlySet<string> = new Set(['invocation-completed', 'invocation-parked', 'invocation-failed', 'invocation-interrupted'])

const ownedReadonlyMaps = new WeakSet<object>()
const ownedReadonlySets = new WeakSet<object>()

function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  if (ownedReadonlyMaps.has(source as object)) return source
  const map = new Map(source)
  const view = {
    get size() { return map.size },
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => map.forEach((value, key) => callback.call(thisArg, value, key, view)),
    [Symbol.iterator]: () => map[Symbol.iterator]()
  }
  Object.freeze(view)
  ownedReadonlyMaps.add(view)
  return view as ReadonlyMap<K, V>
}

function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  if (ownedReadonlySets.has(source as object)) return source
  const set = new Set(source)
  const view = {
    get size() { return set.size },
    has: (value: T) => set.has(value),
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    forEach: (callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => set.forEach((value) => callback.call(thisArg, value, value, view)),
    [Symbol.iterator]: () => set[Symbol.iterator]()
  }
  Object.freeze(view)
  ownedReadonlySets.add(view)
  return view as ReadonlySet<T>
}

const freezeState = (state: SessionContextState): SessionContextState => Object.freeze({
  ...state,
  committed: freezeMessages(state.committed),
  working: freezeMessages(state.working),
  failure: state.failure === null ? null : freezeMessages(state.failure),
  parkBaseline: freezeMessages(state.parkBaseline),
  pendingTools: readonlyMap(state.pendingTools),
  completedToolResults: readonlyMap(state.completedToolResults),
  approvedToolCallIds: readonlySet(state.approvedToolCallIds),
  ...(state.requiredUserMessage ? { requiredUserMessage: state.requiredUserMessage } : {})
})

/** Convert the legacy full-context events into one canonical state for both recovery and live turns. */
export function restoreSessionContext(input: Readonly<{ committedVersion: number; events: readonly ContextReplayEvent[] | HistorySnapshot['events'] }>): SessionContextState {
  return restoreSessionContextWithOwnership(input, false)
}

/** Restore detached database-decoded events without cloning their message payloads. */
export function restoreSessionContextFromOwnedEvents(input: Readonly<{ committedVersion: number; events: readonly ContextReplayEvent[] | HistorySnapshot['events'] }>): SessionContextState {
  return restoreSessionContextWithOwnership(input, true)
}

function restoreSessionContextWithOwnership(
  input: Readonly<{ committedVersion: number; events: readonly ContextReplayEvent[] | HistorySnapshot['events'] }>,
  eventsAreOwned: boolean
): SessionContextState {
  // On large histories, cheaply identify mixed event kinds before validating the
  // simple path's payloads. Mixed histories are reduced in segments below, so
  // validating every old simple-turn payload here would only repeat that work.
  const hasMixedHistoryKinds = input.events.length > 1000 && input.events.some((event) => !simpleCompletedHistoryKinds.has(event.kind))
  const simpleRestored = hasMixedHistoryKinds ? undefined
    : restoreSimpleCompletedSessionContext(input, undefined, eventsAreOwned)
  if (simpleRestored) return simpleRestored
  let state = freezeState({ committedVersion: input.committedVersion, committed: [], working: [], failure: [], parkBaseline: [], pendingTools: new Map(), completedToolResults: new Map(), approvedToolCallIds: new Set(), requestSystem: '' })
  let simpleRun: ContextReplayEvent[] = []
  let currentTurn: ContextReplayEvent[] = []
  let currentTurnIsSimple = true
  const flushSimpleRun = () => {
    if (!simpleRun.length) return
    state = restoreSimpleCompletedSessionContext({ committedVersion: input.committedVersion, events: simpleRun }, state, eventsAreOwned)
      ?? restoreSessionContextGeneric({ committedVersion: input.committedVersion, events: simpleRun }, state)
    simpleRun = []
  }
  for (const event of input.events) {
    currentTurn.push(event)
    if (!simpleCompletedHistoryKinds.has(event.kind)) currentTurnIsSimple = false
    if (event.kind === 'model-response-committed') {
      const message = (event.payload as { message?: CanonicalModelMessage } | undefined)?.message
      if (!message || message.role !== 'assistant' || message.toolCalls?.length) currentTurnIsSimple = false
    }
    if (event.kind === 'invocation-completed') {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as { status?: unknown; contextSelection?: unknown } : undefined
      const selection = payload?.contextSelection as { contextProtocol?: unknown; target?: unknown } | undefined
      if (payload?.status !== 'completed' || (selection && (selection.contextProtocol !== 2 || selection.target !== 'working'))) currentTurnIsSimple = false
    }
    if (!contextTerminalKinds.has(event.kind)) continue
    if (currentTurnIsSimple) simpleRun.push(...currentTurn)
    else {
      flushSimpleRun()
      state = restoreSessionContextGeneric({ committedVersion: input.committedVersion, events: currentTurn }, state)
    }
    currentTurn = []
    currentTurnIsSimple = true
  }
  if (currentTurn.length) {
    flushSimpleRun()
    state = restoreSessionContextGeneric({ committedVersion: input.committedVersion, events: currentTurn }, state)
  }
  flushSimpleRun()
  return freezeState({ ...state, committedVersion: input.committedVersion })
}

function restoreSessionContextGeneric(
  input: Readonly<{ committedVersion: number; events: readonly ContextReplayEvent[] | HistorySnapshot['events'] }>,
  initialState?: SessionContextState
): SessionContextState {
  let state = initialState ?? freezeState({ committedVersion: input.committedVersion, committed: [], working: [], failure: [], parkBaseline: [], pendingTools: new Map(), completedToolResults: new Map(), approvedToolCallIds: new Set(), requestSystem: '' })
  for (const event of input.events) {
    if (event.kind === 'session-input-committed') {
      const payload = event.payload as { messages?: unknown; system?: unknown; scope?: unknown }
      if (Array.isArray(payload?.messages)) state = replaceCommitted(state, ownMessages(payload.messages as CanonicalModelMessage[]))
      if (payload?.scope && typeof payload.scope === 'object') state = freezeState({ ...state, scope: deepFreeze(structuredClone(payload.scope as ContextScope)) })
      if (typeof payload?.system === 'string') state = freezeState({ ...state, requestSystem: payload.system })
    } else if (event.kind === 'invocation-context-committed') {
      const payload = event.payload as { contextProtocol?: unknown; baseVersion?: unknown; inputMode?: unknown; inputMessages?: unknown; failureInputMessages?: unknown; scope?: unknown; messages?: unknown; replacement?: unknown; invocationId?: unknown; requiredUserMessage?: unknown; system?: unknown }
      if (payload?.contextProtocol !== undefined && payload.contextProtocol !== 2) throw new Error('CONTEXT_PROTOCOL_UNKNOWN')
      if (payload?.contextProtocol === 2 && payload.inputMessages !== undefined) {
        if (!Array.isArray(payload.inputMessages) || !Array.isArray(payload.failureInputMessages) || !payload.scope || typeof payload.scope !== 'object') throw new Error('CONTEXT_INPUT_INVALID')
        const scope = payload.scope as ContextScope
        if (state.scope && JSON.stringify(state.scope) !== JSON.stringify(scope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
        const explicitMode = payload.inputMode
        if (explicitMode !== undefined && explicitMode !== 'baseline' && explicitMode !== 'delta') throw new Error('CONTEXT_INPUT_MODE_INVALID')
        // Protocol 2 entries written before inputMode stored the complete request in both
        // fields (and also carried `messages`). Preserve that historical snapshot meaning.
        const inputMode = explicitMode ?? (Array.isArray(payload.messages) ? 'baseline' : 'delta')
        const additions = ownMessages((inputMode === 'baseline' && Array.isArray(payload.messages)
          ? payload.messages : payload.inputMessages) as CanonicalModelMessage[])
        const failureAdditions = ownMessages(payload.failureInputMessages as CanonicalModelMessage[])
        const failureMessages = failureAdditions.length
          ? inputMode === 'baseline' ? failureAdditions : [...state.committed, ...failureAdditions]
          : state.failure
        const parkBaseline = failureAdditions.length
          ? inputMode === 'baseline' ? failureAdditions : [...state.committed, ...failureAdditions]
          : state.parkBaseline
        state = freezeState({ ...state,
          working: inputMode === 'baseline' ? additions : [...state.committed, ...additions],
          failure: failureMessages,
          parkBaseline,
          scope: deepFreeze(structuredClone(scope)),
          ...(typeof payload.invocationId === 'string' ? { activeInvocationId: payload.invocationId } : {}),
          ...(payload.requiredUserMessage && typeof payload.requiredUserMessage === 'object' ? { requiredUserMessage: deepFreeze(structuredClone(payload.requiredUserMessage as { id: string; message: CanonicalModelMessage })) } : {}),
          ...(typeof payload.system === 'string' ? { requestSystem: payload.system } : {}) })
        continue
      }
      const replacement = payload?.replacement && typeof payload.replacement === 'object' ? payload.replacement as { reason?: unknown; messages?: unknown } : undefined
      if (replacement && replacement.reason !== 'initial-scope' && replacement.reason !== 'manual-review') throw new Error('CONTEXT_REPLACEMENT_REASON_UNKNOWN')
      if (replacement && !Array.isArray(replacement.messages)) throw new Error('CONTEXT_REPLACEMENT_MESSAGES_INVALID')
      const replacementMessages = replacement?.messages
      if (Array.isArray(payload?.messages) || replacementMessages) {
        const messages = ownMessages((replacementMessages ?? payload.messages) as CanonicalModelMessage[])
        if (replacementMessages) {
          state = replaceCommitted(state, messages)
          continue
        }
        state = freezeState({ ...state, working: messages, failure: messages, parkBaseline: messages,
          ...(typeof payload.invocationId === 'string' ? { activeInvocationId: payload.invocationId } : {}),
          ...(payload.requiredUserMessage && typeof payload.requiredUserMessage === 'object' ? { requiredUserMessage: deepFreeze(structuredClone(payload.requiredUserMessage as { id: string; message: CanonicalModelMessage })) } : {}),
          ...(typeof payload.system === 'string' ? { requestSystem: payload.system } : {}) })
      }
    } else if (event.kind === 'transcript-compacted') {
      const payload = event.payload as { contextProtocol?: unknown; messages?: unknown; failureCut?: unknown }
      if (payload?.contextProtocol !== undefined && payload.contextProtocol !== 2) throw new Error('CONTEXT_PROTOCOL_UNKNOWN')
      if (Array.isArray(payload?.messages)) {
        const messages = ownMessages(payload.messages as CanonicalModelMessage[])
        state = applyContextEvent(state, { kind: 'transcript-compacted', messages, ...(Number.isInteger(payload.failureCut) ? { failureCut: Number(payload.failureCut) } : {}) })
      }
    } else if (event.kind === 'model-response-committed' || event.kind === 'replay-message-committed') {
      const payload = event.payload as { message?: unknown }
      if (payload?.message && typeof payload.message === 'object') {
        const message = payload.message as CanonicalModelMessage
        if (event.kind === 'replay-message-committed' && message.role === 'tool') {
          state = applyContextEvent(state, { kind: 'tool-call-finished', toolCallId: message.toolCallId, message })
        } else {
          state = applyContextEvent(state, { kind: event.kind, message })
        }
      }
    } else if (event.kind === 'tool-call-started') {
      const payload = event.payload as { toolCall?: unknown }
      if (payload?.toolCall && typeof payload.toolCall === 'object') state = applyContextEvent(state, { kind: 'tool-call-started', toolCall: payload.toolCall as CanonicalToolCall })
    } else if (event.kind === 'tool-call-finished') {
      const payload = event.payload as { toolCallId?: unknown; message?: unknown; replayContent?: unknown; result?: unknown; isError?: unknown }
      const result = payload.message && typeof payload.message === 'object'
        ? payload.message as Extract<CanonicalModelMessage, { role: 'tool' }>
        : typeof payload.toolCallId === 'string' && (payload.replayContent !== undefined || payload.result !== undefined)
          ? { role: 'tool' as const, toolCallId: payload.toolCallId, content: payload.replayContent ?? payload.result, isError: payload.isError === true }
          : undefined
      if (typeof payload.toolCallId === 'string' && result) {
        state = applyContextEvent(state, { kind: 'tool-call-finished', toolCallId: payload.toolCallId, message: result })
        if (state.approvedToolCallIds.has(payload.toolCallId)) state = applyContextEvent(state, { kind: 'model-response-committed', message: createApprovalSystemMessage() })
      }
    } else if (event.kind === 'approval-resolved') {
      const payload = event.payload as { toolCallId?: unknown; approved?: unknown; answerer?: unknown }
      if (typeof payload.toolCallId === 'string' && payload.approved === true && payload.answerer === 'user') state = applyContextEvent(state, { kind: 'approval-resolved', toolCallId: payload.toolCallId, approved: true })
    } else if (event.kind === 'invocation-completed' || event.kind === 'invocation-parked' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted') {
      const target = event.kind === 'invocation-completed' ? 'working' : event.kind === 'invocation-parked' ? 'park-baseline' : 'failure'
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as { contextSelection?: unknown } : undefined
      if (payload?.contextSelection && typeof payload.contextSelection === 'object') {
        const selection = payload.contextSelection as { contextProtocol?: unknown; target?: unknown }
        if (selection.contextProtocol !== 2 || selection.target !== target) throw new Error('CONTEXT_TERMINAL_SELECTION_MISMATCH')
      }
      const selection = selectContextCommit(state, { kind: target === 'working' ? 'completed' : target === 'park-baseline' ? 'park' : 'failed' })
      state = replaceCommitted(state, selection.messages)
    }
  }
  return freezeState({ ...state, committedVersion: input.committedVersion })
}

/** Fast path for ordinary completed turns: append to one private buffer, freeze only the final result. */
function restoreSimpleCompletedSessionContext(
  input: Readonly<{ committedVersion: number; events: readonly ContextReplayEvent[] | HistorySnapshot['events'] }>,
  initialState?: SessionContextState,
  eventsAreOwned = false
): SessionContextState | undefined {
  const events = input.events
  if (events.length === 0 || events.at(-1)?.kind !== 'invocation-completed') return undefined
  let scopeKey: string | undefined = initialState?.scope ? JSON.stringify(initialState.scope) : undefined
  for (const event of events) {
    if (event.kind !== 'session-input-committed' && event.kind !== 'invocation-context-committed' &&
      event.kind !== 'model-response-committed' && event.kind !== 'invocation-completed' && !contextNeutralObservationKinds.has(event.kind)) return undefined
    if (event.kind === 'invocation-completed') {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as { status?: unknown; contextSelection?: unknown } : undefined
      const selection = payload?.contextSelection as { contextProtocol?: unknown; target?: unknown } | undefined
      if (payload?.status !== 'completed' || (selection && (selection.contextProtocol !== 2 || selection.target !== 'working'))) return undefined
    }
    if (event.kind === 'model-response-committed') {
      const message = (event.payload as { message?: CanonicalModelMessage } | undefined)?.message
      if (!message || message.role !== 'assistant' || message.toolCalls?.length) return undefined
    }
    if (event.kind === 'invocation-context-committed') {
      const payload = event.payload as { contextProtocol?: unknown; inputMode?: unknown; inputMessages?: unknown; failureInputMessages?: unknown; messages?: unknown; scope?: unknown }
      if (payload?.contextProtocol !== 2 || !Array.isArray(payload.inputMessages) || !Array.isArray(payload.failureInputMessages) ||
        !payload.scope || typeof payload.scope !== 'object' || JSON.stringify(payload.inputMessages) !== JSON.stringify(payload.failureInputMessages) ||
        (payload.inputMode !== undefined && payload.inputMode !== 'delta' && payload.inputMode !== 'baseline') ||
        (payload.inputMode === 'baseline' && !Array.isArray(payload.messages))) return undefined
      const nextScopeKey = JSON.stringify(payload.scope)
      if (scopeKey !== undefined && scopeKey !== nextScopeKey) return undefined
      scopeKey = nextScopeKey
    }
    if (event.kind === 'session-input-committed') {
      const payload = event.payload as { scope?: unknown } | undefined
      if (payload?.scope && typeof payload.scope === 'object') scopeKey = JSON.stringify(payload.scope)
    }
  }

  const buffer: CanonicalModelMessage[] = [...(initialState?.committed ?? [])]
  let hasSystemMessage = buffer.some((message) => message.role === 'system')
  let scope: ContextScope | undefined = initialState?.scope
  let requestSystem = initialState?.requestSystem ?? ''
  let activeInvocationId: string | undefined = initialState?.activeInvocationId
  let requiredUserMessage: SessionContextState['requiredUserMessage'] = initialState?.requiredUserMessage
  for (const event of events) {
    if (event.kind === 'session-input-committed') {
      const payload = event.payload as { messages?: unknown; scope?: unknown; system?: unknown }
      if (Array.isArray(payload.messages)) {
        buffer.length = 0
        const owned = ownMessages(payload.messages as CanonicalModelMessage[])
        buffer.push(...owned)
        hasSystemMessage = owned.some((message) => message.role === 'system')
        activeInvocationId = undefined
        requiredUserMessage = undefined
        requestSystem = ''
      }
      if (payload.scope && typeof payload.scope === 'object') scope = deepFreeze(structuredClone(payload.scope as ContextScope))
      if (typeof payload.system === 'string') requestSystem = payload.system
    } else if (event.kind === 'invocation-context-committed') {
      const payload = event.payload as { inputMode?: 'delta' | 'baseline'; inputMessages: CanonicalModelMessage[]; messages?: CanonicalModelMessage[]; scope: ContextScope; invocationId?: string; requiredUserMessage?: { id: string; message: CanonicalModelMessage }; system?: string }
      const mode = payload.inputMode ?? (Array.isArray(payload.messages) ? 'baseline' : 'delta')
      const additions = ownMessages(mode === 'baseline' && Array.isArray(payload.messages) ? payload.messages : payload.inputMessages)
      if (mode === 'baseline') { buffer.length = 0; hasSystemMessage = false }
      buffer.push(...additions)
      hasSystemMessage ||= additions.some((message) => message.role === 'system')
      scope = scope ? scope : deepFreeze(structuredClone(payload.scope))
      if (payload.invocationId) activeInvocationId = payload.invocationId
      if (payload.requiredUserMessage) requiredUserMessage = deepFreeze(structuredClone(payload.requiredUserMessage))
      if (typeof payload.system === 'string') requestSystem = payload.system
    } else if (event.kind === 'model-response-committed') {
      const message = (event.payload as { message: CanonicalModelMessage }).message
      buffer.push(eventsAreOwned ? deepFreeze(message) : ownMessage(message))
    } else if (event.kind === 'invocation-completed') {
      if (hasSystemMessage) {
        for (let index = buffer.length - 1; index >= 0; index -= 1) if (buffer[index]?.role === 'system') buffer.splice(index, 1)
        hasSystemMessage = false
      }
      activeInvocationId = undefined
      requiredUserMessage = undefined
      requestSystem = ''
    }
  }
  const messages = Object.freeze(buffer)
  return Object.freeze({ committedVersion: input.committedVersion, committed: messages, working: messages, failure: messages,
    parkBaseline: messages, pendingTools: readonlyMap(new Map<string, CanonicalToolCall>()), completedToolResults: readonlyMap(new Map<string, Extract<CanonicalModelMessage, { role: 'tool' }>>()), approvedToolCallIds: readonlySet(new Set<string>()),
    ...(requiredUserMessage ? { requiredUserMessage } : {}), requestSystem, ...(activeInvocationId ? { activeInvocationId } : {}), ...(scope ? { scope } : {}) })
}

/** One-way adapter for legacy transcript snapshots; all later changes use the shared event reducer. */
export function restoreLegacySessionContextSnapshot(input: Readonly<{
  invocationId: string; turnId: string; committedVersion: number; messages: readonly CanonicalModelMessage[]; scope?: ContextScope
}>): SessionContextState {
  return restoreSessionContext({ committedVersion: input.committedVersion, events: [{
    invocationId: input.invocationId, turnId: input.turnId, sequence: 1, schemaVersion: 1,
    eventId: `legacy-transcript-seed:${input.committedVersion}`, idempotencyKey: `legacy-transcript-seed:${input.committedVersion}`,
    kind: 'session-input-committed', payload: { messages: input.messages, ...(input.scope ? { scope: input.scope } : {}) }
  }] })
}

/** One-way adapter for legacy full-context History snapshots; reduction remains the shared event reducer. */
export function restoreLegacySessionContextEvents(input: readonly Readonly<{
  invocationId: string; turnId: string; sequence: number; kind: 'invocation-context-committed' | 'transcript-compacted'
  messages: readonly CanonicalModelMessage[]
}>[]): SessionContextState {
  const events: HistoryEvent[] = input.map((snapshot, index) => ({
    invocationId: snapshot.invocationId, turnId: snapshot.turnId, sequence: snapshot.sequence, schemaVersion: 1,
    eventId: `legacy-history-snapshot:${index}`, idempotencyKey: `legacy-history-snapshot:${index}`,
    kind: snapshot.kind, payload: { messages: snapshot.messages }
  }))
  for (let index = 0; index < input.length; index += 1) {
    const snapshot = input[index]!
    events.push({ invocationId: snapshot.invocationId, turnId: snapshot.turnId, sequence: snapshot.sequence + 1,
      schemaVersion: 1, eventId: `legacy-history-terminal:${index}`, idempotencyKey: `legacy-history-terminal:${index}`,
      kind: 'invocation-completed', payload: { status: 'completed' } })
  }
  return restoreSessionContext({ committedVersion: input.length, events })
}

/** Start a turn without mutating or copying the committed message objects. */
export function beginContextTurn(state: SessionContextState, input: Readonly<{
  invocationId: string; baseVersion: number; inputMessages: readonly CanonicalModelMessage[]
  failureInputMessages: readonly CanonicalModelMessage[]; requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  requestSystem: string
}>): SessionContextState {
  if (state.committedVersion !== input.baseVersion) throw new Error('CONTEXT_BASE_VERSION_MISMATCH')
  const inputMessages = ownMessages(input.inputMessages)
  const failureInputMessages = ownMessages(input.failureInputMessages)
  const working = [...state.committed, ...inputMessages]
  const failureBase = failureInputMessages.length > 0 ? [...state.committed, ...failureInputMessages] : state.failure ?? state.committed
  return freezeState({ ...state, working, failure: failureBase, parkBaseline: failureBase,
    pendingTools: new Map(), completedToolResults: new Map(), activeInvocationId: input.invocationId,
    ...(input.requiredUserMessage ? { requiredUserMessage: deepFreeze(structuredClone(input.requiredUserMessage)) } : {}), requestSystem: input.requestSystem })
}

/** Apply one business fact; tool results are exposed in model-declared call order. */
export function applyContextEvent(state: SessionContextState, event: SessionContextEvent): SessionContextState {
  if (event.kind === 'transcript-compacted') {
    const required = state.requiredUserMessage
    let matchIndex = Number.isInteger(event.failureCut) ? Number(event.failureCut) : -1
    if (!Number.isInteger(event.failureCut) && required) for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      if (JSON.stringify(event.messages[index]) === JSON.stringify(required.message)) { matchIndex = index; break }
    }
    if (Number.isInteger(event.failureCut) && (matchIndex < 0 || matchIndex >= event.messages.length || !required || JSON.stringify(event.messages[matchIndex]) !== JSON.stringify(required.message))) throw new Error('CONTEXT_FAILURE_CUT_INVALID')
    const messages = ownMessages(event.messages)
    const failure = required && matchIndex >= 0 ? messages.slice(0, matchIndex + 1) : null
    const pendingTools = new Map<string, CanonicalToolCall>()
    for (const message of messages) if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pendingTools.set(call.id, call)
    return freezeState({ ...state, working: messages, failure, pendingTools, completedToolResults: new Map() })
  }
  if (event.kind === 'model-response-committed' || event.kind === 'replay-message-committed') {
    const pendingTools = new Map(state.pendingTools)
    const message = ownMessage(event.message)
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pendingTools.set(call.id, call)
    return freezeState({ ...state, working: [...state.working, message], pendingTools })
  }
  if (event.kind === 'approval-resolved') {
    const approvedToolCallIds = new Set(state.approvedToolCallIds)
    if (event.approved) approvedToolCallIds.add(event.toolCallId)
    else approvedToolCallIds.delete(event.toolCallId)
    return freezeState({ ...state, approvedToolCallIds })
  }
  if (event.kind === 'tool-call-started') {
    return freezeState({ ...state, pendingTools: new Map(state.pendingTools).set(event.toolCall.id, deepFreeze(structuredClone(event.toolCall))) })
  }
  const pendingTools = new Map(state.pendingTools)
  const message = ownMessage(event.message) as Extract<CanonicalModelMessage, { role: 'tool' }>
  const completedToolResults = new Map(state.completedToolResults).set(event.toolCallId, message)
  let index = -1
  for (let cursor = state.working.length - 1; cursor >= 0; cursor -= 1) {
    const message = state.working[cursor]
    if (message?.role === 'assistant' && message.toolCalls?.some((call) => call.id === event.toolCallId)) { index = cursor; break }
  }
  if (index < 0 || !pendingTools.has(event.toolCallId)) throw new Error('CONTEXT_TOOL_RESULT_WITHOUT_CALL')
  const assistantMessage = state.working[index]!
  const orderedCalls = assistantMessage.role === 'assistant' ? assistantMessage.toolCalls ?? [] : []
  const alreadyReduced = new Set<string>()
  for (let cursor = index + 1; cursor < state.working.length; cursor += 1) {
    const message = state.working[cursor]
    if (message?.role === 'assistant') break
    if (message?.role === 'tool' && orderedCalls.some((call) => call.id === message.toolCallId)) alreadyReduced.add(message.toolCallId)
  }
  const resultMessages: CanonicalModelMessage[] = []
  for (const call of orderedCalls) {
    if (alreadyReduced.has(call.id)) continue
    const result = completedToolResults.get(call.id)
    if (!result) break
    resultMessages.push(result)
    pendingTools.delete(call.id)
    completedToolResults.delete(call.id)
  }
  const working = resultMessages.length ? [...state.working.slice(0, index + 1), ...state.working.slice(index + 1), ...resultMessages] : state.working
  return freezeState({ ...state, working, pendingTools, completedToolResults })
}

export function createApprovalSystemMessage(): Extract<CanonicalModelMessage, { role: 'system' }> {
  return Object.freeze({ role: 'system', content: 'Trusted approval record: the user approved the immediately preceding tool call through the confirmation flow before dispatch. Do not describe that call as unconfirmed or as having bypassed confirmation.' })
}

/** Select the only valid context for each terminal business outcome. */
export function selectContextCommit(state: SessionContextState, outcome: ContextOutcome): ContextSelection {
  if (outcome.kind === 'completed') return Object.freeze({ target: 'working', messages: freezeMessages(state.working.filter((message) => message.role !== 'system')) })
  if (outcome.kind === 'park') return Object.freeze({ target: 'park-baseline', messages: freezeMessages(state.parkBaseline.filter((message) => message.role !== 'system')) })
  if (state.failure === null) throw new Error('CONTEXT_FAILURE_SELECTION_UNAVAILABLE')
  return Object.freeze({ target: 'failure', messages: freezeMessages(state.failure.filter((message) => message.role !== 'system')) })
}

/** Publish the selected immutable context only after its matching transcript commit is confirmed. */
export function commitContextTurn(state: SessionContextState, outcome: ContextOutcome, committedVersion: number): SessionContextState {
  if (!Number.isSafeInteger(committedVersion) || committedVersion !== state.committedVersion + 1) {
    throw new Error('CONTEXT_COMMIT_VERSION_MISMATCH')
  }
  const selection = selectContextCommit(state, outcome)
  return freezeState({ ...replaceCommitted(state, selection.messages), committedVersion })
}

/** Persist only the finite SDK decision; canonical messages remain recoverable from History. */
export function createContextSelectionIntent(outcome: ContextOutcome): ContextSelectionIntent {
  const target = outcome.kind === 'completed' ? 'working' : outcome.kind === 'park' ? 'park-baseline' : 'failure'
  return Object.freeze({ contextProtocol: 2 as const, target })
}

function replaceCommitted(state: SessionContextState, messages: readonly CanonicalModelMessage[]): SessionContextState {
  return freezeState({ ...state, committed: messages, working: messages, failure: messages, parkBaseline: messages,
    pendingTools: new Map(), completedToolResults: new Map(), approvedToolCallIds: new Set(), requestSystem: '',
    requiredUserMessage: undefined, activeInvocationId: undefined })
}
