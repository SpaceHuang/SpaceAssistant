import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionMessageFact } from '../../domain/projectionSource'
import type { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { readProjectionHistorySegmentItems, type ProjectionHistorySegmentDescriptor } from './projectionHistorySegmentReader'
import { readProjectionHistoryChunkInWorker } from './projectionHistoryChunkWorkerClient'

type WorkerStagingBlobStore = Pick<ReturnType<typeof createSessionProjectionBlobStore>, 'withWorkerStaging'>
const MAX_MATERIALIZED_SEGMENTED_SOURCE_PAGE_BYTES = 32 * 1024 * 1024

export type ProjectionInvocationSourceInput = Readonly<{
  events: readonly ProjectionHistoryChunkEvent[]
  messageFacts: readonly ProjectionMessageFact[]
}>

/** Production source stream: read one bounded page per worker and expose invocation-sized batches. */
export function readProjectionHistoryInvocationsInWorker(input: Readonly<{
  permit: ProjectionHistoryChunkPermit
  blobs: WorkerStagingBlobStore
  signal?: AbortSignal
  maxRows?: number
  maxBytes?: number
}>): AsyncGenerator<ProjectionInvocationSourceInput> {
  const maxRows = input.maxRows ?? 200
  const maxBytes = input.maxBytes ?? 256 * 1024
  return iterateProjectionHistoryInvocations(async (afterSessionSequence) => {
    const readInput = { afterSessionSequence, maxRows, maxBytes, ...(input.signal ? { signal: input.signal } : {}) }
    const page = await readProjectionHistoryChunkInWorker(input.permit, readInput)
    if (page.kind !== 'deferred-large') return page
    return input.blobs.withWorkerStaging(async (_promote, stage) => {
      const result = await readProjectionHistoryChunkInWorker(input.permit, {
        ...readInput, staging: { root: stage.root, tempLocator: stage.tempLocator, tempLocators: stage.allocate(15) },
      })
      if (result.kind !== 'staged-chunk') return result
      const staged = result.stagedBlob
      const locatorPath = path.join(stage.root, staged.tempLocator)
      const stat = await fs.lstat(locatorPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== staged.byteLength) {
        throw new Error('PROJECTION_SOURCE_BACKFILL_STAGED_PAGE_INVALID')
      }
      const bytes = await fs.readFile(locatorPath)
      if (createHash('sha256').update(bytes).digest('hex') !== staged.payloadDigest) {
        throw new Error('PROJECTION_SOURCE_BACKFILL_STAGED_PAGE_DIGEST_MISMATCH')
      }
      let payload: unknown
      try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('PROJECTION_SOURCE_BACKFILL_STAGED_PAGE_INVALID_JSON') }
      if (result.stagedSegments?.length) {
        return readSegmentedHistoryChunk(result, payload, stage.root)
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !Array.isArray((payload as { events?: unknown }).events) || !Array.isArray((payload as { messageFacts?: unknown }).messageFacts)) {
        throw new Error('PROJECTION_SOURCE_BACKFILL_STAGED_PAGE_SHAPE_INVALID')
      }
      const events = (payload as { events: ProjectionHistoryChunkEvent[] }).events
      const messageFacts = (payload as { messageFacts: ProjectionMessageFact[] }).messageFacts
      if (events.length !== result.rowCount || events.at(-1)?.sessionSequence !== result.nextSessionSequence) {
        throw new Error('PROJECTION_SOURCE_BACKFILL_STAGED_PAGE_COVERAGE_MISMATCH')
      }
      return Object.freeze({ kind: 'chunk' as const, permit: result.permit, afterSessionSequence: result.afterSessionSequence,
        nextSessionSequence: result.nextSessionSequence, events: Object.freeze(events), messageFacts: Object.freeze(messageFacts),
        byteLength: result.sourceByteLength, hasMore: result.hasMore })
    })
  }, 0)
}

