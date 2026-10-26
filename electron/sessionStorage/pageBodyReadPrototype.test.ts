import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createProjectionChatBodyReducer } from './infrastructure/sqlite/projectionChatBodyReducer'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from './domain/projectionSource'

type Body = Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number; sequence: number }>
type Leaf = Readonly<{ firstSequence: number; lastSequence: number; entries: readonly Body[]; digest: string }>
type DirectoryNode = Readonly<{ firstSequence: number; lastSequence: number; children: readonly DirectoryNode[]; leaf?: Leaf; digest: string }>
type IdDirectoryNode = Readonly<{ firstId: string; lastId: string; children: readonly IdDirectoryNode[];
  entries?: readonly Body[]; digest: string }>

const MAX_PROTOTYPE_BLOCK_BYTES = 256 * 1024
const MAX_PROTOTYPE_BLOCK_MESSAGES = 8

/** Test-only immutable block directory; counts every directory node and body record touched by a page read. */
function directoryDigest(firstSequence: number, lastSequence: number, children: readonly DirectoryNode[]): string {
  return createHash('sha256').update(JSON.stringify({ firstSequence, lastSequence, childDigests: children.map(({ digest }) => digest) }), 'utf8').digest('hex')
}

function buildPrototype(messages: readonly Body[], fanout = 8) {
  const leaves: Leaf[] = []
  let entries: Body[] = []
  const publishLeaf = () => {
    if (!entries.length) return
    leaves.push({ firstSequence: entries[0]!.sequence, lastSequence: entries.at(-1)!.sequence, entries,
      digest: digestBodyBlock(entries) })
    entries = []
  }
  for (const message of messages) {
    const candidate = [...entries, message]
    if (entries.length && (candidate.length > MAX_PROTOTYPE_BLOCK_MESSAGES || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_PROTOTYPE_BLOCK_BYTES)) {
      publishLeaf()
    }
    entries.push(message)
    if (Buffer.byteLength(JSON.stringify(entries), 'utf8') > MAX_PROTOTYPE_BLOCK_BYTES) publishLeaf()
  }
  publishLeaf()
  let level: DirectoryNode[] = leaves.map((leaf) => ({ firstSequence: leaf.firstSequence, lastSequence: leaf.lastSequence, children: [], leaf,
    digest: leaf.digest }))
  while (level.length > 1) {
    const next: DirectoryNode[] = []
    for (let offset = 0; offset < level.length; offset += fanout) {
      const children = level.slice(offset, offset + fanout)
      const firstSequence = children[0]!.firstSequence
      const lastSequence = children.at(-1)!.lastSequence
      next.push({ firstSequence, lastSequence, children, digest: directoryDigest(firstSequence, lastSequence, children) })
    }
    level = next
  }
  const root = level[0]
  return {
    corruptFirstBlockForTest() {
      const first = leaves[0]
      if (!first) throw new Error('prototype has no body block')
      const corrupted = [...first.entries]
      corrupted[0] = { ...corrupted[0]!, content: `${corrupted[0]!.content}!` }
      ;(first as { entries: readonly Body[] }).entries = corrupted
    },
    corruptDirectoryForTest() {
      if (!root || root.leaf) throw new Error('prototype has no directory node')
      ;(root as { children: readonly DirectoryNode[] }).children = root.children.slice(1)
    },
    blockByteLengths: () => leaves.map((leaf) => Buffer.byteLength(JSON.stringify(leaf.entries), 'utf8')),
    readPage(beforeSequence: number, limit: number) {
      let directoryNodesRead = 0
      let bodyRecordsRead = 0
      let bodyBytesRead = 0
      let directoryBytesRead = 0
      const selected: Body[] = []
      const visit = (node: DirectoryNode): void => {
        directoryNodesRead += 1
        directoryBytesRead += Buffer.byteLength(JSON.stringify({ firstSequence: node.firstSequence, lastSequence: node.lastSequence,
          childDigests: node.children.map(({ digest }) => digest) }), 'utf8')
        if (node.firstSequence >= beforeSequence || node.lastSequence < Math.max(0, beforeSequence - limit)) return
        if (node.leaf) {
          if (digestBodyBlock(node.leaf.entries) !== node.leaf.digest) throw new Error('PROTOTYPE_BODY_BLOCK_DIGEST_MISMATCH')
          bodyBytesRead += Buffer.byteLength(JSON.stringify(node.leaf.entries), 'utf8')
          for (const entry of node.leaf.entries) {
            bodyRecordsRead += 1
            if (entry.sequence >= Math.max(0, beforeSequence - limit) && entry.sequence < beforeSequence) selected.push(entry)
          }
          return
        }
        if (directoryDigest(node.firstSequence, node.lastSequence, node.children) !== node.digest) {
          throw new Error('PROTOTYPE_DIRECTORY_DIGEST_MISMATCH')
        }
        for (const child of node.children) visit(child)
      }
      if (root) visit(root)
      const page = selected.sort((a, b) => a.sequence - b.sequence)
      return { page, directoryNodesRead, bodyRecordsRead, bodyBytesRead, directoryBytesRead }
    }
  }
}

