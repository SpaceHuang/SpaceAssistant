import type { ClaudeChatMessageWithBlocks } from '../../src/shared/api'
import type { CanonicalContentBlock, CanonicalModelMessage } from '../../packages/agent-sdk/src/model'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'

type UnknownRecord = Record<string, unknown>

export class CanonicalCompactionCommitUncertainError extends Error {
  constructor(readonly compactionId: string, override readonly cause: unknown) {
    super(`canonical compaction ${compactionId} committed but legacy ledger commit failed`)
    this.name = 'CanonicalCompactionCommitUncertainError'
  }
}

export async function commitCompactionAcrossStores(input: {
  compactionId: string
  appendCanonical: () => Promise<unknown>
  appendLegacy: () => Promise<unknown>
}): Promise<void> {
  await input.appendCanonical()
  try {
    await input.appendLegacy()
  } catch (cause) {
    throw new CanonicalCompactionCommitUncertainError(input.compactionId, cause)
  }
}

function canonicalMessagesToClaudeMessages(canonicalMessages: readonly CanonicalModelMessage[], options: { allowPendingToolCalls?: boolean } = {}): ClaudeChatMessageWithBlocks[] {
  const messages: ClaudeChatMessageWithBlocks[] = []
  const pendingToolCalls = new Set<string>()
  let pendingToolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: unknown; is_error: boolean }> = []
  const flushToolResults = () => {
    if (pendingToolResults.length) messages.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }
  for (const message of canonicalMessages) {
    if (message.role === 'tool') {
      if (!pendingToolCalls.delete(message.toolCallId)) throw new Error(`compacted history tool result has no call: ${message.toolCallId}`)
      pendingToolResults.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content, is_error: message.isError })
      continue
    }
    flushToolResults()
    if (message.role === 'system') continue
    const blocks: unknown[] = []
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
        else if (block.type === 'thinking') blocks.push({ type: 'thinking', thinking: block.thinking,
          ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}) })
        else if (block.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } })
      }
    }
    for (const tool of message.role === 'assistant' ? message.toolCalls ?? [] : []) {
      if (!tool.id.trim() || pendingToolCalls.has(tool.id)) throw new Error(`duplicate compacted history tool call: ${tool.id}`)
      pendingToolCalls.add(tool.id)
      blocks.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input,
        ...(tool.thoughtSignature ? { thought_signature: tool.thoughtSignature } : {}) })
    }
    messages.push({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : blocks,
      ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
      ...(message.id ? { id: message.id } : {})
    })
  }
  flushToolResults()
  if (pendingToolCalls.size && !options.allowPendingToolCalls) throw new Error(`compacted history contains unresolved tool calls: ${[...pendingToolCalls].join(',')}`)
  return messages
}

/** Projects an SDK boundary transcript to the legacy planner wire shape while retaining pending proposals. */
export function toLegacyBoundaryMessages(
  canonicalMessages: readonly CanonicalModelMessage[],
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
): ClaudeChatMessageWithBlocks[] {
  const messages = canonicalMessagesToClaudeMessages(canonicalMessages, { allowPendingToolCalls: true })
  if (!requiredUserMessage) return messages
  if (requiredUserMessage.message.role !== 'user') throw new Error('required boundary message must be a user message')
  const target = JSON.stringify(requiredUserMessage.message)
  let matchedIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const [canonical] = toCanonicalModelMessages([message])
    if (JSON.stringify(canonical) === target) {
      matchedIndex = index
      break
    }
  }
  if (matchedIndex < 0) throw new Error(`boundary transcript omitted required message: ${requiredUserMessage.id}`)
  messages[matchedIndex] = { ...messages[matchedIndex]!, id: requiredUserMessage.id }
  return messages
}

