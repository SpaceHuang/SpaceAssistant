import type { ClaudeChatMessageWithBlocks } from '../../../../src/shared/api'
import { projectCanonicalChatBodyV1 } from '../../domain/projectionSpec'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import type { ProjectionHistoryReducerPort } from '../../application/projectionBuildCoordinator'
import { createProjectionCanonicalHistoryReducer } from './projectionCanonicalHistoryReducer'

type ChunkedAssistant = Readonly<{ id: string; expectedContentLength: number | null; contentOffset: number }>
type ChatBodyState = Readonly<{ formatVersion: 1; canonicalStateJson: string; lastSequence: number; chunkedAssistant?: ChunkedAssistant }>

/** ProjectionSpec.chatBodyV1 adapter over the canonical History reducer and same-snapshot message facts. */
export function createProjectionChatBodyReducer(): ProjectionHistoryReducerPort {
  const canonical = createProjectionCanonicalHistoryReducer()
  return Object.freeze({
    createState: () => JSON.stringify({ formatVersion: 1, canonicalStateJson: canonical.createState(), lastSequence: -1 } satisfies ChatBodyState),
    fold(stateJson: string, events: readonly ProjectionHistoryChunkEvent[], facts: readonly ProjectionMessageFact[] = []) {
      const state = parseState(stateJson)
      const folded = canonical.fold(state.canonicalStateJson, events, facts)
      let lastSequence = folded.resetOutput ? -1 : state.lastSequence
      let chunkedAssistant = folded.resetOutput ? undefined : state.chunkedAssistant
      const chunkedAssistantIds = modelResponseMessageIds(events)
      const outputOperations: unknown[] = []
      for (const candidate of folded.outputOperations) {
        const operation = candidate as { type?: unknown; messages?: unknown }
        if ((operation.type !== 'append' && operation.type !== 'replace') || !Array.isArray(operation.messages)) {
          throw new Error('CHAT_BODY_HISTORY_OPERATION_INVALID')
        }
        if (operation.type === 'replace') {
          lastSequence = -1
          chunkedAssistant = undefined
        }
        const sourceMessages = operation.type === 'append'
          ? coalesceAssistantResponseChunks(operation.messages as ClaudeChatMessageWithBlocks[])
          : operation.messages as ClaudeChatMessageWithBlocks[]
        const notYetProjected = operation.type === 'append' ? sourceMessages.filter((message) => {
          if (!message.id) return true
          if (chunkedAssistant?.id === message.id) return true
          const fact = facts.find((candidate) => candidate.id === message.id)
          return !fact || fact.sequence > lastSequence
        }) : sourceMessages
        const messages: ReturnType<typeof projectCanonicalChatBodyV1> = []
        const textAppends: Array<Readonly<{ id: string; role: 'assistant'; text: string }>> = []
        const closeChunkedAssistant = () => {
          if (!chunkedAssistant) return
          if (chunkedAssistant.expectedContentLength !== null && chunkedAssistant.contentOffset !== chunkedAssistant.expectedContentLength) {
            throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
          }
          chunkedAssistant = undefined
        }
        for (const message of notYetProjected) {
          const fact = message.id ? facts.find((candidate) => candidate.id === message.id) : undefined
          if (message.role === 'assistant' && message.id && chunkedAssistantIds.has(message.id) && fact &&
            (fact.contentStorageState === 'canonical-backed-only' || fact.contentStorageState === 'canonical-backed-dual-write')) {
            if (fact.writeMode !== 'canonical' || (fact.contentStorageState === 'canonical-backed-only' && fact.storedContent !== '')) {
              throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
            }
            if (chunkedAssistant && chunkedAssistant.id !== message.id) closeChunkedAssistant()
            const offset = chunkedAssistant?.contentOffset ?? 0
            const expectedContentLength = fact.contentStorageState === 'canonical-backed-dual-write'
              ? fact.storedContent.length : null
            if (chunkedAssistant && chunkedAssistant.expectedContentLength !== expectedContentLength) {
              throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
            }
            const bodyFact = { ...fact, contentStorageState: 'canonical-backed-only' as const, storedContent: '' }
            const [delta] = projectCanonicalChatBodyV1([message], [bodyFact], -1)
            if (!delta) throw new Error('CHAT_BODY_SOURCE_FACT_MISSING')
            if (expectedContentLength !== null && fact.storedContent.slice(offset, offset + delta.content.length) !== delta.content) {
              throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
            }
            if (!chunkedAssistant) messages.push(delta)
            else if (delta.content) textAppends.push({ id: message.id, role: 'assistant', text: delta.content })
            chunkedAssistant = { id: message.id, expectedContentLength,
              contentOffset: offset + delta.content.length }
            lastSequence = fact.sequence
            continue
          }
          if (chunkedAssistant) closeChunkedAssistant()
          const [projected] = projectCanonicalChatBodyV1([message], facts, lastSequence, { allowLegacyBodyMismatch: true })
          if (projected) {
            messages.push(projected)
            lastSequence = facts.find((candidate) => candidate.id === projected.id)?.sequence ?? lastSequence
          }
        }
        if (operation.type === 'replace' || messages.length > 0) outputOperations.push(Object.freeze({ type: operation.type, messages: Object.freeze(messages) }))
        if (textAppends.length) outputOperations.push(Object.freeze({ type: 'appendText', updates: Object.freeze(textAppends) }))
      }
      return Object.freeze({ stateJson: JSON.stringify({ formatVersion: 1, canonicalStateJson: folded.stateJson, lastSequence,
        ...(chunkedAssistant ? { chunkedAssistant } : {}) } satisfies ChatBodyState),
        outputOperations: Object.freeze(outputOperations), resetOutput: folded.resetOutput })
    },
    finalize(stateJson: string) {
      const state = parseState(stateJson)
      const finalized = canonical.finalize(state.canonicalStateJson)
      if (state.chunkedAssistant?.expectedContentLength !== null && state.chunkedAssistant?.contentOffset !== state.chunkedAssistant?.expectedContentLength) {
        throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
      }
      const outputOperations = finalized.outputOperations.map((candidate) => {
        const operation = candidate as { type?: unknown; messages?: unknown }
        if (operation.type !== 'append' || !Array.isArray(operation.messages)) throw new Error('CHAT_BODY_HISTORY_OPERATION_INVALID')
        return Object.freeze({ type: 'append', messages: Object.freeze(projectCanonicalChatBodyV1(
          operation.messages as ClaudeChatMessageWithBlocks[], [], state.lastSequence)) })
      })
      return Object.freeze({ outputOperations: Object.freeze(outputOperations) })
    }
  })
}

