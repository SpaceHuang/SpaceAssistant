import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionMessageFact } from '../../domain/projectionSource'
import type { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { readProjectionHistoryChunkInWorker } from './projectionHistoryChunkWorkerClient'

type WorkerStagingBlobStore = Pick<ReturnType<typeof createSessionProjectionBlobStore>, 'withWorkerStaging'>

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
      if (result.stagedSegments?.length) return result
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
