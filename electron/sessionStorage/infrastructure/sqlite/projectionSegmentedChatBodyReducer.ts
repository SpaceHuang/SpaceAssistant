import { createHash } from 'node:crypto'
import type { ClaudeChatMessageWithBlocks } from '../../../../src/shared/api'
import type { CanonicalModelMessage } from '../../../../packages/agent-sdk/src/model'
import { canonicalMessageBodyText, projectCanonicalChatBodyV1 } from '../../domain/projectionSpec'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'

type RequiredUserMessage = Readonly<{ id: string; message: CanonicalModelMessage }>

/** Fold a large context snapshot one message at a time and hand output rows to a streaming writer. */
export async function reduceSegmentedChatBodyContext(input: Readonly<{
  stateJson: string
  event: ProjectionHistoryChunkEvent
  messages: AsyncIterable<unknown>
  messageCount: number
  facts: readonly ProjectionMessageFact[]
  scopeKey: string
  requiredUserMessage?: RequiredUserMessage
  requiredUserMessageRef?: Readonly<{ id: string; messageIndex: number }>
  onProjectedMessage(message: Readonly<{ id: string; role: string; content: unknown; timestamp: number }>): Promise<void>
}>): Promise<Readonly<{ stateJson: string; resetOutput: true }>> {
  const reducer = createProjectionScopeHistoryReducer()
  const factById = new Map(input.facts.map((fact) => [fact.id, fact]))
  if (factById.size !== input.facts.length) throw new Error('CHAT_BODY_SOURCE_FACT_DUPLICATE')
  const baseline = reducer.fold(input.stateJson, [{ ...input.event, payloadJson: '', payload: { messages: [] } }], [], input.scopeKey)
  if (!baseline.resetOutput) throw new Error('PROJECTION_SEGMENTED_CONTEXT_RESET_INVALID')

  const pendingToolCalls = new Set<string>()
  const toolCallOrder: string[] = []
  const seenMessageIds = new Set<string>()
  let index = 0
  let lastProjectedSequence = -1
  let foundRequiredUser = input.requiredUserMessage === undefined

  for await (const raw of input.messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PROJECTION_SEGMENTED_CONTEXT_MESSAGE_INVALID')
    const message = raw as Record<string, unknown>
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const rawTool of message.toolCalls) {
        if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) throw new Error('canonical history tool call is invalid')
        const tool = rawTool as { id?: unknown; name?: unknown; input?: unknown }
        if (typeof tool.id !== 'string' || !tool.id.trim() || typeof tool.name !== 'string' || !tool.name.trim() ||
          !tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input) || pendingToolCalls.has(tool.id)) {
          throw new Error(`duplicate compacted history tool call: ${String(tool.id ?? '')}`)
        }
        pendingToolCalls.add(tool.id)
        toolCallOrder.push(tool.id)
      }
    } else if (message.role === 'tool') {
      if (typeof message.toolCallId !== 'string' || !pendingToolCalls.delete(message.toolCallId)) {
        throw new Error(`compacted history tool result has no call: ${String(message.toolCallId ?? '')}`)
      }
    }

    if (input.requiredUserMessageRef && index === input.requiredUserMessageRef.messageIndex && message.id !== input.requiredUserMessageRef.id) {
      throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
    }
    if (input.requiredUserMessage && message.role === 'user' &&
      JSON.stringify(message) === JSON.stringify(input.requiredUserMessage.message)) {
      message.id = input.requiredUserMessage.id
      foundRequiredUser = true
    }
    const hostMessage = canonicalSnapshotMessageToHost(message)
    if (hostMessage) {
      if (!hostMessage.id) throw new Error('CHAT_BODY_MESSAGE_ID_MISSING')
      const fact = factById.get(hostMessage.id)
      if (!fact) throw new Error('CHAT_BODY_SOURCE_FACT_MISSING')
      const verifiedFact = verifySegmentedMessageBody(hostMessage, fact)
      const [projected] = projectCanonicalChatBodyV1([hostMessage], [verifiedFact], lastProjectedSequence,
        { allowLegacyBodyMismatch: true })
      if (projected) {
        if (seenMessageIds.has(projected.id)) throw new Error('CHAT_BODY_IDENTITY_MISMATCH')
        seenMessageIds.add(projected.id)
        lastProjectedSequence = fact.sequence
        await input.onProjectedMessage(projected)
      }
    }
    index += 1
    if (index % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (index !== input.messageCount) throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
  if (!foundRequiredUser && input.requiredUserMessage) throw new Error(`compacted transcript omitted required message: ${input.requiredUserMessage.id}`)
  if (pendingToolCalls.size) throw new Error(`compacted history contains unresolved tool calls: ${[...pendingToolCalls].join(',')}`)

  const state = JSON.parse(baseline.stateJson) as { formatVersion: number; canonicalStateJson: string; lastSequence: number }
  const canonical = JSON.parse(state.canonicalStateJson) as Record<string, unknown>
  canonical.lastSequence = input.event.sequence
  canonical.pendingToolCalls = []
  canonical.toolCallOrder = toolCallOrder
  canonical.replayResults = []
  state.canonicalStateJson = JSON.stringify(canonical)
  state.lastSequence = lastProjectedSequence
  return { stateJson: JSON.stringify(state), resetOutput: true }
}

