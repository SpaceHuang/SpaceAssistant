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
      const userStart = canonical.length
      const flushUser = () => {
        if (userBlocks.length) canonical.push({ role: 'user', content: userBlocks, ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}) })
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
      if (message.id && canonical.length - userStart === 1) {
        const only = canonical[userStart]
        if (only?.role === 'user') canonical[userStart] = { ...only, id: message.id }
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
    if (event.kind === 'tool-call-started' || event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') continue
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
  if (snapshots.length === 0) return []
  const ordered = [...snapshots].sort((left, right) => left.sessionSeq - right.sessionSeq || left.commitOrder - right.commitOrder)
  const sessionId = ordered[0]!.sessionId
  let previousSessionSeq = 0
  let previousCommitOrder = 0
  const folded: ClaudeChatMessageWithBlocks[] = []
  const indexById = new Map<string, number>()

  for (const snapshot of ordered) {
    if (!snapshot.sessionId || snapshot.sessionId !== sessionId || !snapshot.invocationId ||
      !Number.isSafeInteger(snapshot.sessionSeq) || snapshot.sessionSeq <= previousSessionSeq ||
      !Number.isSafeInteger(snapshot.commitOrder) || snapshot.commitOrder <= previousCommitOrder) {
      throw new Error('canonical session snapshot order or ownership is invalid')
    }
    previousSessionSeq = snapshot.sessionSeq
    previousCommitOrder = snapshot.commitOrder

    const sessionMessages = snapshot.messages
    const ids = sessionMessages.map((message) => {
      if (!message.id?.trim()) throw new Error('canonical session snapshot is missing stable message identity')
      return message.id
    })
    if (new Set(ids).size !== ids.length) throw new Error('canonical session snapshot contains duplicate stable message identity')

    const currentIds = folded.map((message) => message.id!)
    const commonIds = ids.filter((id) => indexById.has(id))
    if (folded.length > 0) {
      const currentSuffix = currentIds.slice(-commonIds.length)
      if (commonIds.length === 0 || currentSuffix.join('\\0') !== commonIds.join('\\0')) {
        throw new Error('canonical session snapshot order conflicts with prior snapshots')
      }
      const firstNewIndex = ids.findIndex((id) => !indexById.has(id))
      const lastCommonIndex = ids.reduce((last, id, index) => indexById.has(id) ? index : last, -1)
      if (firstNewIndex >= 0 && firstNewIndex < lastCommonIndex) {
        throw new Error('canonical session snapshot inserts messages before an established suffix')
      }
    }

    for (const [messageIndex, message] of sessionMessages.entries()) {
      const id = ids[messageIndex]!
      const existingIndex = indexById.get(id)
      if (existingIndex === undefined) {
        indexById.set(id, folded.length)
        folded.push(structuredClone(message))
        continue
      }
      if (folded[existingIndex]?.role !== message.role) throw new Error(`canonical message identity changed role: ${id}`)
      folded[existingIndex] = structuredClone(message)
    }
  }
  return folded
}

/** Rebuilds the accepted model/tool suffix from committed History events; incomplete dispatches fail closed. */
export function rebuildClaudeMessagesFromHistory(
  events: readonly HistoryEvent[],
  options: Readonly<{ omitAnonymousReplayFromSessionTranscript?: boolean; allowPendingToolCalls?: boolean }> = {}
): ClaudeChatMessageWithBlocks[] {
  const messages: ClaudeChatMessageWithBlocks[] = []
  const pendingToolCalls = new Set<string>()
  const toolCallOrder: string[] = []
  const replayResults = new Map<string, { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }>()
  const flushResults = () => {
    const ordered = toolCallOrder.flatMap((toolCallId) => {
      const result = replayResults.get(toolCallId)
      return result ? [result] : []
    })
    if (ordered.length) messages.push({ role: 'user', content: ordered })
    for (const toolCallId of toolCallOrder) replayResults.delete(toolCallId)
    toolCallOrder.length = 0
  }

  for (const event of events) {
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
      messages.splice(0, messages.length, ...replacement)
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
      if (typeof message.content === 'string') messages.push({ role: 'user', content: message.content, ...(message.id ? { id: message.id } : {}) })
      else if (Array.isArray(message.content)) messages.push({ role: 'user', content: message.content.map((block) => {
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
      messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : blocks,
        ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}), ...(message.id ? { id: message.id } : {}) })
      continue
    }
    if (event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') {
      const payload = event.payload as { toolCallId?: unknown; replayContent?: unknown; isError?: unknown }
      if (typeof payload?.toolCallId !== 'string' || !pendingToolCalls.has(payload.toolCallId)) {
        throw new Error(`history tool result has no committed call: ${String(payload?.toolCallId)}`)
      }
      pendingToolCalls.delete(payload.toolCallId)
      const notDispatched = event.kind === 'tool-call-not-dispatched'
      replayResults.set(payload.toolCallId, {
        type: 'tool_result', tool_use_id: payload.toolCallId,
        content: payload.replayContent ?? (notDispatched ? notDispatchedReplayContent((event.payload as { reason?: unknown }).reason) : ''),
        ...(notDispatched ? { is_error: true } : typeof payload.isError === 'boolean' ? { is_error: payload.isError } : {})
      })
    }
  }
  flushResults()
  if (pendingToolCalls.size && !options.allowPendingToolCalls) {
    throw new Error(`history contains unresolved tool calls: ${[...pendingToolCalls].join(',')}`)
  }
  return messages
}

function notDispatchedReplayContent(reason: unknown): string {
  const stableReason = typeof reason === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(reason) ? reason : 'NOT_DISPATCHED'
  return `Tool call was not dispatched (${stableReason}).`
}