/** model-response-committed rows can carry successive text chunks for one persisted assistant message. */
function coalesceAssistantResponseChunks(messages: readonly ClaudeChatMessageWithBlocks[]): ClaudeChatMessageWithBlocks[] {
  const result: ClaudeChatMessageWithBlocks[] = []
  const indexById = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.id) {
      result.push(message)
      continue
    }
    const previousIndex = indexById.get(message.id)
    if (previousIndex === undefined) {
      indexById.set(message.id, result.length)
      result.push(message)
      continue
    }
    const previous = result[previousIndex]!
    const content = typeof previous.content === 'string' && typeof message.content === 'string'
      ? previous.content + message.content
      : [...asContentBlocks(previous.content), ...asContentBlocks(message.content)]
    result[previousIndex] = { ...previous, ...message, content,
      ...(previous.timestamp === undefined && message.timestamp !== undefined ? { timestamp: message.timestamp } : {}) }
  }
  return result
}

function asContentBlocks(content: ClaudeChatMessageWithBlocks['content']): unknown[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function modelResponseMessageIds(events: readonly ProjectionHistoryChunkEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'model-response-committed') continue
    const payload = JSON.parse(event.payloadJson) as { message?: { id?: unknown } }
    if (typeof payload.message?.id === 'string' && payload.message.id) ids.add(payload.message.id)
  }
  return ids
}

function parseState(json: string): ChatBodyState {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('CHAT_BODY_REDUCER_CHECKPOINT_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CHAT_BODY_REDUCER_CHECKPOINT_INVALID')
  const state = value as Partial<ChatBodyState>
  if (state.formatVersion !== 1 || typeof state.canonicalStateJson !== 'string' || !Number.isSafeInteger(state.lastSequence) || state.lastSequence! < -1 ||
    (state.chunkedAssistant !== undefined && (!state.chunkedAssistant || typeof state.chunkedAssistant !== 'object' ||
      typeof state.chunkedAssistant.id !== 'string' || !state.chunkedAssistant.id ||
      !(state.chunkedAssistant.expectedContentLength === null || (Number.isSafeInteger(state.chunkedAssistant.expectedContentLength) && state.chunkedAssistant.expectedContentLength >= 0)) ||
      !Number.isSafeInteger(state.chunkedAssistant.contentOffset) || state.chunkedAssistant.contentOffset < 0 ||
      (state.chunkedAssistant.expectedContentLength !== null && state.chunkedAssistant.contentOffset > state.chunkedAssistant.expectedContentLength)))) {
    throw new Error('CHAT_BODY_REDUCER_CHECKPOINT_INVALID')
  }
  return state as ChatBodyState
}