function digestBodyBlock(entries: readonly Body[]): string {
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex')
}

function digestSourceEvent(event: ProjectionHistoryChunkEvent): string {
  return createHash('sha256').update(JSON.stringify({ invocationId: event.invocationId, turnId: event.turnId,
    sequence: event.sequence, eventId: event.eventId, idempotencyKey: event.idempotencyKey, schemaVersion: event.schemaVersion,
    kind: event.kind, sessionSequence: event.sessionSequence, commitOrder: event.commitOrder, createdAt: event.createdAt,
    payloadJson: event.payloadJson }), 'utf8').digest('hex')
}

function digestSourceDependencies(dependencies: readonly Readonly<{ eventId: string; sequence: number; sessionSequence: number;
  schemaVersion: number; kind: string; digest: string }>[]): string {
  return createHash('sha256').update(JSON.stringify(dependencies), 'utf8').digest('hex')
}

function buildIdLookup(messages: readonly Body[]) {
  const sorted = [...messages].sort((left, right) => left.id.localeCompare(right.id))
  const leaves: IdDirectoryNode[] = []
  for (let offset = 0; offset < sorted.length; offset += MAX_PROTOTYPE_BLOCK_MESSAGES) {
    const entries = sorted.slice(offset, offset + MAX_PROTOTYPE_BLOCK_MESSAGES)
    leaves.push({ firstId: entries[0]!.id, lastId: entries.at(-1)!.id, children: [], entries, digest: digestBodyBlock(entries) })
  }
  let level = leaves
  while (level.length > 1) {
    const next: IdDirectoryNode[] = []
    for (let offset = 0; offset < level.length; offset += 8) {
      const children = level.slice(offset, offset + 8)
      const firstId = children[0]!.firstId
      const lastId = children.at(-1)!.lastId
      const digest = createHash('sha256').update(JSON.stringify({ firstId, lastId, childDigests: children.map(({ digest }) => digest) }), 'utf8').digest('hex')
      next.push({ firstId, lastId, children, digest })
    }
    level = next
  }
  const root = level[0]
  return {
    lookup(id: string) {
      let directoryNodesRead = 0
      let bodyRecordsRead = 0
      let directoryBytesRead = 0
      const visit = (node: IdDirectoryNode): Body | undefined => {
        directoryNodesRead += 1
        directoryBytesRead += Buffer.byteLength(JSON.stringify({ firstId: node.firstId, lastId: node.lastId,
          childDigests: node.children.map(({ digest }) => digest) }), 'utf8')
        if (id < node.firstId || id > node.lastId) return undefined
        if (node.entries) {
          bodyRecordsRead += node.entries.length
          if (digestBodyBlock(node.entries) !== node.digest) throw new Error('PROTOTYPE_ID_BLOCK_DIGEST_MISMATCH')
          return node.entries.find((entry) => entry.id === id)
        }
        const digest = createHash('sha256').update(JSON.stringify({ firstId: node.firstId, lastId: node.lastId,
          childDigests: node.children.map(({ digest }) => digest) }), 'utf8').digest('hex')
        if (digest !== node.digest) throw new Error('PROTOTYPE_ID_DIRECTORY_DIGEST_MISMATCH')
        for (const child of node.children) {
          if (id >= child.firstId && id <= child.lastId) return visit(child)
        }
        return undefined
      }
      const message = root ? visit(root) : undefined
      return { message, directoryNodesRead, bodyRecordsRead, directoryBytesRead }
    }
  }
}