async function readSegmentedHistoryChunk(
  result: Extract<ProjectionHistoryChunkResult, { kind: 'staged-chunk' }>, payload: unknown, root: string,
): Promise<ProjectionHistoryChunkResult> {
  if (result.sourceByteLength > MAX_MATERIALIZED_SEGMENTED_SOURCE_PAGE_BYTES || !payload || typeof payload !== 'object' ||
    Array.isArray(payload)) throw new Error('PROJECTION_SOURCE_BACKFILL_SEGMENTED_PAGE_TOO_LARGE')
  const manifest = payload as Record<string, unknown>
  const event = manifest.event as Partial<ProjectionHistoryChunkEvent> | undefined
  if (manifest.kind !== 'segmented-history-event' || !event || !Array.isArray(manifest.messageSegments) ||
    !Array.isArray(manifest.factSegments) || !Number.isSafeInteger(manifest.messageCount) ||
    !Number.isSafeInteger(manifest.factCount) || !manifest.extraPayload || typeof manifest.extraPayload !== 'object' ||
    Array.isArray(manifest.extraPayload) || typeof event.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(event.sourceDigest) ||
    typeof event.invocationId !== 'string' || !event.invocationId || typeof event.turnId !== 'string' || !event.turnId ||
    !Number.isSafeInteger(event.sequence) || !Number.isSafeInteger(event.sessionSequence) ||
    event.sessionSequence !== result.nextSessionSequence || typeof event.eventId !== 'string' || !event.eventId ||
    typeof event.idempotencyKey !== 'string' || !event.idempotencyKey || !Number.isSafeInteger(event.schemaVersion) ||
    typeof event.kind !== 'string' || !Number.isSafeInteger(event.commitOrder) || !Number.isSafeInteger(event.createdAt)) {
    throw new Error('PROJECTION_SOURCE_BACKFILL_SEGMENTED_PAGE_SHAPE_INVALID')
  }
  const segmentByLocator = new Map((result.stagedSegments ?? []).map((segment) => [segment.locator, segment]))
  const readVerified = async (descriptor: ProjectionHistorySegmentDescriptor): Promise<Buffer> => {
    const staged = segmentByLocator.get(descriptor.locator)
    if (!staged || staged.byteLength !== descriptor.byteLength || staged.payloadDigest !== descriptor.payloadDigest) {
      throw new Error('PROJECTION_SOURCE_BACKFILL_SEGMENT_REFERENCE_INVALID')
    }
    const segmentPath = path.join(root, staged.tempLocator)
    const stat = await fs.lstat(segmentPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== descriptor.byteLength) {
      throw new Error('PROJECTION_SOURCE_BACKFILL_SEGMENT_INVALID')
    }
    const bytes = await fs.readFile(segmentPath)
    if (createHash('sha256').update(bytes).digest('hex') !== descriptor.payloadDigest) {
      throw new Error('PROJECTION_SOURCE_BACKFILL_SEGMENT_DIGEST_MISMATCH')
    }
    return bytes
  }
  const messages: unknown[] = []
  for await (const message of readProjectionHistorySegmentItems<unknown>({ segments:
    manifest.messageSegments as ProjectionHistorySegmentDescriptor[], itemCount: manifest.messageCount as number, readVerified })) {
    messages.push(message)
  }
  const messageFacts: ProjectionMessageFact[] = []
  for await (const fact of readProjectionHistorySegmentItems<unknown>({ segments:
    manifest.factSegments as ProjectionHistorySegmentDescriptor[], itemCount: manifest.factCount as number, readVerified })) {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact) || typeof (fact as { id?: unknown }).id !== 'string') {
      throw new Error('PROJECTION_SOURCE_BACKFILL_SEGMENTED_FACT_INVALID')
    }
    messageFacts.push(fact as ProjectionMessageFact)
  }
  const eventPayload: Record<string, unknown> = { ...(manifest.extraPayload as Record<string, unknown>), messages }
  let requiredUserMessage: unknown
  if (manifest.requiredUserMessageRef !== undefined) {
    const reference = manifest.requiredUserMessageRef as { id?: unknown; messageIndex?: unknown }
    const referenced = messages[Number(reference?.messageIndex)]
    if (typeof reference?.id !== 'string' || !Number.isSafeInteger(reference.messageIndex) || !referenced ||
      typeof referenced !== 'object' || (referenced as { id?: unknown }).id !== reference.id) {
      throw new Error('PROJECTION_SOURCE_BACKFILL_REQUIRED_USER_REFERENCE_INVALID')
    }
    requiredUserMessage = referenced
  } else if (Array.isArray(manifest.requiredUserSegments)) {
    const requiredMessages: unknown[] = []
    for await (const item of readProjectionHistorySegmentItems<unknown>({ segments:
      manifest.requiredUserSegments as ProjectionHistorySegmentDescriptor[], itemCount: 1, readVerified })) requiredMessages.push(item)
    if (requiredMessages.length !== 1) throw new Error('PROJECTION_SOURCE_BACKFILL_REQUIRED_USER_SEGMENTS_INVALID')
    requiredUserMessage = requiredMessages[0]
  } else if (manifest.requiredUserMessage !== undefined) requiredUserMessage = manifest.requiredUserMessage
  if (requiredUserMessage !== undefined) eventPayload.requiredUserMessage = requiredUserMessage
  const hydratedEvent: ProjectionHistoryChunkEvent = { ...event as ProjectionHistoryChunkEvent,
    payloadJson: JSON.stringify(eventPayload), sourceDigest: event.sourceDigest }
  return Object.freeze({ kind: 'chunk', permit: result.permit, afterSessionSequence: result.afterSessionSequence,
    nextSessionSequence: result.nextSessionSequence, events: Object.freeze([hydratedEvent]),
    messageFacts: Object.freeze(messageFacts), byteLength: result.sourceByteLength, hasMore: result.hasMore })
}

