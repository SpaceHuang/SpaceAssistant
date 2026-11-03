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
const freezeOwnedMessages = (messages: readonly CanonicalModelMessage[]): readonly CanonicalModelMessage[] =>
  Object.freeze(messages.map(deepFreeze))
const mutableOwnedMessages = (messages: readonly CanonicalModelMessage[]): CanonicalModelMessage[] =>
  messages.map(deepFreeze)
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
  if (eventsAreOwned) return restoreOwnedSessionContextLinear(input)
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
      ?? restoreSessionContextGeneric({ committedVersion: input.committedVersion, events: simpleRun }, state, eventsAreOwned)
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
      state = restoreSessionContextGeneric({ committedVersion: input.committedVersion, events: currentTurn }, state, eventsAreOwned)
    }
    currentTurn = []
    currentTurnIsSimple = true
  }
  if (currentTurn.length) {
    flushSimpleRun()
    state = restoreSessionContextGeneric({ committedVersion: input.committedVersion, events: currentTurn }, state, eventsAreOwned)
  }
  flushSimpleRun()
  return freezeState({ ...state, committedVersion: input.committedVersion })
}

type MutableReplaySelection = Readonly<{
  base: CanonicalModelMessage[]
  baseLength: number
  additions: readonly CanonicalModelMessage[]
  filterStart: number
}> | null

type MutableToolGroup = {
  callIds: readonly string[]
  cursor: number
  emitted: Set<string>
}