/** Convert the host's rebuilt Anthropic surface to the provider-neutral SDK history contract. */
export function toCanonicalModelMessages(messages: readonly ClaudeChatMessageWithBlocks[]): CanonicalModelMessage[] {
  const canonical: CanonicalModelMessage[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') {
      canonical.push({ role: message.role, content: message.content, ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}), ...(message.id ? { id: message.id } : {}) })
      continue
    }
    if (!Array.isArray(message.content)) throw new Error('unsupported host message content')
    if (message.role === 'user') {
      let userBlocks: CanonicalContentBlock[] = []
      let lastUserMessageIndex: number | undefined
      const flushUser = () => {
        if (userBlocks.length) {
          lastUserMessageIndex = canonical.length
          canonical.push({ role: 'user', content: userBlocks, ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}) })
        }
        userBlocks = []
      }
      for (const raw of message.content) {
        if (!raw || typeof raw !== 'object') throw new Error('unsupported host content block')
        const block = raw as UnknownRecord
        if (block.type === 'tool_result') {
          if (typeof block.tool_use_id !== 'string' || !block.tool_use_id.trim()) throw new Error('invalid host tool-result block')
          flushUser()
          canonical.push({ role: 'tool', toolCallId: block.tool_use_id, content: block.content ?? '', isError: block.is_error === true })
        } else if (block.type === 'text' && typeof block.text === 'string') userBlocks.push({ type: 'text', text: block.text })
        else if (block.type === 'image') {
          const source = block.source as UnknownRecord | undefined
          if (!source || source.type !== 'base64' || typeof source.media_type !== 'string' || typeof source.data !== 'string') throw new Error('unsupported host image source')
          if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(source.media_type)) throw new Error(`unsupported canonical image MIME type: ${source.media_type}`)
          userBlocks.push({ type: 'image', mimeType: source.media_type as Extract<CanonicalContentBlock, { type: 'image' }>['mimeType'], data: source.data })
        } else throw new Error(`unsupported host content block: ${String(block.type)}`)
      }
      flushUser()
      // A host user message can contain tool results followed by the actual user
      // input. Bind its stable identity to the last user segment, which is also
      // the segment selected by canonicalHostedRequiredUserMessage.
      if (message.id && lastUserMessageIndex !== undefined) {
        const lastUser = canonical[lastUserMessageIndex]
        if (lastUser?.role === 'user') canonical[lastUserMessageIndex] = { ...lastUser, id: message.id }
      }
      continue
    }
    const content: CanonicalContentBlock[] = []
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }> = []
    for (const raw of message.content) {
      if (!raw || typeof raw !== 'object') throw new Error('unsupported host content block')
      const block = raw as UnknownRecord
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        content.push({ type: 'thinking', thinking: block.thinking,
          ...(typeof block.signature === 'string' ? { thinkingSignature: block.signature } : {}) })
      } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
        content.push({ type: 'thinking', thinking: '', thinkingSignature: block.data, redacted: true })
      } else if (block.type === 'image') {
        const source = block.source as UnknownRecord | undefined
        if (!source || source.type !== 'base64' || typeof source.media_type !== 'string' || typeof source.data !== 'string') {
          throw new Error('unsupported host image source')
        }
        if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(source.media_type)) {
          throw new Error(`unsupported canonical image MIME type: ${source.media_type}`)
        }
        content.push({ type: 'image', mimeType: source.media_type as Extract<CanonicalContentBlock, { type: 'image' }>['mimeType'], data: source.data })
      } else if (block.type === 'tool_use') {
        if (typeof block.id !== 'string' || !block.id.trim() || typeof block.name !== 'string' || !block.name.trim() ||
          !block.input || typeof block.input !== 'object' || Array.isArray(block.input)) throw new Error('invalid host tool-use block')
        toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown>,
          ...(typeof block.thought_signature === 'string' ? { thoughtSignature: block.thought_signature } : {}) })
      } else {
        throw new Error(`unsupported host content block: ${String(block.type)}`)
      }
    }
    if (message.role === 'assistant') {
      const timestamp = { ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}), ...(message.id ? { id: message.id } : {}) }
      if (content.length && toolCalls.length) canonical.push({ role: 'assistant', content, toolCalls, ...timestamp })
      else if (content.length) canonical.push({ role: 'assistant', content, ...timestamp })
      else canonical.push({ role: 'assistant', toolCalls, ...timestamp })
    }
  }
  return canonical
}

export type CanonicalProjectionWatermark = Readonly<{
  sessionId: string
  sessionGeneration: string
  sessionSeq: number
  commitOrder: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
  eventCount: number
}>

export type CanonicalWatermarkEvent = Readonly<{
  sessionId: string
  sessionGeneration: string
  sessionSeq: number
  commitOrder: number
  eventId: string
  invocationId: string
}>

/** Validates cache watermarks against the live session incarnation and anchor event. */
export function isCanonicalProjectionWatermarkValid(input: {
  watermark: CanonicalProjectionWatermark
  currentSessionId: string
  currentGeneration: string
  canonicalEventCount: number
  anchor?: CanonicalWatermarkEvent
}): boolean {
  const { watermark } = input
  if (!watermark.sessionId || watermark.sessionId !== input.currentSessionId || !watermark.sessionGeneration ||
    watermark.sessionGeneration !== input.currentGeneration || !Number.isSafeInteger(watermark.eventCount) ||
    watermark.eventCount < 0 || watermark.eventCount !== input.canonicalEventCount ||
    !Number.isSafeInteger(input.canonicalEventCount) || input.canonicalEventCount < 0) return false

  if (watermark.sessionSeq === -1) {
    return watermark.commitOrder === -1 && watermark.watermarkEventId === null &&
      watermark.watermarkInvocationId === null && watermark.eventCount === 0 && input.anchor === undefined
  }

  const anchor = input.anchor
  return Number.isSafeInteger(watermark.sessionSeq) && watermark.sessionSeq >= 1 &&
    Number.isSafeInteger(watermark.commitOrder) && watermark.commitOrder >= 1 &&
    typeof watermark.watermarkEventId === 'string' && watermark.watermarkEventId.length > 0 &&
    typeof watermark.watermarkInvocationId === 'string' && watermark.watermarkInvocationId.length > 0 &&
    Boolean(anchor && anchor.sessionId === watermark.sessionId && anchor.sessionGeneration === watermark.sessionGeneration &&
      anchor.sessionSeq === watermark.sessionSeq && anchor.commitOrder === watermark.commitOrder &&
      anchor.eventId === watermark.watermarkEventId && anchor.invocationId === watermark.watermarkInvocationId)
}