function flattenOperations(operations: readonly unknown[]): Body[] {
  const result: Body[] = []
  for (const item of operations) {
    if (!item || typeof item !== 'object') continue
    const operation = item as { type?: string; messages?: Body[] }
    if (operation.type === 'replace') result.length = 0
    if ((operation.type === 'replace' || operation.type === 'append') && Array.isArray(operation.messages)) result.push(...operation.messages)
  }
  return result
}

function reduceAll(events: ProjectionHistoryChunkEvent[], facts: ProjectionMessageFact[]): Body[] {
  const reducer = createProjectionChatBodyReducer()
  const folded = reducer.fold(reducer.createState(), events, facts)
  const final = reducer.finalize(folded.stateJson)
  return flattenOperations([...folded.outputOperations, ...final.outputOperations]).map((message, sequence) => ({ ...message, sequence }))
}

function buildSourceFragmentPrototype(events: ProjectionHistoryChunkEvent[], facts: ProjectionMessageFact[]) {
  const factById = new Map(facts.map((fact) => [fact.id, fact]))
  const byInvocation = new Map<string, ProjectionHistoryChunkEvent[]>()
  for (const event of events) byInvocation.set(event.invocationId, [...(byInvocation.get(event.invocationId) ?? []), event])
  let currentSourceRevision = 1
  const dependencyManifests = new Map<string, { entries: readonly Readonly<{ eventId: string; sequence: number; sessionSequence: number;
    schemaVersion: number; kind: string; digest: string }>[]; digest: string }>()
  const fragments = new Map<string, { body: Body; invocationId: string; sourceEvent: ProjectionHistoryChunkEvent; sourceDigest: string;
    dependencyManifestDigest: string; sourceRevision: number; digest: string }>()
  for (const [invocationId, invocationEvents] of byInvocation) {
    const dependencies = Object.freeze(invocationEvents.map((event) => Object.freeze({ eventId: event.eventId, sequence: event.sequence,
      sessionSequence: event.sessionSequence, schemaVersion: event.schemaVersion, kind: event.kind, digest: digestSourceEvent(event) })))
    dependencyManifests.set(invocationId, { entries: dependencies, digest: digestSourceDependencies(dependencies) })
    const invocationOutput = reduceAll(invocationEvents, facts)
    for (const candidate of invocationOutput) {
      if (!candidate.id) continue
      const fact = factById.get(candidate.id)
      if (!fact) throw new Error(`prototype message fact missing: ${candidate.id}`)
      const body = { ...candidate, sequence: fact.sequence }
      const sourceEvent = [...invocationEvents].reverse().find((event) => {
        const payload = JSON.parse(event.payloadJson) as Record<string, unknown>
        const message = payload.message as { id?: unknown } | undefined
        const messages = payload.messages as Array<{ id?: unknown }> | undefined
        const requiredUserMessage = payload.requiredUserMessage as { id?: unknown } | undefined
        return message?.id === candidate.id || messages?.some(({ id }) => id === candidate.id) || requiredUserMessage?.id === candidate.id
      })
      if (!sourceEvent) throw new Error(`prototype source event missing: ${candidate.id}`)
      fragments.set(candidate.id, { body, invocationId, sourceEvent, sourceDigest: digestSourceEvent(sourceEvent),
        dependencyManifestDigest: dependencyManifests.get(invocationId)!.digest, sourceRevision: currentSourceRevision,
        digest: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex') })
    }
  }
  const pageIndex = buildPrototype([...fragments.values()].map(({ body }) => body).sort((left, right) => left.sequence - right.sequence))
  const readFragment = (messageId: string) => {
    const fragment = fragments.get(messageId)
    if (!fragment) return undefined
    if (fragment.sourceRevision !== currentSourceRevision) throw new Error('PROTOTYPE_SOURCE_REVISION_MISMATCH')
    if (createHash('sha256').update(JSON.stringify(fragment.body), 'utf8').digest('hex') !== fragment.digest) {
      throw new Error('PROTOTYPE_SOURCE_FRAGMENT_DIGEST_MISMATCH')
    }
    if (digestSourceEvent(fragment.sourceEvent) !== fragment.sourceDigest) {
      throw new Error('PROTOTYPE_SOURCE_EVENT_DIGEST_MISMATCH')
    }
    if (dependencyManifests.get(fragment.invocationId)?.digest !== fragment.dependencyManifestDigest) {
      throw new Error('PROTOTYPE_DEPENDENCY_MANIFEST_MISMATCH')
    }
    return fragment
  }
  return {
    get: readFragment,
    corruptFragmentForTest(messageId: string) {
      const fragment = fragments.get(messageId)
      if (!fragment) throw new Error(`prototype message fragment missing: ${messageId}`)
      fragment.body = { ...fragment.body, content: `${fragment.body.content}!` }
    },
    corruptSourceEventForTest(messageId: string) {
      const fragment = fragments.get(messageId)
      if (!fragment) throw new Error(`prototype message fragment missing: ${messageId}`)
      fragment.sourceEvent = { ...fragment.sourceEvent, payloadJson: `${fragment.sourceEvent.payloadJson}!` }
    },
    corruptDependencyEventForTest(messageId: string, eventId: string) {
      const fragment = fragments.get(messageId)
      if (!fragment) throw new Error(`prototype message fragment missing: ${messageId}`)
      const events = byInvocation.get(fragment.invocationId) ?? []
      const index = events.findIndex((event) => event.eventId === eventId)
      if (index < 0) throw new Error(`prototype dependency event missing: ${eventId}`)
      events[index] = { ...events[index]!, payloadJson: `${events[index]!.payloadJson}!` }
      currentSourceRevision += 1
    },
    getDependencyRecordsForTest(messageId: string) {
      const fragment = fragments.get(messageId)
      if (!fragment) return undefined
      return dependencyManifests.get(fragment.invocationId)?.entries
    },
    corruptDependencyManifestForTest(messageId: string) {
      const fragment = fragments.get(messageId)
      if (!fragment) throw new Error(`prototype message fragment missing: ${messageId}`)
      const manifest = dependencyManifests.get(fragment.invocationId)
      if (!manifest) throw new Error(`prototype dependency manifest missing: ${fragment.invocationId}`)
      manifest.digest = '0'.repeat(64)
    },
    readPage(beforeSequence: number, limit: number): Body[] {
      return pageIndex.readPage(beforeSequence, limit).page.map(({ id }) => readFragment(id)!.body)
    }
  }
}

function fixtureEvent(invocationId: string, sequence: number, kind: string, payload: unknown): ProjectionHistoryChunkEvent {
  return { invocationId, turnId: invocationId, sequence, eventId: `${invocationId}-${sequence}`, idempotencyKey: `${invocationId}-${sequence}`,
    schemaVersion: 1, kind, sessionSequence: sequence, commitOrder: sequence, createdAt: sequence, payloadJson: JSON.stringify(payload) }
}

describe('paged chat body read prototype (test only)', () => {
  it('matches the authoritative full reducer across compaction upserts, response chunks, and mixed body authority', () => {
    const events = [
      fixtureEvent('turn-1', 1, 'invocation-context-committed', { messages: [
        { id: 'u1', role: 'user', content: 'prompt', timestamp: 1 },
      ] }),
      fixtureEvent('turn-1', 2, 'model-response-committed', { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'new ' }], timestamp: 2 } }),
      fixtureEvent('turn-1', 3, 'model-response-committed', { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 } }),
      fixtureEvent('turn-1', 4, 'invocation-completed', { status: 'completed' }),
      fixtureEvent('turn-2', 1, 'invocation-context-committed', { messages: [
        { id: 'u1', role: 'user', content: 'prompt', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'new answer' }], timestamp: 2 },
        { id: 'u2', role: 'user', content: 'next prompt', timestamp: 3 },
      ] }),
      fixtureEvent('turn-2', 2, 'transcript-compacted', { messages: [
        { id: 'u1', role: 'user', content: 'summary of prompt', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'summary answer' }], timestamp: 2 },
        { id: 'u2', role: 'user', content: 'next prompt', timestamp: 3 },
      ] }),
      fixtureEvent('turn-2', 3, 'replay-message-committed', { message: { id: 'u3', role: 'user', content: [
        { type: 'text', text: 'image prompt' }, { type: 'image', mimeType: 'image/png', data: 'YQ==' },
      ], timestamp: 4 } }),
      fixtureEvent('turn-2', 4, 'model-response-committed', { message: { id: 'a2', role: 'assistant', content: [
        { type: 'image', mimeType: 'image/png', data: 'YQ==' }, { type: 'text', text: 'final answer' },
      ], toolCalls: [{ id: 'call-1', name: 'lookup', input: { q: 'x' } }], timestamp: 5 } }),
      fixtureEvent('turn-2', 5, 'tool-call-finished', { toolCallId: 'call-1', replayContent: 'lookup result' }),
      fixtureEvent('turn-2', 6, 'invocation-completed', { status: 'completed' }),
    ]
    const facts: ProjectionMessageFact[] = [
      { id: 'u1', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'summary of prompt' },
      { id: 'a1', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' },
      { id: 'u2', role: 'user', timestamp: 3, sequence: 2, queueScope: 'desktop', contentStorageState: 'canonical-backed-dual-write', writeMode: 'canonical', storedContent: 'next prompt' },
      { id: 'u3', role: 'user', timestamp: 4, sequence: 3, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'image prompt' },
      { id: 'a2', role: 'assistant', timestamp: 5, sequence: 4, queueScope: 'desktop', contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' },
    ]
    const authoritative = reduceAll(events, facts)
    expect(authoritative.map(({ id, content }) => [id, content])).toEqual([
      ['u1', 'summary of prompt'], ['a1', 'summary answer'], ['u2', 'next prompt'], ['u3', 'image prompt'], ['a2', 'final answer'],
    ])
    const indexed = buildPrototype(authoritative)
    expect(indexed.readPage(5, 2).page).toEqual(authoritative.slice(3, 5))
    const firstInvocationIndex = buildSourceFragmentPrototype(events.filter(({ invocationId }) => invocationId === 'turn-1'), facts.slice(0, 2))
    expect(firstInvocationIndex.get('a1')?.body.content).toBe('new answer')
    const sourceIndex = buildSourceFragmentPrototype(events, facts)
    expect(sourceIndex.readPage(5, 5)).toEqual(authoritative)
    expect(sourceIndex.get('u1')).toMatchObject({ invocationId: 'turn-2',
      sourceEvent: { eventId: 'turn-2-2', sequence: 2, sessionSequence: 2, schemaVersion: 1, kind: 'transcript-compacted' },
      body: { content: 'summary of prompt' } })
    expect(sourceIndex.get('u3')).toMatchObject({ sourceEvent: { eventId: 'turn-2-3', kind: 'replay-message-committed' },
      body: { content: 'image prompt' } })
    expect(sourceIndex.getDependencyRecordsForTest('a2')?.map(({ eventId }) => eventId)).toContain('turn-2-5')
    expect(sourceIndex.get('u1')?.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(sourceIndex.getDependencyRecordsForTest('a1')?.map(({ eventId }) => eventId)).toEqual(['turn-2-1', 'turn-2-2', 'turn-2-3', 'turn-2-4', 'turn-2-5', 'turn-2-6'])
    expect(sourceIndex.getDependencyRecordsForTest('a1')?.every(({ digest }) => /^[a-f0-9]{64}$/.test(digest))).toBe(true)
  })

  it('rejects a source body fragment whose digest no longer matches', () => {
    const events = [
      fixtureEvent('turn-1', 1, 'invocation-context-committed', { messages: [{ id: 'u1', role: 'user', content: 'prompt', timestamp: 1 }] }),
      fixtureEvent('turn-1', 2, 'invocation-completed', { status: 'completed' }),
    ]
    const facts: ProjectionMessageFact[] = [
      { id: 'u1', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'prompt' },
    ]
    const index = buildSourceFragmentPrototype(events, facts)
    index.corruptFragmentForTest('u1')
    expect(() => index.get('u1')).toThrow('PROTOTYPE_SOURCE_FRAGMENT_DIGEST_MISMATCH')
  })

  it('rejects a changed source event or reducer dependency for an indexed message', () => {
    const createIndex = () => buildSourceFragmentPrototype([
      fixtureEvent('turn-1', 1, 'invocation-context-committed', { messages: [{ id: 'u1', role: 'user', content: 'prompt', timestamp: 1 }] }),
      fixtureEvent('turn-1', 2, 'invocation-completed', { status: 'completed' }),
    ], [{ id: 'u1', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'prompt' }])

    const sourceIndex = createIndex()
    sourceIndex.corruptSourceEventForTest('u1')
    expect(() => sourceIndex.get('u1')).toThrow('PROTOTYPE_SOURCE_EVENT_DIGEST_MISMATCH')

    const dependencyIndex = createIndex()
    dependencyIndex.corruptDependencyEventForTest('u1', 'turn-1-2')
    expect(() => dependencyIndex.get('u1')).toThrow('PROTOTYPE_SOURCE_REVISION_MISMATCH')

    const manifestIndex = createIndex()
    manifestIndex.corruptDependencyManifestForTest('u1')
    expect(() => manifestIndex.get('u1')).toThrow('PROTOTYPE_DEPENDENCY_MANIFEST_MISMATCH')
  })

  it('locates a required user message whose stable ID is carried outside the snapshot message', () => {
    const events = [
      fixtureEvent('turn-required', 1, 'invocation-context-committed', { messages: [{ role: 'user', content: 'required task', timestamp: 1 }],
        requiredUserMessage: { id: 'required-user', message: { role: 'user', content: 'required task', timestamp: 1 } } }),
      fixtureEvent('turn-required', 2, 'invocation-completed', { status: 'completed' }),
    ]
    const facts: ProjectionMessageFact[] = [
      { id: 'required-user', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'required task' },
    ]
    expect(reduceAll(events, facts)).toMatchObject([{ id: 'required-user', content: 'required task' }])
    const index = buildSourceFragmentPrototype(events, facts)
    expect(index.get('required-user')).toMatchObject({ sourceEvent: { eventId: 'turn-required-1' } })
  })

  it('keeps page directory and body reads bounded when unrelated history grows tenfold', () => {
    const small: Body[] = Array.from({ length: 1_000 }, (_, sequence) => ({ id: `m${sequence}`, role: (sequence % 2 ? 'assistant' : 'user') as Body['role'],
      content: `body-${sequence}`, timestamp: sequence, sequence }))
    const large: Body[] = Array.from({ length: 10_000 }, (_, sequence) => ({ id: `m${sequence}`, role: (sequence % 2 ? 'assistant' : 'user') as Body['role'],
      content: `body-${sequence}`, timestamp: sequence, sequence }))
    const smallRead = buildPrototype(small).readPage(1_000, 20)
    const largeRead = buildPrototype(large).readPage(10_000, 20)
    expect(largeRead.page).toEqual(large.slice(-20))
    expect(largeRead.directoryNodesRead).toBe(23)
    expect(largeRead.bodyRecordsRead).toBe(24)
    expect(largeRead.bodyBytesRead).toBeLessThanOrEqual(smallRead.bodyBytesRead + 128)
    expect(largeRead.directoryBytesRead).toBeLessThan(10 * 1024)
    expect(largeRead.bodyRecordsRead).toBeLessThanOrEqual(32)
    expect(largeRead.directoryNodesRead).toBeLessThanOrEqual(32)
    expect(largeRead.bodyRecordsRead).toBe(smallRead.bodyRecordsRead)
  })

  it('looks up one message by ID through a bounded secondary directory after tenfold history growth', () => {
    const makeMessages = (count: number): Body[] => Array.from({ length: count }, (_, sequence) => ({ id: `m${String(sequence).padStart(5, '0')}`,
      role: 'user', content: `body-${sequence}`, timestamp: sequence, sequence }))
    const smallIndex = buildIdLookup(makeMessages(1_000))
    const largeIndex = buildIdLookup(makeMessages(10_000))
    const small = smallIndex.lookup('m00999')
    const large = largeIndex.lookup('m09999')
    expect(large.message?.content).toBe('body-9999')
    expect(large.directoryNodesRead).toBeLessThanOrEqual(5)
    expect(large.bodyRecordsRead).toBeLessThanOrEqual(MAX_PROTOTYPE_BLOCK_MESSAGES)
    expect(large.directoryBytesRead).toBeLessThan(2_048)
    expect(small.bodyRecordsRead).toBeLessThanOrEqual(MAX_PROTOTYPE_BLOCK_MESSAGES)
  })

  it('rejects a body block whose independently stored digest no longer matches', () => {
    const messages: Body[] = Array.from({ length: 16 }, (_, sequence) => ({ id: `m${sequence}`, role: 'user',
      content: `body-${sequence}`, timestamp: sequence, sequence }))
    const indexed = buildPrototype(messages)
    indexed.corruptFirstBlockForTest()
    expect(() => indexed.readPage(8, 8)).toThrow('PROTOTYPE_BODY_BLOCK_DIGEST_MISMATCH')
  })

  it('caps ordinary body blocks by bytes and item count while isolating one oversized message', () => {
    const messages: Body[] = Array.from({ length: 20 }, (_, sequence) => ({ id: `large-${sequence}`, role: 'user',
      content: 'x'.repeat(40 * 1024), timestamp: sequence, sequence }))
    messages[10] = { ...messages[10]!, content: 'y'.repeat(300 * 1024) }
    const indexed = buildPrototype(messages)
    expect(indexed.blockByteLengths().filter((byteLength) => byteLength > MAX_PROTOTYPE_BLOCK_BYTES)).toEqual([
      Buffer.byteLength(JSON.stringify([messages[10]]), 'utf8'),
    ])
    expect(indexed.readPage(20, 20).page).toEqual(messages)
  })

  it('rejects a corrupted directory before returning a page', () => {
    const messages: Body[] = Array.from({ length: 32 }, (_, sequence) => ({ id: `directory-${sequence}`, role: 'user',
      content: `body-${sequence}`, timestamp: sequence, sequence }))
    const indexed = buildPrototype(messages)
    indexed.corruptDirectoryForTest()
    expect(() => indexed.readPage(32, 20)).toThrow('PROTOTYPE_DIRECTORY_DIGEST_MISMATCH')
  })

  it('records why turn-only lookup is incomplete: a later compaction can rewrite an older message ID', () => {
    const turns = new Map([['turn-1', ['u1', 'a1']], ['turn-2', ['u2', 'a2']]])
    const laterCompaction = { invocationId: 'turn-2', kind: 'transcript-compacted', messageIds: ['u1', 'a1', 'u2'] }
    expect(turns.get(laterCompaction.invocationId)).not.toContain('u1')
    expect(laterCompaction.messageIds).toContain('u1')
    expect(reduceAll([
      fixtureEvent('turn-1', 1, 'invocation-context-committed', { messages: [{ id: 'u1', role: 'user', content: 'old', timestamp: 1 }] }),
      fixtureEvent('turn-1', 2, 'invocation-completed', { status: 'completed' }),
      fixtureEvent('turn-2', 1, 'transcript-compacted', { messages: [{ id: 'u1', role: 'user', content: 'rewritten', timestamp: 1 }] }),
    ], [{ id: 'u1', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop',
      contentStorageState: 'legacy', writeMode: null, storedContent: 'rewritten' }])).toMatchObject([{ id: 'u1', content: 'rewritten' }])
  })
})