/** Cold History owns its decoded payloads, so replay can advance private buffers in place. */
function restoreOwnedSessionContextLinear(
  input: Readonly<{ committedVersion: number; events: readonly ContextReplayEvent[] | HistorySnapshot['events'] }>
): SessionContextState {
  let committed: CanonicalModelMessage[] = []
  let committedLength = 0
  let working = committed
  let workingFilterStart = 0
  let failure: MutableReplaySelection = { base: committed, baseLength: 0, additions: [], filterStart: 0 }
  let parkBaseline: MutableReplaySelection = failure
  let scope: ContextScope | undefined
  let requestSystem = ''
  let activeInvocationId: string | undefined
  let requiredUserMessage: SessionContextState['requiredUserMessage']
  const pendingTools = new Map<string, CanonicalToolCall>()
  const completedToolResults = new Map<string, Extract<CanonicalModelMessage, { role: 'tool' }>>()
  const approvedToolCallIds = new Set<string>()
  const toolGroups = new Map<string, MutableToolGroup>()

  const selection = (base: CanonicalModelMessage[], baseLength = base.length,
    additions: readonly CanonicalModelMessage[] = [], filterStart = 0): MutableReplaySelection =>
    ({ base, baseLength, additions, filterStart })
  const materialize = (source: MutableReplaySelection): CanonicalModelMessage[] => {
    if (!source) throw new Error('CONTEXT_FAILURE_SELECTION_UNAVAILABLE')
    if (source.additions.length === 0 && source.baseLength === source.base.length && !Object.isFrozen(source.base)) return source.base
    return [...source.base.slice(0, source.baseLength), ...source.additions]
  }
  const removeSystemMessagesFrom = (messages: CanonicalModelMessage[], start: number): void => {
    let write = Math.min(start, messages.length)
    for (let read = write; read < messages.length; read += 1) {
      const message = messages[read]!
      if (message.role !== 'system') messages[write++] = message
    }
    messages.length = write
  }
  const clearTools = (): void => {
    pendingTools.clear()
    completedToolResults.clear()
    approvedToolCallIds.clear()
    toolGroups.clear()
  }
  const commitMessages = (messages: CanonicalModelMessage[]): void => {
    committed = messages
    committedLength = messages.length
    working = messages
    workingFilterStart = messages.length
    failure = selection(messages)
    parkBaseline = failure
    clearTools()
    requestSystem = ''
    activeInvocationId = undefined
    requiredUserMessage = undefined
  }
  const createToolGroup = (callIds: readonly string[], emitted = new Set<string>()): MutableToolGroup => {
    const group: MutableToolGroup = { callIds, cursor: 0, emitted }
    while (group.cursor < callIds.length && emitted.has(callIds[group.cursor]!)) group.cursor += 1
    for (const callId of callIds) toolGroups.set(callId, group)
    return group
  }
  const addAssistantCalls = (message: CanonicalModelMessage): void => {
    if (message.role !== 'assistant' || !message.toolCalls?.length) return
    const calls = message.toolCalls
    createToolGroup(calls.map((call) => call.id))
    for (const call of calls) pendingTools.set(call.id, call)
  }
  const rebuildCompactedToolGroups = (messages: readonly CanonicalModelMessage[]): void => {
    pendingTools.clear()
    toolGroups.clear()
    for (let index = 0; index < messages.length; index += 1) {
      const assistant = messages[index]
      if (assistant?.role !== 'assistant' || !assistant.toolCalls?.length) continue
      const callIds = assistant.toolCalls.map((call) => call.id)
      const callIdSet = new Set(callIds)
      const emitted = new Set<string>()
      for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
        const nested = messages[cursor]
        if (nested?.role === 'assistant') break
        if (nested?.role === 'tool' && callIdSet.has(nested.toolCallId)) emitted.add(nested.toolCallId)
      }
      createToolGroup(callIds, emitted)
      for (const call of assistant.toolCalls) pendingTools.set(call.id, call)
    }
  }
  const completeTool = (toolCallId: string, incoming: Extract<CanonicalModelMessage, { role: 'tool' }>): void => {
    if (!pendingTools.has(toolCallId)) throw new Error('CONTEXT_TOOL_RESULT_WITHOUT_CALL')
    const group = toolGroups.get(toolCallId)
    if (!group) throw new Error('CONTEXT_TOOL_RESULT_WITHOUT_CALL')
    const message = deepFreeze(incoming)
    completedToolResults.set(toolCallId, message)
    while (group.cursor < group.callIds.length) {
      const nextId = group.callIds[group.cursor]!
      if (group.emitted.has(nextId)) { group.cursor += 1; continue }
      const result = completedToolResults.get(nextId)
      if (!result) break
      working.push(result)
      group.emitted.add(nextId)
      pendingTools.delete(nextId)
      completedToolResults.delete(nextId)
      group.cursor += 1
    }
  }

  for (const event of input.events) {
    if (event.kind === 'session-input-committed') {
      const payload = event.payload as { messages?: unknown; system?: unknown; scope?: unknown }
      if (Array.isArray(payload?.messages)) {
        committed = mutableOwnedMessages(payload.messages as CanonicalModelMessage[])
        committedLength = committed.length
        working = committed
        workingFilterStart = 0
        failure = selection(working, working.length, [], 0)
        parkBaseline = failure
        clearTools()
        activeInvocationId = undefined
        requiredUserMessage = undefined
        requestSystem = ''
      }
      if (payload?.scope && typeof payload.scope === 'object') scope = deepFreeze(structuredClone(payload.scope as ContextScope))
      if (typeof payload?.system === 'string') requestSystem = payload.system
    } else if (event.kind === 'invocation-context-committed') {
      const payload = event.payload as { contextProtocol?: unknown; inputMode?: unknown; inputMessages?: unknown; failureInputMessages?: unknown; scope?: unknown; messages?: unknown; replacement?: unknown; invocationId?: unknown; requiredUserMessage?: unknown; system?: unknown }
      if (payload?.contextProtocol !== undefined && payload.contextProtocol !== 2) throw new Error('CONTEXT_PROTOCOL_UNKNOWN')
      if (payload?.contextProtocol === 2 && payload.inputMessages !== undefined) {
        if (!Array.isArray(payload.inputMessages) || !Array.isArray(payload.failureInputMessages) || !payload.scope || typeof payload.scope !== 'object') throw new Error('CONTEXT_INPUT_INVALID')
        const nextScope = payload.scope as ContextScope
        if (scope && JSON.stringify(scope) !== JSON.stringify(nextScope)) throw new Error('CONTEXT_SCOPE_MISMATCH')
        const mode = payload.inputMode
        if (mode !== undefined && mode !== 'baseline' && mode !== 'delta') throw new Error('CONTEXT_INPUT_MODE_INVALID')
        const inputMode = mode ?? (Array.isArray(payload.messages) ? 'baseline' : 'delta')
        const additions = mutableOwnedMessages((inputMode === 'baseline' && Array.isArray(payload.messages)
          ? payload.messages : payload.inputMessages) as CanonicalModelMessage[])
        const failureAdditions = freezeOwnedMessages(payload.failureInputMessages as CanonicalModelMessage[]) as CanonicalModelMessage[]
        if (inputMode === 'baseline') {
          working = additions
          workingFilterStart = 0
        } else {
          working = committed
          working.length = committedLength
          working.push(...additions)
          workingFilterStart = committedLength
        }
        if (failureAdditions.length) {
          failure = inputMode === 'baseline' ? selection(failureAdditions) : selection(committed, committedLength, failureAdditions, committedLength)
          parkBaseline = inputMode === 'baseline' ? selection(failureAdditions) : selection(committed, committedLength, failureAdditions, committedLength)
        }
        scope = deepFreeze(structuredClone(nextScope))
        if (typeof payload.invocationId === 'string') activeInvocationId = payload.invocationId
        if (payload.requiredUserMessage && typeof payload.requiredUserMessage === 'object') {
          requiredUserMessage = deepFreeze(structuredClone(payload.requiredUserMessage as { id: string; message: CanonicalModelMessage }))
        }
        if (typeof payload.system === 'string') requestSystem = payload.system
        continue
      }
      const replacement = payload?.replacement && typeof payload.replacement === 'object' ? payload.replacement as { reason?: unknown; messages?: unknown } : undefined
      if (replacement && replacement.reason !== 'initial-scope' && replacement.reason !== 'manual-review') throw new Error('CONTEXT_REPLACEMENT_REASON_UNKNOWN')
      if (replacement && !Array.isArray(replacement.messages)) throw new Error('CONTEXT_REPLACEMENT_MESSAGES_INVALID')
      const replacementMessages = replacement?.messages
      if (Array.isArray(payload?.messages) || replacementMessages) {
        const messages = mutableOwnedMessages((replacementMessages ?? payload.messages) as CanonicalModelMessage[])
        if (replacementMessages) {
          commitMessages(messages)
          continue
        }
        working = messages
        workingFilterStart = 0
        failure = selection(working)
        parkBaseline = failure
        if (typeof payload.invocationId === 'string') activeInvocationId = payload.invocationId
        if (payload.requiredUserMessage && typeof payload.requiredUserMessage === 'object') {
          requiredUserMessage = deepFreeze(structuredClone(payload.requiredUserMessage as { id: string; message: CanonicalModelMessage }))
        }
        if (typeof payload.system === 'string') requestSystem = payload.system
      }
    } else if (event.kind === 'transcript-compacted') {
      const payload = event.payload as { contextProtocol?: unknown; messages?: unknown; failureCut?: unknown }
      if (payload?.contextProtocol !== undefined && payload.contextProtocol !== 2) throw new Error('CONTEXT_PROTOCOL_UNKNOWN')
      if (Array.isArray(payload?.messages)) {
        const messages = mutableOwnedMessages(payload.messages as CanonicalModelMessage[])
        let matchIndex = Number.isInteger(payload.failureCut) ? Number(payload.failureCut) : -1
        if (!Number.isInteger(payload.failureCut) && requiredUserMessage) for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (JSON.stringify(messages[index]) === JSON.stringify(requiredUserMessage.message)) { matchIndex = index; break }
        }
        if (Number.isInteger(payload.failureCut) && (matchIndex < 0 || matchIndex >= messages.length || !requiredUserMessage ||
          JSON.stringify(messages[matchIndex]) !== JSON.stringify(requiredUserMessage.message))) throw new Error('CONTEXT_FAILURE_CUT_INVALID')
        working = messages
        workingFilterStart = 0
        failure = requiredUserMessage && matchIndex >= 0
          ? selection(working.slice(0, matchIndex + 1))
          : null
        rebuildCompactedToolGroups(working)
        completedToolResults.clear()
      }
    } else if (event.kind === 'model-response-committed' || event.kind === 'replay-message-committed') {
      const payload = event.payload as { message?: unknown }
      if (payload?.message && typeof payload.message === 'object') {
        const message = deepFreeze(payload.message as CanonicalModelMessage)
        if (event.kind === 'replay-message-committed' && message.role === 'tool') {
          completeTool(message.toolCallId, message)
        } else {
          working.push(message)
          addAssistantCalls(message)
        }
      }
    } else if (event.kind === 'tool-call-started') {
      const payload = event.payload as { toolCall?: unknown }
      if (payload?.toolCall && typeof payload.toolCall === 'object') {
        const call = deepFreeze(payload.toolCall as CanonicalToolCall)
        pendingTools.set(call.id, call)
      }
    } else if (event.kind === 'tool-call-finished') {
      const payload = event.payload as { toolCallId?: unknown; message?: unknown; replayContent?: unknown; result?: unknown; isError?: unknown }
      const result = payload.message && typeof payload.message === 'object'
        ? payload.message as Extract<CanonicalModelMessage, { role: 'tool' }>
        : typeof payload.toolCallId === 'string' && (payload.replayContent !== undefined || payload.result !== undefined)
          ? { role: 'tool' as const, toolCallId: payload.toolCallId, content: payload.replayContent ?? payload.result, isError: payload.isError === true }
          : undefined
      if (typeof payload.toolCallId === 'string' && result) {
        completeTool(payload.toolCallId, result)
        if (approvedToolCallIds.has(payload.toolCallId)) {
          const resultIndex = working.findIndex((message) => message.role === 'tool' && message.toolCallId === payload.toolCallId)
          if (resultIndex >= 0) working.splice(resultIndex + 1, 0, createApprovalSystemMessage())
        }
      }
    } else if (event.kind === 'approval-resolved') {
      const payload = event.payload as { toolCallId?: unknown; approved?: unknown; answerer?: unknown }
      if (typeof payload.toolCallId === 'string' && payload.approved === true && payload.answerer === 'user') approvedToolCallIds.add(payload.toolCallId)
    } else if (event.kind === 'invocation-completed' || event.kind === 'invocation-parked' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted') {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as { contextSelection?: unknown; status?: unknown; reason?: unknown } : undefined
      const processRestart = event.kind === 'invocation-interrupted' && payload?.status === 'interrupted' && payload.reason === 'process-restart'
      const target = event.kind === 'invocation-completed' || processRestart ? 'working' : event.kind === 'invocation-parked' ? 'park-baseline' : 'failure'
      if (payload?.contextSelection && typeof payload.contextSelection === 'object') {
        const terminalSelection = payload.contextSelection as { contextProtocol?: unknown; target?: unknown }
        if (terminalSelection.contextProtocol !== 2 || terminalSelection.target !== target) throw new Error('CONTEXT_TERMINAL_SELECTION_MISMATCH')
      }
      const selectedSource = target === 'working' ? selection(working, working.length, [], workingFilterStart)
        : target === 'park-baseline' ? parkBaseline : failure
      const selected = materialize(selectedSource)
      if (processRestart) {
        const unknownResult = 'The previous run ended before its result was recorded. The operation may have started; inspect the current state, ask the user, or retry if appropriate.'
        for (const call of pendingTools.values()) {
          const group = toolGroups.get(call.id)
          if (!group) continue
          completedToolResults.set(call.id, deepFreeze({ role: 'tool', toolCallId: call.id, content: unknownResult, isError: true }))
          while (group.cursor < group.callIds.length) {
            const nextId = group.callIds[group.cursor]!
            if (group.emitted.has(nextId)) { group.cursor += 1; continue }
            const result = completedToolResults.get(nextId)
            if (!result) break
            working.push(result)
            group.emitted.add(nextId)
            pendingTools.delete(nextId)
            completedToolResults.delete(nextId)
            group.cursor += 1
          }
        }
        selected.splice(0, selected.length, ...working.slice(0, selected.length), ...working.slice(selected.length))
      }
      const selectedFilterStart = target === 'working' ? workingFilterStart
        : (target === 'park-baseline' ? parkBaseline : failure)?.filterStart ?? 0
      removeSystemMessagesFrom(selected, selectedFilterStart)
      commitMessages(selected)
    }
  }

  const finalCommitted = committed.length === committedLength ? committed : committed.slice(0, committedLength)
  const finalFailure = failure === null ? null : materialize(failure)
  const finalParkBaseline = materialize(parkBaseline)
  return freezeState({ committedVersion: input.committedVersion, committed: finalCommitted, working,
    failure: finalFailure, parkBaseline: finalParkBaseline, pendingTools, completedToolResults,
    approvedToolCallIds, requestSystem, ...(scope ? { scope } : {}), ...(requiredUserMessage ? { requiredUserMessage } : {}),
    ...(activeInvocationId ? { activeInvocationId } : {}) })
}

function restoreSessionContextGeneric(
  input: Readonly<{ committedVersion: number; events: readonly ContextReplayEvent[] | HistorySnapshot['events'] }>,
  initialState?: SessionContextState,
  eventsAreOwned = false
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
        const additionsSource = (inputMode === 'baseline' && Array.isArray(payload.messages)
          ? payload.messages : payload.inputMessages) as CanonicalModelMessage[]
        const additions = eventsAreOwned ? freezeOwnedMessages(additionsSource) : ownMessages(additionsSource)
        const failureSource = payload.failureInputMessages as CanonicalModelMessage[]
        const failureAdditions = eventsAreOwned ? freezeOwnedMessages(failureSource) : ownMessages(failureSource)
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
      const additionsSource = mode === 'baseline' && Array.isArray(payload.messages) ? payload.messages : payload.inputMessages
      const additions = eventsAreOwned ? freezeOwnedMessages(additionsSource) : ownMessages(additionsSource)
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
