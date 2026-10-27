import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact, ProjectionWorkerSample } from '../../domain/projectionSource'
import type { VerifiedChatBody } from './projectionChatBodyCachePayload'
import { createProjectionChatBodyReducer } from './projectionChatBodyReducer'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'
import { reduceSegmentedChatBodyContext } from './projectionSegmentedChatBodyReducer'
import { readProjectionHistorySegmentItems, type ProjectionHistorySegmentDescriptor } from './projectionHistorySegmentReader'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'

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
  messages: readonly (Omit<VerifiedChatBody, 'content'> & Readonly<{ content?: string; sequence: number }>)[]
  dependencies: readonly ProjectionSourceEventDependency[]
  dependencyManifestJson: string
  dependencyManifestDigest: string
  dependenciesByMessage: ReadonlyMap<string, readonly ProjectionSourceEventDependency[]>
  manifestDigestByMessage: ReadonlyMap<string, string>
  stagedArtifacts?: Readonly<{ manifest: StagedProjectionSourceBlob;
    fragments: readonly Readonly<{ messageId: string; blob: StagedProjectionSourceBlob }>[] }>
}>

export type StagedProjectionSourceBlob = Readonly<{ tempLocator: string; locator: string; byteLength: number; payloadDigest: string }>
export type PreparedProjectionSourceBlob = Readonly<{ locator: string; byteLength: number; payloadDigest: string; release(): Promise<void> }>
export type PreparedProjectionSourceArtifactSet = Readonly<{ manifest: PreparedProjectionSourceBlob;
  fragmentsByMessage: ReadonlyMap<string, PreparedProjectionSourceBlob> }>
type Operation = Readonly<{ type?: unknown; messages?: unknown; updates?: unknown }>

export type SegmentedSourceHistoryPayload = Readonly<{
  kind: 'source-segmented-history-event'
  root: string
  messageCount: number
  messageSegments: readonly ProjectionHistorySegmentDescriptor[]
  factCount: number
  factSegments: readonly ProjectionHistorySegmentDescriptor[]
  extraPayload: Readonly<Record<string, unknown>>
  requiredUserMessage?: unknown
  requiredUserMessageRef?: Readonly<{ id: string; messageIndex: number }>
  requiredUserSegments?: readonly ProjectionHistorySegmentDescriptor[]
}>