export type CanonicalSessionSnapshot = Readonly<{
  sessionId: string
  invocationId: string
  sessionSeq: number
  commitOrder: number
  messages: readonly ClaudeChatMessageWithBlocks[]
}>

/**
 * Reduce an invocation stream to stable UI message bodies for the session projection.
 * Tool declarations/results remain authoritative in the message skeleton and History
 * transition validator; they are provider-context state, not independent UI messages.
 */
export function canonicalSessionTranscriptEvents(events: readonly HistoryEvent[]): HistoryEvent[] {
  const transcriptEvents: HistoryEvent[] = []
  for (const event of events) {
    if (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched' || event.kind === 'approval-deferred') continue
    if (event.kind === 'model-response-committed') {
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown> : undefined
      const rawMessage = payload?.message
      const message = rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)
        ? rawMessage as Record<string, unknown> : undefined
      if (payload && message && Object.hasOwn(message, 'toolCalls')) {
        const { toolCalls: _toolCalls, ...bodyMessage } = message
        transcriptEvents.push({ ...event, payload: { ...payload, message: bodyMessage } })
      } else transcriptEvents.push(event)
      continue
    }
    if (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted') {
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown> : undefined
      const messages = payload?.messages
      if (payload && Array.isArray(messages)) {
        const transcriptMessages = messages.flatMap((rawMessage) => {
          if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return [rawMessage]
          const message = rawMessage as Record<string, unknown>
          if (message.role === 'tool') return []
          if (message.role !== 'assistant' || !Object.hasOwn(message, 'toolCalls')) return [rawMessage]
          const { toolCalls: _toolCalls, ...bodyMessage } = message
          return [bodyMessage]
        })
        transcriptEvents.push({ ...event, payload: { ...payload, messages: transcriptMessages } })
      } else transcriptEvents.push(event)
      continue
    }
    transcriptEvents.push(event)
  }
  return transcriptEvents
}

/**
 * Folds provider-context snapshots across invocations only when stable IDs prove
 * an append/replacement chain. Context snapshots may omit old messages, so an
 * omitted ID never means deletion. Any ambiguous ordering falls back to legacy.
 */
export function foldClaudeSessionSnapshots(snapshots: readonly CanonicalSessionSnapshot[]): ClaudeChatMessageWithBlocks[] {
  const session = createCanonicalSessionSnapshotFoldSession()
  for (const snapshot of [...snapshots].sort((left, right) => left.sessionSeq - right.sessionSeq || left.commitOrder - right.commitOrder)) {
    session.fold(snapshot)
  }
  return session.messages()
}

export type CanonicalSessionSnapshotFoldSession = Readonly<{
  fold(snapshot: CanonicalSessionSnapshot): readonly CanonicalSessionSnapshotOperation[]
  messages(): ClaudeChatMessageWithBlocks[]
  stateJson(): string
  indexJson(): string
}>

/** Resumable in-memory fold session; callers can persist stateJson and externalize messages/ID facts separately. */
export function createCanonicalSessionSnapshotFoldSession(
  stateJson?: string,
  priorMessages: readonly ClaudeChatMessageWithBlocks[] = [],
  externalIndexJson?: string
): CanonicalSessionSnapshotFoldSession {
  let state = stateJson === undefined ? createCanonicalSessionSnapshotFoldState() : parseCanonicalSessionSnapshotFoldState(stateJson)
  if (!state) throw new Error('canonical session snapshot fold checkpoint is invalid')
  if (state.messageCount !== priorMessages.length) throw new Error('canonical session snapshot fold checkpoint does not match its external message index')
  let currentMessages = priorMessages.map((message) => structuredClone(message))
  let indexEntries = snapshotIndexEntries(currentMessages)
  if (externalIndexJson !== undefined) {
    const externalIndex = parseCanonicalSessionSnapshotExternalIndex(externalIndexJson)
    if (!externalIndex || externalIndex.messageCount !== state.messageCount || externalIndex.entries.length !== state.messageCount ||
      JSON.stringify(externalIndex.entries) !== JSON.stringify(indexEntries)) {
      throw new Error('canonical session snapshot checkpoint does not match its external message index')
    }
    indexEntries = externalIndex.entries
  }
  return Object.freeze({
    fold(snapshot: CanonicalSessionSnapshot) {
      const existingById = new Map(indexEntries.map((entry) => [entry.id, entry] as const))
      const existingMessages = snapshot.messages.flatMap((message) => message.id && existingById.has(message.id) ? [existingById.get(message.id)!] : [])
      const commonCount = existingMessages.length
      const facts = { messageCount: indexEntries.length, existingMessages,
        tailMessageIds: commonCount === 0 ? [] : indexEntries.slice(-commonCount).map((entry) => entry.id) }
      const folded = foldCanonicalSessionSnapshot(state!, snapshot, facts)
      currentMessages = applyCanonicalSessionSnapshotOperations(currentMessages, folded.operations)
      indexEntries = snapshotIndexEntries(currentMessages)
      state = folded.state
      return folded.operations
    },
    messages: () => currentMessages.map((message) => structuredClone(message)),
    stateJson: () => JSON.stringify(state),
    indexJson: () => JSON.stringify({ formatVersion: 1, messageCount: indexEntries.length, entries: indexEntries }),
  })
}

