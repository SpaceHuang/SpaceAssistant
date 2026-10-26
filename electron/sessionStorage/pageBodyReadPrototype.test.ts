import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createProjectionChatBodyReducer } from './infrastructure/sqlite/projectionChatBodyReducer'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from './domain/projectionSource'

type Body = Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number; sequence: number }>
type Leaf = Readonly<{ firstSequence: number; lastSequence: number; entries: readonly Body[]; digest: string }>
type DirectoryNode = Readonly<{ firstSequence: number; lastSequence: number; children: readonly DirectoryNode[]; leaf?: Leaf; digest: string }>

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

function fixtureEvent(invocationId: string, sequence: number, kind: string, payload: unknown): ProjectionHistoryChunkEvent {
  return { invocationId, turnId: invocationId, sequence, eventId: `${invocationId}-${sequence}`, idempotencyKey: `${invocationId}-${sequence}`,
    schemaVersion: 1, kind, sessionSequence: sequence, commitOrder: sequence, createdAt: sequence, payloadJson: JSON.stringify(payload) }
}

describe('paged chat body read prototype (test only)', () => {
  it('matches the authoritative full reducer across compaction upserts, response chunks, and mixed body authority', () => {
    const events = [
      fixtureEvent('turn-1', 1, 'invocation-context-committed', { messages: [
        { id: 'u1', role: 'user', content: 'prompt', timestamp: 1 }, { id: 'a1', role: 'assistant', content: 'old answer', timestamp: 2 },
      ] }),
      fixtureEvent('turn-1', 2, 'model-response-committed', { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'new answer' }], timestamp: 2 } }),
      fixtureEvent('turn-1', 3, 'invocation-completed', { status: 'completed' }),
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
      fixtureEvent('turn-2', 3, 'model-response-committed', { message: { id: 'a2', role: 'assistant', content: [
        { type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } }, { type: 'text', text: 'final answer' },
      ], timestamp: 4 } }),
      fixtureEvent('turn-2', 4, 'invocation-completed', { status: 'completed' }),
    ]
    const facts: ProjectionMessageFact[] = [
      { id: 'u1', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'summary of prompt' },
      { id: 'a1', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'summary answer' },
      { id: 'u2', role: 'user', timestamp: 3, sequence: 2, queueScope: 'desktop', contentStorageState: 'canonical-backed-dual-write', writeMode: 'canonical', storedContent: 'next prompt' },
      { id: 'a2', role: 'assistant', timestamp: 4, sequence: 3, queueScope: 'desktop', contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' },
    ]
    const authoritative = reduceAll(events, facts)
    expect(authoritative.map(({ id, content }) => [id, content])).toEqual([
      ['u1', 'summary of prompt'], ['a1', 'summary answer'], ['u2', 'next prompt'], ['a2', 'final answer'],
    ])
    const indexed = buildPrototype(authoritative)
    expect(indexed.readPage(4, 2).page).toEqual(authoritative.slice(2, 4))
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