/** Reduce a segmented transcript snapshot directly from verified files inside the source Worker. */
export async function reduceSegmentedProjectionInvocationChatBodySources(events: readonly ProjectionHistoryChunkEvent[],
  facts: readonly ProjectionMessageFact[], input: Readonly<{ segmented: SegmentedSourceHistoryPayload; reducerSpecVersion: number }>):
  Promise<ProjectionInvocationBodySources> {
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
  const sourceEvent = events.find((event) => event.payload && typeof event.payload === 'object' &&
    (event.payload as { kind?: unknown }).kind === 'source-segmented-history-event')
  if (!sourceEvent || (sourceEvent.kind !== 'invocation-context-committed' && sourceEvent.kind !== 'transcript-compacted') ||
    events.filter((event) => event.payload && typeof event.payload === 'object' &&
      (event.payload as { kind?: unknown }).kind === 'source-segmented-history-event').length !== 1) {
    throw new Error('CHAT_BODY_SOURCE_SEGMENTED_EVENT_INVALID')
  }
  const segmented = input.segmented
  if (!path.isAbsolute(segmented.root) || !Number.isSafeInteger(segmented.messageCount) || segmented.messageCount < 1 ||
    segmented.messageSegments.length < 1 || segmented.messageSegments.length > 15 ||
    !Number.isSafeInteger(segmented.factCount) || segmented.factCount < 0 ||
    (segmented.factCount === 0) !== (segmented.factSegments.length === 0) ||
    !segmented.extraPayload || typeof segmented.extraPayload !== 'object' ||
    !Number.isSafeInteger(input.reducerSpecVersion) || input.reducerSpecVersion < 1) {
    throw new Error('CHAT_BODY_SOURCE_SEGMENTED_MANIFEST_INVALID')
  }
  const allSegments = [...segmented.messageSegments, ...segmented.factSegments, ...(segmented.requiredUserSegments ?? [])]
  if (allSegments.length > 15 || new Set(allSegments.map(({ locator }) => locator)).size !== allSegments.length) {
    throw new Error('CHAT_BODY_SOURCE_SEGMENTED_MANIFEST_INVALID')
  }
  let segmentBytes = 0
  const readVerified = async (descriptor: ProjectionHistorySegmentDescriptor): Promise<Buffer> => {
    if (!/^projection-[0-9a-f-]{36}\.blob$/.test(descriptor.locator) || path.basename(descriptor.locator) !== descriptor.locator ||
      !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1 || descriptor.byteLength > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(descriptor.payloadDigest)) throw new Error('CHAT_BODY_SOURCE_SEGMENT_REFERENCE_INVALID')
    const filePath = path.join(segmented.root, descriptor.locator)
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== descriptor.byteLength) {
      throw new Error('CHAT_BODY_SOURCE_SEGMENT_INVALID')
    }
    const bytes = await fs.readFile(filePath)
    if (createHash('sha256').update(bytes).digest('hex') !== descriptor.payloadDigest) {
      throw new Error('CHAT_BODY_SOURCE_SEGMENT_DIGEST_MISMATCH')
    }
    segmentBytes += bytes.byteLength
    if (segmentBytes > 128 * 1024 * 1024) throw new Error('CHAT_BODY_SOURCE_SEGMENT_TOTAL_TOO_LARGE')
    return bytes
  }
  const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: input.reducerSpecVersion })
  let reductionFacts = [...facts]
  if (segmented.factCount > 0) {
    if (facts.length) throw new Error('CHAT_BODY_SOURCE_SEGMENTED_FACTS_DUPLICATE')
    reductionFacts = []
    for await (const raw of readProjectionHistorySegmentItems<unknown>({ segments: segmented.factSegments,
      itemCount: segmented.factCount, readVerified })) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as { id?: unknown }).id !== 'string' ||
        typeof (raw as { storedContent?: unknown }).storedContent !== 'string') {
        throw new Error('CHAT_BODY_SOURCE_SEGMENTED_FACT_INVALID')
      }
      reductionFacts.push(raw as ProjectionMessageFact)
    }
  }
  let requiredUserMessage = segmented.requiredUserMessage
  if (segmented.requiredUserSegments) {
    if (requiredUserMessage !== undefined) throw new Error('CHAT_BODY_SOURCE_SEGMENTED_REQUIRED_USER_INVALID')
    const requiredMessages: unknown[] = []
    for await (const raw of readProjectionHistorySegmentItems<unknown>({ segments: segmented.requiredUserSegments,
      itemCount: 1, readVerified })) requiredMessages.push(raw)
    if (requiredMessages.length !== 1) throw new Error('CHAT_BODY_SOURCE_SEGMENTED_REQUIRED_USER_INVALID')
    requiredUserMessage = requiredMessages[0]
  }
  const factById = new Map(reductionFacts.map((fact) => [fact.id, fact]))
  if (factById.size !== reductionFacts.length) throw new Error('CHAT_BODY_SOURCE_FACT_DUPLICATE')
  const messages: Array<VerifiedChatBody & Readonly<{ sequence: number }>> = []
  const reduction = await reduceSegmentedChatBodyContext({
    stateJson: createProjectionScopeHistoryReducer().createState(scopeKey),
    event: { ...sourceEvent, payloadJson: '', payload: { ...segmented.extraPayload, messages: [] } },
    messages: readProjectionHistorySegmentItems<unknown>({ segments: segmented.messageSegments,
      itemCount: segmented.messageCount, readVerified }),
    messageCount: segmented.messageCount,
    facts: reductionFacts,
    scopeKey,
    ...(requiredUserMessage ? { requiredUserMessage: requiredUserMessage as
      { id: string; message: import('../../../../packages/agent-sdk/src/model').CanonicalModelMessage } } : {}),
    ...(segmented.requiredUserMessageRef ? { requiredUserMessageRef: segmented.requiredUserMessageRef } : {}),
    onProjectedMessage: async (message) => {
      if (message.role !== 'user' && message.role !== 'assistant' || typeof message.content !== 'string' ||
        !Number.isSafeInteger(message.timestamp)) throw new Error('CHAT_BODY_SOURCE_SEGMENTED_MESSAGE_INVALID')
      const fact = factById.get(message.id)
      if (!fact) throw new Error('CHAT_BODY_SOURCE_FACT_MISSING')
      messages.push({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp, sequence: fact.sequence })
    },
  })
  void reduction
  messages.sort((left, right) => left.sequence - right.sequence)
  const dependencies = Object.freeze(events.map((event) => Object.freeze({ eventId: event.eventId, sequence: event.sequence,
    sessionSequence: event.sessionSequence, schemaVersion: event.schemaVersion, kind: event.kind, digest: digestSourceEvent(event) })))
  const dependencyManifestJson = JSON.stringify({ formatVersion: 1, invocationId, dependencies })
  const dependencyManifestDigest = sha256(dependencyManifestJson)
  const dependenciesByMessage = new Map<string, readonly ProjectionSourceEventDependency[]>()
  const manifestDigestByMessage = new Map<string, string>()
  for (const message of messages) {
    dependenciesByMessage.set(message.id, dependencies)
    manifestDigestByMessage.set(message.id, dependencyManifestDigest)
  }
  return Object.freeze({ invocationId, replacesPriorMessages: true, messages: Object.freeze(messages), dependencies,
    dependencyManifestJson, dependencyManifestDigest, dependenciesByMessage, manifestDigestByMessage })
}

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
  if (typeof event.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(event.sourceDigest)) return event.sourceDigest
  return sha256(JSON.stringify({ invocationId: event.invocationId, turnId: event.turnId, sequence: event.sequence,
    eventId: event.eventId, idempotencyKey: event.idempotencyKey, schemaVersion: event.schemaVersion, kind: event.kind,
    sessionSequence: event.sessionSequence, commitOrder: event.commitOrder, createdAt: event.createdAt, payloadJson: event.payloadJson }))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