export type CanonicalSessionSnapshotExternalIndex = Readonly<{
  formatVersion: 1
  messageCount: number
  entries: readonly Readonly<{ id: string; role: string; ordinal: number }>[]
  ids?: readonly string[]
}>

export function parseCanonicalSessionSnapshotExternalIndex(json: string): CanonicalSessionSnapshotExternalIndex | null {
  let value: unknown
  try { value = JSON.parse(json) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const index = value as Partial<CanonicalSessionSnapshotExternalIndex>
  if (index.formatVersion !== 1 || !Number.isSafeInteger(index.messageCount) || (index.messageCount ?? -1) < 0 ||
    !Array.isArray(index.entries) || index.entries.length !== index.messageCount) return null
  if (index.ids !== undefined && (!Array.isArray(index.ids) || index.ids.length !== index.entries.length ||
    index.ids.some((id, ordinal) => id !== index.entries![ordinal]?.id))) return null
  const ids = new Set<string>()
  for (let ordinal = 0; ordinal < index.entries.length; ordinal += 1) {
    const entry = index.entries[ordinal]
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || !['user', 'assistant', 'system'].includes(entry.role) ||
      entry.ordinal !== ordinal || ids.has(entry.id)) return null
    ids.add(entry.id)
  }
  return Object.freeze({ formatVersion: 1, messageCount: index.messageCount!,
    entries: Object.freeze(index.entries.map((entry) => Object.freeze({ ...entry }))),
    ...(index.ids === undefined ? {} : { ids: Object.freeze([...index.ids]) }) })
}

function snapshotIndexEntries(messages: readonly ClaudeChatMessageWithBlocks[]): ReadonlyArray<{ id: string; role: string; ordinal: number }> {
  return Object.freeze(messages.map((message, ordinal) => {
    if (!message.id?.trim() || !['user', 'assistant', 'system'].includes(message.role)) {
      throw new Error('canonical session snapshot external message index is invalid')
    }
    return Object.freeze({ id: message.id, role: message.role, ordinal })
  }))
}

export type CanonicalSessionSnapshotFoldState = Readonly<{
  formatVersion: 1
  sessionId: string | null
  lastSessionSeq: number
  lastCommitOrder: number
  messageCount: number
}>
export type CanonicalSessionSnapshotIndexFacts = Readonly<{
  messageCount: number
  existingMessages: readonly Readonly<{ id: string; role: string; ordinal: number }>[]
  tailMessageIds: readonly string[]
}>
export type CanonicalSessionSnapshotOperation = Readonly<
  | { type: 'append'; message: ClaudeChatMessageWithBlocks }
  | { type: 'upsert'; message: ClaudeChatMessageWithBlocks }
>
export type CanonicalSessionSnapshotFoldResult = Readonly<{
  state: CanonicalSessionSnapshotFoldState
  operations: readonly CanonicalSessionSnapshotOperation[]
}>

export function createCanonicalSessionSnapshotFoldState(): CanonicalSessionSnapshotFoldState {
  return Object.freeze({ formatVersion: 1, sessionId: null, lastSessionSeq: 0, lastCommitOrder: 0, messageCount: 0 })
}