/** Assemble one invocation at a time from bounded History pages. */
export async function* iterateProjectionHistoryInvocations(
  readPage: (afterSessionSequence: number) => Promise<ProjectionHistoryChunkResult>,
  initialSessionSequence: number,
): AsyncGenerator<ProjectionInvocationSourceInput> {
  if (!Number.isSafeInteger(initialSessionSequence) || initialSessionSequence < 0) {
    throw new Error('PROJECTION_SOURCE_BACKFILL_CURSOR_INVALID')
  }
  let cursor = initialSessionSequence
  let currentInvocationId: string | undefined
  let currentEvents: ProjectionHistoryChunkEvent[] = []
  let currentFacts = new Map<string, ProjectionMessageFact>()
  let previousInvocationSequence = 0
  let previousSessionSequence = initialSessionSequence

  const finishInvocation = (): ProjectionInvocationSourceInput | undefined => {
    if (!currentInvocationId) return undefined
    const result = Object.freeze({ events: Object.freeze(currentEvents),
      messageFacts: Object.freeze([...currentFacts.values()].sort((left, right) => left.sequence - right.sequence)) })
    currentInvocationId = undefined
    currentEvents = []
    currentFacts = new Map()
    previousInvocationSequence = 0
    return result
  }

  while (true) {
    const page = await readPage(cursor)
    if (page.afterSessionSequence !== cursor) throw new Error('PROJECTION_SOURCE_BACKFILL_PAGE_CURSOR_MISMATCH')
    if (page.kind === 'complete') {
      const completed = finishInvocation()
      if (completed) yield completed
      return
    }
    if (page.kind === 'staged-chunk') throw new Error('PROJECTION_SOURCE_BACKFILL_SEGMENTED_PAGE_UNSUPPORTED')
    if (page.kind !== 'chunk') {
      throw new Error(`PROJECTION_SOURCE_BACKFILL_PAGE_${page.kind.toUpperCase()}:${page.reason ?? 'unavailable'}`)
    }
    if (!page.events.length || page.nextSessionSequence <= cursor || page.nextSessionSequence !== page.events.at(-1)!.sessionSequence) {
      throw new Error('PROJECTION_SOURCE_BACKFILL_PAGE_ORDER_INVALID')
    }
    const factsByInvocation = new Map<string, Map<string, ProjectionMessageFact>>()
    const idsByInvocation = new Map<string, Set<string>>()
    for (const event of page.events) {
      if (!event.invocationId || !Number.isSafeInteger(event.sequence) || event.sessionSequence !== previousSessionSequence + 1) {
        throw new Error('PROJECTION_SOURCE_BACKFILL_PAGE_ORDER_INVALID')
      }
      const ids = idsByInvocation.get(event.invocationId) ?? new Set<string>()
      for (const id of referencedMessageIds(event)) ids.add(id)
      idsByInvocation.set(event.invocationId, ids)
      previousSessionSequence = event.sessionSequence
    }
    for (const [invocationId, ids] of idsByInvocation) {
      const selected = new Map<string, ProjectionMessageFact>()
      for (const fact of page.messageFacts) if (ids.has(fact.id)) selected.set(fact.id, fact)
      factsByInvocation.set(invocationId, selected)
    }

    for (const event of page.events) {
      if (currentInvocationId !== undefined && event.invocationId !== currentInvocationId) {
        const completed = finishInvocation()
        if (completed) yield completed
      }
      if (currentInvocationId === undefined) currentInvocationId = event.invocationId
      if (event.sequence !== previousInvocationSequence + 1) throw new Error('PROJECTION_SOURCE_BACKFILL_INVOCATION_ORDER_INVALID')
      previousInvocationSequence = event.sequence
      currentEvents.push(event)
      for (const fact of factsByInvocation.get(event.invocationId)?.values() ?? []) {
        const previous = currentFacts.get(fact.id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(fact)) {
          throw new Error('PROJECTION_SOURCE_BACKFILL_FACT_CHANGED')
        }
        currentFacts.set(fact.id, fact)
      }
    }
    cursor = page.nextSessionSequence
    if (!page.hasMore) {
      const completed = finishInvocation()
      if (completed) yield completed
      return
    }
  }
}

function referencedMessageIds(event: ProjectionHistoryChunkEvent): readonly string[] {
  let payload: unknown
  try { payload = JSON.parse(event.payloadJson) } catch { throw new Error('PROJECTION_SOURCE_BACKFILL_EVENT_INVALID_JSON') }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const record = payload as Record<string, unknown>
  const ids: string[] = []
  const add = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string' && id.trim()) ids.push(id)
  }
  if (event.kind === 'invocation-context-committed' || event.kind === 'transcript-compacted') {
    if (Array.isArray(record.messages)) record.messages.forEach(add)
    add(record.requiredUserMessage)
  } else if (event.kind === 'replay-message-committed' || event.kind === 'model-response-committed') add(record.message)
  return ids
}
