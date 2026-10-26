import { createHash } from 'node:crypto'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import type { ProjectionWorkerSample } from '../../domain/projectionSource'
import type { VerifiedChatBody } from './projectionChatBodyCachePayload'
import { createProjectionChatBodyReducer } from './projectionChatBodyReducer'

export type ProjectionSourceEventDependency = Readonly<{
  eventId: string
  sequence: number
  sessionSequence: number
  schemaVersion: number
  kind: string
  digest: string
}>

export type ProjectionInvocationBodySources = Readonly<{
  invocationId: string
  workerThreadId?: number
  workerSample?: ProjectionWorkerSample
  replacesPriorMessages: boolean
  messages: readonly (VerifiedChatBody & Readonly<{ sequence: number }>)[]
  dependencies: readonly ProjectionSourceEventDependency[]
  dependencyManifestJson: string
  dependencyManifestDigest: string
  dependenciesByMessage: ReadonlyMap<string, readonly ProjectionSourceEventDependency[]>
  manifestDigestByMessage: ReadonlyMap<string, string>
}>

type Operation = Readonly<{ type?: unknown; messages?: unknown; updates?: unknown }>

/** Reduce one complete History invocation with the production chat-body reducer and retain its full source set. */
export function reduceProjectionInvocationChatBodySources(events: readonly ProjectionHistoryChunkEvent[],
  facts: readonly ProjectionMessageFact[]): ProjectionInvocationBodySources {
  if (!events.length) throw new Error('CHAT_BODY_SOURCE_EVENTS_EMPTY')
  const invocationId = events[0]!.invocationId
  let previousSequence = 0
  let previousSessionSequence = 0
  for (const event of events) {
    if (event.invocationId !== invocationId || event.sequence !== previousSequence + 1 ||
      !Number.isSafeInteger(event.sessionSequence) || event.sessionSequence <= previousSessionSequence ||
      !Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) throw new Error('CHAT_BODY_SOURCE_EVENT_ORDER_INVALID')
    previousSequence = event.sequence
    previousSessionSequence = event.sessionSequence
  }
  const factById = new Map(facts.map((fact) => [fact.id, fact]))
  if (factById.size !== facts.length) throw new Error('CHAT_BODY_SOURCE_FACT_DUPLICATE')
  const factSequences = new Set<number>()
  for (const fact of facts) {
    if (!Number.isSafeInteger(fact.sequence) || fact.sequence < 0 || factSequences.has(fact.sequence)) {
      throw new Error('CHAT_BODY_SOURCE_SEQUENCE_DUPLICATE')
    }
    factSequences.add(fact.sequence)
  }

  const reducer = createProjectionChatBodyReducer()
  const folded = reducer.fold(reducer.createState(), events, facts)
  const finalized = reducer.finalize(folded.stateJson)
  const messages = new Map<string, VerifiedChatBody>()
  const apply = (operations: readonly unknown[]) => {
    for (const value of operations) {
      if (!value || typeof value !== 'object') throw new Error('CHAT_BODY_SOURCE_OPERATION_INVALID')
      const operation = value as Operation
      if (operation.type === 'replace') messages.clear()
      if (operation.type === 'append' || operation.type === 'replace') {
        if (!Array.isArray(operation.messages)) throw new Error('CHAT_BODY_SOURCE_OPERATION_INVALID')
        for (const candidate of operation.messages) {
          if (!candidate || typeof candidate !== 'object') throw new Error('CHAT_BODY_SOURCE_MESSAGE_INVALID')
          const message = candidate as Partial<VerifiedChatBody>
          if (typeof message.id !== 'string' || !message.id || (message.role !== 'user' && message.role !== 'assistant') ||
            typeof message.content !== 'string' || !Number.isSafeInteger(message.timestamp)) throw new Error('CHAT_BODY_SOURCE_MESSAGE_INVALID')
          messages.set(message.id, { id: message.id, role: message.role, content: message.content, timestamp: message.timestamp! })
        }
        continue
      }
      if (operation.type === 'appendText') {
        if (!Array.isArray(operation.updates)) throw new Error('CHAT_BODY_SOURCE_OPERATION_INVALID')
        for (const value of operation.updates) {
          if (!value || typeof value !== 'object') throw new Error('CHAT_BODY_SOURCE_OPERATION_INVALID')
          const update = value as { id?: unknown; role?: unknown; text?: unknown }
          const previous = typeof update.id === 'string' ? messages.get(update.id) : undefined
          if (!previous || previous.role !== 'assistant' || update.role !== 'assistant' || typeof update.text !== 'string') {
            throw new Error('CHAT_BODY_SOURCE_APPEND_TARGET_MISSING')
          }
          messages.set(previous.id, { ...previous, content: previous.content + update.text })
        }
        continue
      }
      throw new Error('CHAT_BODY_SOURCE_OPERATION_INVALID')
    }
  }
  apply(folded.outputOperations)
  apply(finalized.outputOperations)

  const outputMessages: Array<VerifiedChatBody & Readonly<{ sequence: number }>> = []
  const seenSequences = new Set<number>()
  for (const message of messages.values()) {
    const fact = factById.get(message.id)
    if (!fact) throw new Error('CHAT_BODY_SOURCE_FACT_MISSING')
    if (!Number.isSafeInteger(fact.sequence) || fact.sequence < 0 || seenSequences.has(fact.sequence)) {
      throw new Error('CHAT_BODY_SOURCE_SEQUENCE_DUPLICATE')
    }
    seenSequences.add(fact.sequence)
    outputMessages.push({ ...message, sequence: fact.sequence })
  }
  outputMessages.sort((left, right) => factById.get(left.id)!.sequence - factById.get(right.id)!.sequence)

  const dependencies = Object.freeze(events.map((event) => Object.freeze({ eventId: event.eventId, sequence: event.sequence,
    sessionSequence: event.sessionSequence, schemaVersion: event.schemaVersion, kind: event.kind, digest: digestSourceEvent(event) })))
  const dependencyManifestJson = JSON.stringify({ formatVersion: 1, invocationId, dependencies })
  const dependencyManifestDigest = sha256(dependencyManifestJson)
  const dependenciesByMessage = new Map<string, readonly ProjectionSourceEventDependency[]>()
  const manifestDigestByMessage = new Map<string, string>()
  for (const message of outputMessages) {
    dependenciesByMessage.set(message.id, dependencies)
    manifestDigestByMessage.set(message.id, dependencyManifestDigest)
  }
  const replacesPriorMessages = folded.resetOutput || folded.outputOperations.some((operation) =>
    Boolean(operation && typeof operation === 'object' && 'type' in operation && operation.type === 'replace'))
  return Object.freeze({ invocationId, replacesPriorMessages, messages: Object.freeze(outputMessages), dependencies, dependencyManifestJson,
    dependencyManifestDigest, dependenciesByMessage, manifestDigestByMessage })
}

function digestSourceEvent(event: ProjectionHistoryChunkEvent): string {
  return sha256(JSON.stringify({ invocationId: event.invocationId, turnId: event.turnId, sequence: event.sequence,
    eventId: event.eventId, idempotencyKey: event.idempotencyKey, schemaVersion: event.schemaVersion, kind: event.kind,
    sessionSequence: event.sessionSequence, commitOrder: event.commitOrder, createdAt: event.createdAt, payloadJson: event.payloadJson }))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