/** Reject corrupt durable ID-index state before it can authorize snapshot replacement. */
export function parseCanonicalSessionSnapshotFoldState(json: string): CanonicalSessionSnapshotFoldState | null {
  let value: unknown
  try { value = JSON.parse(json) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Partial<CanonicalSessionSnapshotFoldState>
  if (state.formatVersion !== 1 || !(state.sessionId === null || (typeof state.sessionId === 'string' && state.sessionId.length > 0)) ||
    !Number.isSafeInteger(state.lastSessionSeq) || (state.lastSessionSeq ?? -1) < 0 ||
    !Number.isSafeInteger(state.lastCommitOrder) || (state.lastCommitOrder ?? -1) < 0 ||
    !Number.isSafeInteger(state.messageCount) || (state.messageCount ?? -1) < 0) return null
  const empty = state.sessionId === null && state.lastSessionSeq === 0 && state.lastCommitOrder === 0 && state.messageCount === 0
  if (!empty && (state.sessionId === null || (state.lastSessionSeq ?? 0) < 1 || (state.lastCommitOrder ?? 0) < 1)) return null
  return Object.freeze({ formatVersion: 1, sessionId: state.sessionId!, lastSessionSeq: state.lastSessionSeq!,
    lastCommitOrder: state.lastCommitOrder!, messageCount: state.messageCount! })
}

/** Merge one ordered invocation snapshot while retaining established messages omitted by later contexts. */
export function foldCanonicalSessionSnapshot(
  state: CanonicalSessionSnapshotFoldState,
  snapshot: CanonicalSessionSnapshot,
  facts: CanonicalSessionSnapshotIndexFacts
): CanonicalSessionSnapshotFoldResult {
  if (!snapshot.sessionId || (state.sessionId !== null && snapshot.sessionId !== state.sessionId) || !snapshot.invocationId ||
    !Number.isSafeInteger(snapshot.sessionSeq) || snapshot.sessionSeq <= state.lastSessionSeq ||
    !Number.isSafeInteger(snapshot.commitOrder) || snapshot.commitOrder <= state.lastCommitOrder) {
    throw new Error('canonical session snapshot order or ownership is invalid')
  }
  const ids = snapshot.messages.map((message) => {
    if (!message.id?.trim()) throw new Error('canonical session snapshot is missing stable message identity')
    return message.id
  })
  if (new Set(ids).size !== ids.length) throw new Error('canonical session snapshot contains duplicate stable message identity')
  if (!Number.isSafeInteger(facts.messageCount) || facts.messageCount !== state.messageCount || !Array.isArray(facts.existingMessages) || !Array.isArray(facts.tailMessageIds)) {
    throw new Error('canonical session snapshot index facts are invalid')
  }
  const currentRoles = new Map<string, string>()
  const ordinals = new Set<number>()
  for (const item of facts.existingMessages) {
    if (!item.id?.trim() || !['user', 'assistant', 'system'].includes(item.role) || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= facts.messageCount ||
      currentRoles.has(item.id) || ordinals.has(item.ordinal) || !ids.includes(item.id)) throw new Error('canonical session snapshot index facts are invalid')
    currentRoles.set(item.id, item.role); ordinals.add(item.ordinal)
  }
  const existingIds = new Set(currentRoles.keys())
  const commonIds = ids.filter((id) => existingIds.has(id))
  if (facts.messageCount > 0) {
    if (commonIds.length === 0 || facts.tailMessageIds.length !== commonIds.length || facts.tailMessageIds.some((id, index) => id !== commonIds[index]) ||
      facts.existingMessages.filter((item) => commonIds.includes(item.id)).sort((a, b) => a.ordinal - b.ordinal).map((item) => item.id).some((id, index) => id !== commonIds[index])) {
      throw new Error('canonical session snapshot order conflicts with prior snapshots')
    }
    const firstNewIndex = ids.findIndex((id) => !existingIds.has(id))
    const lastCommonIndex = ids.reduce((last, id, index) => existingIds.has(id) ? index : last, -1)
    if (firstNewIndex >= 0 && firstNewIndex < lastCommonIndex) {
      throw new Error('canonical session snapshot inserts messages before an established suffix')
    }
  }
  const operations: CanonicalSessionSnapshotOperation[] = []
  let nextCount = state.messageCount
  for (const message of snapshot.messages) {
    const id = message.id!
    const existingRole = currentRoles.get(id)
    if (existingRole === undefined) {
      nextCount++
      currentRoles.set(id, message.role)
      operations.push(Object.freeze({ type: 'append', message: structuredClone(message) }))
    } else {
      if (existingRole !== message.role) throw new Error(`canonical message identity changed role: ${id}`)
      operations.push(Object.freeze({ type: 'upsert', message: structuredClone(message) }))
    }
  }
  return Object.freeze({ state: Object.freeze({ formatVersion: 1, sessionId: snapshot.sessionId,
    lastSessionSeq: snapshot.sessionSeq, lastCommitOrder: snapshot.commitOrder, messageCount: nextCount }),
    operations: Object.freeze(operations) })
}

export function applyCanonicalSessionSnapshotOperations(
  current: readonly ClaudeChatMessageWithBlocks[], operations: readonly CanonicalSessionSnapshotOperation[]
): ClaudeChatMessageWithBlocks[] {
  const result = [...current]
  const indexById = new Map(result.flatMap((message, index) => message.id ? [[message.id, index] as const] : []))
  for (const operation of operations) {
    const id = operation.message.id
    if (!id?.trim()) throw new Error('canonical session snapshot output is missing stable message identity')
    const existingIndex = indexById.get(id)
    if (operation.type === 'append') {
      if (existingIndex !== undefined) throw new Error(`canonical session snapshot append duplicated ID: ${id}`)
      indexById.set(id, result.length)
      result.push(structuredClone(operation.message))
    } else {
      if (existingIndex === undefined) throw new Error(`canonical session snapshot upsert target is missing: ${id}`)
      if (result[existingIndex]?.role !== operation.message.role) throw new Error(`canonical message identity changed role: ${id}`)
      result[existingIndex] = structuredClone(operation.message)
    }
  }
  return result
}

export type CanonicalHistoryReductionOptions = Readonly<{
  omitAnonymousReplayFromSessionTranscript?: boolean
  allowPendingToolCalls?: boolean
  synthesizeUnknownToolResults?: boolean
}>
export type CanonicalHistoryReplayResult = Readonly<{
  type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean
}>
/** JSON-serializable fold state; a preparing worker can persist it between bounded source chunks. */
export type CanonicalHistoryReductionState = Readonly<{
  formatVersion: 1
  invocationId: string | null
  turnId: string | null
  lastSequence: number
  terminalEvent: boolean
  options: Required<CanonicalHistoryReductionOptions>
  pendingToolCalls: readonly string[]
  toolCallOrder: readonly string[]
  replayResults: readonly (readonly [string, CanonicalHistoryReplayResult])[]
}>
export type CanonicalHistoryOutputOperation = Readonly<
  | { type: 'append'; messages: readonly ClaudeChatMessageWithBlocks[] }
  | { type: 'replace'; messages: readonly ClaudeChatMessageWithBlocks[] }
>
export type CanonicalHistoryReductionSlice = Readonly<{
  state: CanonicalHistoryReductionState
  outputOperations: readonly CanonicalHistoryOutputOperation[]
}>

export function createCanonicalHistoryReductionState(options: CanonicalHistoryReductionOptions = {}): CanonicalHistoryReductionState {
  return Object.freeze({ formatVersion: 1, invocationId: null, turnId: null, lastSequence: 0, terminalEvent: false,
    options: Object.freeze({ omitAnonymousReplayFromSessionTranscript: options.omitAnonymousReplayFromSessionTranscript ?? false,
      allowPendingToolCalls: options.allowPendingToolCalls ?? false, synthesizeUnknownToolResults: options.synthesizeUnknownToolResults ?? false }),
    pendingToolCalls: Object.freeze([]), toolCallOrder: Object.freeze([]), replayResults: Object.freeze([]) })
}

/** Parse only self-consistent JSON state; callers must reject a malformed persisted fold rather than resume it. */
export function parseCanonicalHistoryReductionState(json: string): CanonicalHistoryReductionState | null {
  let value: unknown
  try { value = JSON.parse(json) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Partial<CanonicalHistoryReductionState>
  const isStringList = (list: unknown): list is string[] => Array.isArray(list) &&
    list.every((entry) => typeof entry === 'string' && entry.length > 0) && new Set(list).size === list.length
  const options = state.options
  if (state.formatVersion !== 1 || !(state.invocationId === null || (typeof state.invocationId === 'string' && state.invocationId.length > 0)) ||
    !(state.turnId === null || (typeof state.turnId === 'string' && state.turnId.length > 0)) ||
    !Number.isSafeInteger(state.lastSequence) || (state.lastSequence ?? -1) < 0 ||
    typeof state.terminalEvent !== 'boolean' ||
    (state.lastSequence === 0) !== (state.invocationId === null && state.turnId === null) ||
    !options || typeof options !== 'object' ||
    typeof options.omitAnonymousReplayFromSessionTranscript !== 'boolean' ||
    typeof options.allowPendingToolCalls !== 'boolean' || typeof options.synthesizeUnknownToolResults !== 'boolean' ||
    !isStringList(state.pendingToolCalls) || !isStringList(state.toolCallOrder) || !Array.isArray(state.replayResults)) return null
  const order = new Set(state.toolCallOrder)
  if (state.pendingToolCalls.some((toolCallId) => !order.has(toolCallId))) return null
  const replayResults: Array<readonly [string, CanonicalHistoryReplayResult]> = []
  const replayIds = new Set<string>()
  for (const candidate of state.replayResults) {
    if (!Array.isArray(candidate) || candidate.length !== 2 || typeof candidate[0] !== 'string' || !order.has(candidate[0]) ||
      replayIds.has(candidate[0]) || !candidate[1] || typeof candidate[1] !== 'object' ||
      candidate[1].type !== 'tool_result' || candidate[1].tool_use_id !== candidate[0] ||
      !Object.hasOwn(candidate[1], 'content') || (candidate[1].is_error !== undefined && typeof candidate[1].is_error !== 'boolean')) return null
    replayIds.add(candidate[0])
    replayResults.push(Object.freeze([candidate[0], Object.freeze({ ...candidate[1] })] as const))
  }
  return Object.freeze({ formatVersion: 1, invocationId: state.invocationId!, turnId: state.turnId!, lastSequence: state.lastSequence!, terminalEvent: state.terminalEvent!,
    options: Object.freeze({ ...options }),
    pendingToolCalls: Object.freeze([...state.pendingToolCalls]), toolCallOrder: Object.freeze([...state.toolCallOrder]),
    replayResults: Object.freeze(replayResults) })
}

/** Fold one contiguous invocation's next event slice into a durable, serializable state. */
export function foldCanonicalHistoryChunk(
  state: CanonicalHistoryReductionState,
  events: readonly HistoryEvent[]
): CanonicalHistoryReductionSlice {
  const outputOperations: CanonicalHistoryOutputOperation[] = []
  let pendingOutputMessages: ClaudeChatMessageWithBlocks[] = []
  const pendingToolCalls = new Set(state.pendingToolCalls)
  const toolCallOrder = [...state.toolCallOrder]
  const replayResults = new Map(state.replayResults)
  let invocationId = state.invocationId
  let turnId = state.turnId
  let lastSequence = state.lastSequence
  let terminalEvent = state.terminalEvent
  const options = state.options
  const flushOutput = () => {
    if (pendingOutputMessages.length) outputOperations.push(Object.freeze({ type: 'append', messages: Object.freeze(pendingOutputMessages) }))
    pendingOutputMessages = []
  }
  const emitMessage = (message: ClaudeChatMessageWithBlocks) => { pendingOutputMessages.push(message) }
  const flushResults = () => {
    const ordered = toolCallOrder.flatMap((toolCallId) => {
      const result = replayResults.get(toolCallId)
      return result ? [result] : []
    })
    if (ordered.length) emitMessage({ role: 'user', content: ordered })
    for (const toolCallId of toolCallOrder) replayResults.delete(toolCallId)
    toolCallOrder.length = 0
  }

  for (const event of events) {
    if (!event.invocationId || !event.turnId || !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      (invocationId !== null && invocationId !== event.invocationId) || (turnId !== null && turnId !== event.turnId) || terminalEvent ||
      event.sequence <= lastSequence) throw new Error('canonical history reducer event identity or sequence is invalid')
    invocationId ??= event.invocationId
    turnId ??= event.turnId
    lastSequence = event.sequence
    terminalEvent = ['invocation-parked', 'invocation-interrupted', 'invocation-completed', 'invocation-failed'].includes(event.kind)
    if (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted') {
      const payload = event.payload as { messages?: unknown; requiredUserMessage?: { id?: unknown; message?: unknown } }
      if (!Array.isArray(payload?.messages)) throw new Error(`invalid canonical transcript snapshot: ${event.eventId}`)
      const canonicalMessages = payload.messages as CanonicalModelMessage[]
      const replacement = canonicalMessagesToClaudeMessages(canonicalMessages)
      const required = payload.requiredUserMessage
      if (typeof required?.id === 'string' && required.message && typeof required.message === 'object' && !canonicalMessages.some((message) => 'id' in message && message.id === required.id)) {
        const target = JSON.stringify(required.message)
        let match = -1
        for (let index = replacement.length - 1; index >= 0; index -= 1) {
          if (replacement[index]?.role !== 'user') continue
          const [candidate] = toCanonicalModelMessages([replacement[index]!])
          if (JSON.stringify(candidate) === target) { match = index; break }
        }
        if (match < 0) throw new Error(`compacted transcript omitted required message: ${required.id}`)
        replacement[match] = { ...replacement[match]!, id: required.id }
      }
      pendingOutputMessages = []
      outputOperations.length = 0
      outputOperations.push(Object.freeze({ type: 'replace', messages: Object.freeze(replacement) }))
      pendingToolCalls.clear()
      toolCallOrder.length = 0
      replayResults.clear()
      for (const message of canonicalMessages) {
        if (message.role === 'assistant') {
          for (const tool of message.toolCalls ?? []) { pendingToolCalls.add(tool.id); toolCallOrder.push(tool.id) }
        } else if (message.role === 'tool') pendingToolCalls.delete(message.toolCallId)
      }
      continue
    }
    if (event.kind === 'replay-message-committed') {
      flushResults()
      const payload = event.payload as { message?: unknown }
      const message = payload?.message as CanonicalModelMessage | undefined
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) throw new Error(`invalid canonical replay message: ${event.eventId}`)
      if (message.role === 'assistant') throw new Error('assistant replay messages must use model-response-committed')
      if (!message.id?.trim() && options.omitAnonymousReplayFromSessionTranscript) continue
      if (typeof message.content === 'string') emitMessage({ role: 'user', content: message.content, ...(message.id ? { id: message.id } : {}) })
      else if (Array.isArray(message.content)) emitMessage({ role: 'user', content: message.content.map((block) => {
        if (block.type === 'text') return { type: 'text', text: block.text }
        return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }
      }), ...(message.id ? { id: message.id } : {}) })
      else throw new Error(`invalid canonical user replay content: ${event.eventId}`)
      continue
    }
    if (event.kind === 'model-response-committed') {
      flushResults()
      const payload = event.payload as { message?: unknown }
      const message = payload?.message as CanonicalModelMessage | undefined
      if (!message || message.role !== 'assistant') throw new Error(`invalid canonical assistant response: ${event.eventId}`)
      const blocks: unknown[] = []
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'thinking') blocks.push({ type: 'thinking', thinking: block.thinking, ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}) })
          else if (block.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } })
        }
      }
      for (const tool of message.toolCalls ?? []) {
        if (!tool.id.trim() || pendingToolCalls.has(tool.id)) throw new Error(`duplicate canonical tool call: ${tool.id}`)
        pendingToolCalls.add(tool.id)
        toolCallOrder.push(tool.id)
        blocks.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input, ...(tool.thoughtSignature ? { thought_signature: tool.thoughtSignature } : {}) })
      }
      emitMessage({ role: 'assistant', content: typeof message.content === 'string' ? message.content : blocks,
        ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}), ...(message.id ? { id: message.id } : {}) })
      continue
    }
    if (event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched' || event.kind === 'approval-deferred') {
      const payload = event.payload as { toolCallId?: unknown; replayContent?: unknown; isError?: unknown }
      if (typeof payload?.toolCallId !== 'string' || !pendingToolCalls.has(payload.toolCallId)) {
        throw new Error(`history tool result has no committed call: ${String(payload?.toolCallId)}`)
      }
      pendingToolCalls.delete(payload.toolCallId)
      if (event.kind === 'approval-deferred') continue
      const notDispatched = event.kind === 'tool-call-not-dispatched'
      replayResults.set(payload.toolCallId, {
        type: 'tool_result', tool_use_id: payload.toolCallId,
        content: payload.replayContent ?? (notDispatched ? notDispatchedReplayContent((event.payload as { reason?: unknown }).reason) : ''),
        ...(notDispatched ? { is_error: true } : typeof payload.isError === 'boolean' ? { is_error: payload.isError } : {})
      })
    }
  }
  flushOutput()
  return Object.freeze({ state: Object.freeze({ formatVersion: 1, invocationId, turnId, lastSequence, terminalEvent, options,
    pendingToolCalls: Object.freeze([...pendingToolCalls]), toolCallOrder: Object.freeze(toolCallOrder),
    replayResults: Object.freeze([...replayResults.entries()]) }), outputOperations: Object.freeze(outputOperations) })
}

