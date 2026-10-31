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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

const freezeMessages = (messages: readonly CanonicalModelMessage[]): readonly CanonicalModelMessage[] =>
  Object.freeze(messages.map((message) => deepFreeze(structuredClone(message))))

function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map([...source].map(([key, value]) => [key, value && typeof value === 'object' ? deepFreeze(structuredClone(value)) : value]))
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
  return Object.freeze(view) as ReadonlyMap<K, V>
}

function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
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
  return Object.freeze(view) as ReadonlySet<T>
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
  ...(state.requiredUserMessage ? { requiredUserMessage: deepFreeze(structuredClone(state.requiredUserMessage)) } : {})
})

/** Convert the legacy full-context events into one canonical state for both recovery and live turns. */
export function restoreSessionContext(input: Readonly<{ committedVersion: number; events: readonly HistoryEvent[] | HistorySnapshot['events'] }>): SessionContextState {
  let state = freezeState({ committedVersion: input.committedVersion, committed: [], working: [], failure: [], parkBaseline: [], pendingTools: new Map(), completedToolResults: new Map(), approvedToolCallIds: new Set(), requestSystem: '' })
  for (const event of input.events) {
    if (event.kind === 'session-input-committed') {
      const payload = event.payload as { messages?: unknown; system?: unknown; scope?: unknown }
      if (Array.isArray(payload?.messages)) state = replaceCommitted(state, payload.messages as CanonicalModelMessage[])
      if (payload?.scope && typeof payload.scope === 'object') state = freezeState({ ...state, scope: deepFreeze(structuredClone(payload.scope as ContextScope)) })
      if (typeof payload?.system === 'string') state = freezeState({ ...state, requestSystem: payload.system })
    } else if (event.kind === 'invocation-context-committed') {
      const payload = event.payload as { contextProtocol?: unknown; baseVersion?: unknown; inputMessages?: unknown; failureInputMessages?: unknown; scope?: unknown; messages?: unknown; replacement?: unknown; invocationId?: unknown; requiredUserMessage?: unknown; system?: unknown }
      if (payload?.contextProtocol !== undefined && payload.contextProtocol !== 2) throw new Error('CONTEXT_PROTOCOL_UNKNOWN')
      if (payload?.contextProtocol === 2 && payload.inputMessages !== undefined) {
        if (!Array.isArray(payload.inputMessages) || !Array.isArray(payload.failureInputMessages) || !payload.scope || typeof payload.scope !== 'object') throw new Error('CONTEXT_INPUT_INVALID')
        const scope = payload.scope as ContextScope
        if (state.scope && JSON.stringify(state.scope) !== JSON.stringify(scope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
        const additions = payload.inputMessages as CanonicalModelMessage[]
        const failureAdditions = payload.failureInputMessages as CanonicalModelMessage[]
        state = freezeState({ ...state,
          committed: state.scope ? state.committed : freezeMessages([]),
          working: [...(state.scope ? state.committed : []), ...additions],
          failure: failureAdditions.length ? [...(state.scope ? state.committed : []), ...failureAdditions] : state.failure,
          parkBaseline: failureAdditions.length ? [...(state.scope ? state.committed : []), ...failureAdditions] : state.parkBaseline,
          scope: deepFreeze(structuredClone(scope)),
          ...(typeof payload.invocationId === 'string' ? { activeInvocationId: payload.invocationId } : {}),
          ...(payload.requiredUserMessage && typeof payload.requiredUserMessage === 'object' ? { requiredUserMessage: payload.requiredUserMessage as { id: string; message: CanonicalModelMessage } } : {}),
          ...(typeof payload.system === 'string' ? { requestSystem: payload.system } : {}) })
        continue
      }
      const replacement = payload?.replacement && typeof payload.replacement === 'object' ? payload.replacement as { reason?: unknown; messages?: unknown } : undefined
      if (replacement && replacement.reason !== 'initial-scope' && replacement.reason !== 'manual-review') throw new Error('CONTEXT_REPLACEMENT_REASON_UNKNOWN')
      if (replacement && !Array.isArray(replacement.messages)) throw new Error('CONTEXT_REPLACEMENT_MESSAGES_INVALID')
      const replacementMessages = replacement?.messages
      if (Array.isArray(payload?.messages) || replacementMessages) {
        const messages = (replacementMessages ?? payload.messages) as CanonicalModelMessage[]
        if (replacementMessages) {
          state = replaceCommitted(state, messages)
          continue
        }
        state = freezeState({ ...state, working: messages, failure: messages, parkBaseline: messages,
          ...(typeof payload.invocationId === 'string' ? { activeInvocationId: payload.invocationId } : {}),
          ...(payload.requiredUserMessage && typeof payload.requiredUserMessage === 'object' ? { requiredUserMessage: payload.requiredUserMessage as { id: string; message: CanonicalModelMessage } } : {}),
          ...(typeof payload.system === 'string' ? { requestSystem: payload.system } : {}) })
      }
    } else if (event.kind === 'transcript-compacted') {
      const payload = event.payload as { contextProtocol?: unknown; messages?: unknown; failureCut?: unknown }
      if (payload?.contextProtocol !== undefined && payload.contextProtocol !== 2) throw new Error('CONTEXT_PROTOCOL_UNKNOWN')
      if (Array.isArray(payload?.messages)) {
        const messages = payload.messages as CanonicalModelMessage[]
        state = applyContextEvent(state, { kind: 'transcript-compacted', messages, ...(Number.isInteger(payload.failureCut) ? { failureCut: Number(payload.failureCut) } : {}) })
      }
    } else if (event.kind === 'model-response-committed' || event.kind === 'replay-message-committed') {
      const payload = event.payload as { message?: unknown }
      if (payload?.message && typeof payload.message === 'object') state = applyContextEvent(state, { kind: event.kind, message: payload.message as CanonicalModelMessage })
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
  const working = [...state.committed, ...input.inputMessages]
  const failureBase = input.failureInputMessages.length > 0 ? [...state.committed, ...input.failureInputMessages] : state.failure ?? state.committed
  return freezeState({ ...state, working, failure: failureBase, parkBaseline: failureBase,
    pendingTools: new Map(), completedToolResults: new Map(), activeInvocationId: input.invocationId,
    ...(input.requiredUserMessage ? { requiredUserMessage: input.requiredUserMessage } : {}), requestSystem: input.requestSystem })
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
    const failure = required && matchIndex >= 0 ? event.messages.slice(0, matchIndex + 1) : null
    const pendingTools = new Map<string, CanonicalToolCall>()
    for (const message of event.messages) if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pendingTools.set(call.id, call)
    return freezeState({ ...state, working: event.messages, failure, pendingTools, completedToolResults: new Map() })
  }
  if (event.kind === 'model-response-committed' || event.kind === 'replay-message-committed') {
    const pendingTools = new Map(state.pendingTools)
    if (event.message.role === 'assistant') for (const call of event.message.toolCalls ?? []) pendingTools.set(call.id, call)
    return freezeState({ ...state, working: [...state.working, event.message], pendingTools })
  }
  if (event.kind === 'approval-resolved') {
    const approvedToolCallIds = new Set(state.approvedToolCallIds)
    if (event.approved) approvedToolCallIds.add(event.toolCallId)
    else approvedToolCallIds.delete(event.toolCallId)
    return freezeState({ ...state, approvedToolCallIds })
  }
  if (event.kind === 'tool-call-started') {
    return freezeState({ ...state, pendingTools: new Map(state.pendingTools).set(event.toolCall.id, event.toolCall) })
  }
  const pendingTools = new Map(state.pendingTools)
  const completedToolResults = new Map(state.completedToolResults).set(event.toolCallId, event.message)
  let index = -1
  for (let cursor = state.working.length - 1; cursor >= 0; cursor -= 1) {
    const message = state.working[cursor]
    if (message?.role === 'assistant' && message.toolCalls?.some((call) => call.id === event.toolCallId)) { index = cursor; break }
  }
  if (index < 0 || !pendingTools.has(event.toolCallId)) throw new Error('CONTEXT_TOOL_RESULT_WITHOUT_CALL')
  const assistantMessage = state.working[index]!
  const orderedCalls = assistantMessage.role === 'assistant' ? assistantMessage.toolCalls ?? [] : []
  const resultMessages: CanonicalModelMessage[] = []
  for (const call of orderedCalls) {
    const result = completedToolResults.get(call.id)
    if (!result) break
    resultMessages.push(result)
    pendingTools.delete(call.id)
    completedToolResults.delete(call.id)
  }
  const working = resultMessages.length ? [...state.working.slice(0, index + 1), ...resultMessages, ...state.working.slice(index + 1).filter((message) => message.role !== 'tool')] : state.working
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