/** Convert one canonical model row to the host wire shape used by the canonical chat-body projector. */
export function canonicalSnapshotMessageToHost(raw: unknown): ClaudeChatMessageWithBlocks | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid canonical transcript message')
  const message = raw as Record<string, unknown>
  if (message.role === 'system' || message.role === 'tool') return undefined
  if (message.role !== 'user' && message.role !== 'assistant') throw new Error('invalid canonical transcript message role')
  let content: unknown
  if (typeof message.content === 'string') content = message.content
  else if (Array.isArray(message.content)) {
    const blocks: unknown[] = []
    for (const rawBlock of message.content) {
      if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) throw new Error('invalid canonical transcript content block')
      const block = rawBlock as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
      else if (message.role === 'assistant' && block.type === 'thinking' && typeof block.thinking === 'string') {
        blocks.push({ type: 'thinking', thinking: block.thinking,
          ...(typeof block.thinkingSignature === 'string' ? { signature: block.thinkingSignature } : {}) })
      } else if (block.type === 'image' && typeof block.mimeType === 'string' && typeof block.data === 'string') {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } })
      } else throw new Error(`unsupported canonical transcript content block: ${String(block.type)}`)
    }
    content = blocks
  } else if (message.role === 'assistant' && message.content === undefined) content = []
  else throw new Error('invalid canonical transcript content')

  if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
    if (!Array.isArray(content)) content = [{ type: 'text', text: content }]
    for (const rawTool of message.toolCalls) {
      if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) throw new Error('invalid canonical transcript tool call')
      const tool = rawTool as Record<string, unknown>
      if (typeof tool.id !== 'string' || !tool.id.trim() || typeof tool.name !== 'string' || !tool.name.trim() ||
        !tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input)) throw new Error('invalid canonical transcript tool call')
      ;(content as unknown[]).push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input,
        ...(typeof tool.thoughtSignature === 'string' ? { thought_signature: tool.thoughtSignature } : {}) })
    }
  }
  if (message.id !== undefined && typeof message.id !== 'string') throw new Error('invalid canonical transcript message id')
  if (message.timestamp !== undefined && !Number.isSafeInteger(message.timestamp)) throw new Error('invalid canonical transcript message timestamp')
  return { role: message.role, content: content as ClaudeChatMessageWithBlocks['content'],
    ...(typeof message.id === 'string' ? { id: message.id } : {}),
    ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}) }
}

export function verifySegmentedMessageBody(message: ClaudeChatMessageWithBlocks, fact: ProjectionMessageFact): ProjectionMessageFact {
  if (fact.storedContentDigest === undefined) return fact
  const body = canonicalMessageBodyText(message.content)
  if (body.length !== fact.storedContentLength || createHash('sha256').update(body, 'utf8').digest('hex') !== fact.storedContentDigest) {
    throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
  }
  return { ...fact, storedContent: body }
}