/** Finish the fold; pending tool calls fail closed unless this view explicitly allows them. */
export function finalizeCanonicalHistoryReduction(state: CanonicalHistoryReductionState): Readonly<{ outputOperations: readonly CanonicalHistoryOutputOperation[] }> {
  const outputOperations: CanonicalHistoryOutputOperation[] = []
  let pendingOutputMessages: ClaudeChatMessageWithBlocks[] = []
  const flushOutput = () => {
    if (pendingOutputMessages.length) outputOperations.push(Object.freeze({ type: 'append', messages: Object.freeze(pendingOutputMessages) }))
    pendingOutputMessages = []
  }
  const emitMessage = (message: ClaudeChatMessageWithBlocks) => { pendingOutputMessages.push(message) }
  const pendingToolCalls = new Set(state.pendingToolCalls)
  const toolCallOrder = [...state.toolCallOrder]
  const replayResults = new Map(state.replayResults)
  const unresolvedToolOrder = toolCallOrder.filter((toolCallId) => pendingToolCalls.has(toolCallId))
  const flushResults = () => {
    const ordered = toolCallOrder.flatMap((toolCallId) => {
      const result = replayResults.get(toolCallId)
      return result ? [result] : []
    })
    if (ordered.length) emitMessage({ role: 'user', content: ordered })
    for (const toolCallId of toolCallOrder) replayResults.delete(toolCallId)
    toolCallOrder.length = 0
  }
  flushResults()
  if (state.options.synthesizeUnknownToolResults && pendingToolCalls.size) {
    const unknownResults = unresolvedToolOrder.map((toolCallId) => ({
      type: 'tool_result' as const, tool_use_id: toolCallId,
      content: 'The prior operation was dispatched but its outcome is unknown. Do not replay it; verify safely or ask the user.', is_error: true
    }))
    if (unknownResults.length) emitMessage({ role: 'user', content: unknownResults })
    pendingToolCalls.clear()
  }
  if (pendingToolCalls.size && !state.options.allowPendingToolCalls) {
    throw new Error(`history contains unresolved tool calls: ${[...pendingToolCalls].join(',')}`)
  }
  flushOutput()
  return Object.freeze({ outputOperations: Object.freeze(outputOperations) })
}

export function applyCanonicalHistoryOutputOperations(
  current: readonly ClaudeChatMessageWithBlocks[], operations: readonly CanonicalHistoryOutputOperation[]
): ClaudeChatMessageWithBlocks[] {
  let result = [...current]
  for (const operation of operations) result = operation.type === 'replace'
    ? [...operation.messages]
    : [...result, ...operation.messages]
  return result
}

/** Rebuilds the accepted model/tool suffix from committed History events; incomplete dispatches fail closed. */
export function rebuildClaudeMessagesFromHistory(events: readonly HistoryEvent[], options: CanonicalHistoryReductionOptions = {}): ClaudeChatMessageWithBlocks[] {
  const slice = foldCanonicalHistoryChunk(createCanonicalHistoryReductionState(options), events)
  const finalized = finalizeCanonicalHistoryReduction(slice.state)
  return applyCanonicalHistoryOutputOperations([], [...slice.outputOperations, ...finalized.outputOperations])
}

function notDispatchedReplayContent(reason: unknown): string {
  const stableReason = typeof reason === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(reason) ? reason : 'NOT_DISPATCHED'
  return `Tool call was not dispatched (${stableReason}).`
}
