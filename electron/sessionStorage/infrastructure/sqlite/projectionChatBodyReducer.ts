import type { ClaudeChatMessageWithBlocks } from '../../../../src/shared/api'
import { projectCanonicalChatBodyV1 } from '../../domain/projectionSpec'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import type { ProjectionHistoryReducerPort } from '../../application/projectionBuildCoordinator'
import { createProjectionCanonicalHistoryReducer } from './projectionCanonicalHistoryReducer'

type ChatBodyState = Readonly<{ formatVersion: 1; canonicalStateJson: string; lastSequence: number }>

/** ProjectionSpec.chatBodyV1 adapter over the canonical History reducer and same-snapshot message facts. */
export function createProjectionChatBodyReducer(): ProjectionHistoryReducerPort {
  const canonical = createProjectionCanonicalHistoryReducer()
  return Object.freeze({
    createState: () => JSON.stringify({ formatVersion: 1, canonicalStateJson: canonical.createState(), lastSequence: -1 } satisfies ChatBodyState),
    fold(stateJson: string, events: readonly ProjectionHistoryChunkEvent[], facts: readonly ProjectionMessageFact[] = []) {
      const state = parseState(stateJson)
      const folded = canonical.fold(state.canonicalStateJson, events, facts)
      let lastSequence = folded.resetOutput ? -1 : state.lastSequence
      const outputOperations = folded.outputOperations.map((candidate) => {
        const operation = candidate as { type?: unknown; messages?: unknown }
        if ((operation.type !== 'append' && operation.type !== 'replace') || !Array.isArray(operation.messages)) {
          throw new Error('CHAT_BODY_HISTORY_OPERATION_INVALID')
        }
        if (operation.type === 'replace') lastSequence = -1
        const sourceMessages = operation.type === 'append'
          ? coalesceAssistantResponseChunks(operation.messages as ClaudeChatMessageWithBlocks[])
          : operation.messages as ClaudeChatMessageWithBlocks[]
        const notYetProjected = operation.type === 'append' ? sourceMessages.filter((message) => {
          if (!message.id) return true
          const fact = facts.find((candidate) => candidate.id === message.id)
          return !fact || fact.sequence > lastSequence
        }) : sourceMessages
        const messages = projectCanonicalChatBodyV1(notYetProjected, facts, lastSequence, { allowLegacyBodyMismatch: true })
        const byId = new Map(facts.map((fact) => [fact.id, fact]))
        for (const message of messages) lastSequence = byId.get(message.id)?.sequence ?? lastSequence
        return Object.freeze({ type: operation.type, messages: Object.freeze(messages) })
      })
      return Object.freeze({ stateJson: JSON.stringify({ formatVersion: 1, canonicalStateJson: folded.stateJson, lastSequence } satisfies ChatBodyState),
        outputOperations: Object.freeze(outputOperations.filter((operation) => operation.type === 'replace' || operation.messages.length > 0)), resetOutput: folded.resetOutput })
    },
    finalize(stateJson: string) {
      const state = parseState(stateJson)
      const finalized = canonical.finalize(state.canonicalStateJson)
      return Object.freeze({ outputOperations: Object.freeze(finalized.outputOperations.map((candidate) => {
        const operation = candidate as { type?: unknown; messages?: unknown }
        if (operation.type !== 'append' || !Array.isArray(operation.messages)) throw new Error('CHAT_BODY_HISTORY_OPERATION_INVALID')
        return Object.freeze({ type: 'append', messages: Object.freeze(projectCanonicalChatBodyV1(
          operation.messages as ClaudeChatMessageWithBlocks[], [], state.lastSequence)) })
      })) })
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

function parseState(json: string): ChatBodyState {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('CHAT_BODY_REDUCER_CHECKPOINT_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CHAT_BODY_REDUCER_CHECKPOINT_INVALID')
  const state = value as Partial<ChatBodyState>
  if (state.formatVersion !== 1 || typeof state.canonicalStateJson !== 'string' || !Number.isSafeInteger(state.lastSequence) || state.lastSequence! < -1) {
    throw new Error('CHAT_BODY_REDUCER_CHECKPOINT_INVALID')
  }
  return state as ChatBodyState
}
