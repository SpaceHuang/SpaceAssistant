import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { VerifiedChatBody } from './projectionChatBodyCachePayload'
import type { StagedProjectionBlob, createSessionProjectionBlobStore } from './sessionProjectionBlobStore'

type ProjectionBlobStore = ReturnType<typeof createSessionProjectionBlobStore>
type BlobRef = Readonly<{ locator: string; byteLength: number; payloadDigest: string }>
type SequencedBody = Readonly<{ sequence: number; message: VerifiedChatBody }>
type BodyBlockEntry = Readonly<{ sequence: number; message: VerifiedChatBody }>
type BodyBlockRef = Readonly<{ first: number; last: number; count: number; blob: BlobRef }>
type DirectoryChild = Readonly<{ first: number | string; last: number | string; blob: BlobRef }>
type DirectoryEntry = Readonly<{ first: number | string; last: number | string; blob: BlobRef; count?: number;
  id?: string; sequence?: number; index?: number }>

const FORMAT_VERSION = 1 as const
const BODY_BLOCK_MAX_MESSAGES = 64
const BODY_BLOCK_MAX_BYTES = 256 * 1024
const DIRECTORY_FANOUT = 8
const ID_DIRECTORY_LEAF_SIZE = 512
const MAX_PAGE_SIZE = 200

export type PagedChatBodyManifest = Readonly<{
  formatVersion: 1
  sessionId: string
  sessionGeneration: string
  specVersion: number
  sourceRevision: number
  messageRevision: number | null
  sourceIdentityJson: string
  historyWatermarkJson: string
  messageCount: number
  firstSequence: number
  lastSequence: number
  sequenceRoot: BlobRef
  idRoot: BlobRef
  manifestDigest: string
}>

export type PagedChatBodyWriteInput = Readonly<{
  sessionId: string
  sessionGeneration: string
  specVersion: number
  sourceRevision: number
  messageRevision: number | null
  sourceIdentityJson: string
  historyWatermarkJson: string
  messages: readonly (VerifiedChatBody & { sequence?: number })[]
}>

function fail(code: string): never {
  throw Object.assign(new Error(code), { code })
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableIdCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isBlobRef(value: unknown): value is BlobRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return typeof ref.locator === 'string' && /^projection-[0-9a-f-]{36}\.blob$/.test(ref.locator) &&
    Number.isSafeInteger(ref.byteLength) && (ref.byteLength as number) > 0 &&
    typeof ref.payloadDigest === 'string' && /^[a-f0-9]{64}$/.test(ref.payloadDigest)
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function assertManifest(manifest: PagedChatBodyManifest): void {
  if (!manifest || manifest.formatVersion !== FORMAT_VERSION || typeof manifest.sessionId !== 'string' || !manifest.sessionId ||
    typeof manifest.sessionGeneration !== 'string' || !manifest.sessionGeneration || !Number.isSafeInteger(manifest.specVersion) ||
    (manifest.specVersion as number) < 1 || !Number.isSafeInteger(manifest.sourceRevision) || (manifest.sourceRevision as number) < 0 ||
    (manifest.messageRevision !== null && (!Number.isSafeInteger(manifest.messageRevision) || manifest.messageRevision < 0)) ||
    typeof manifest.sourceIdentityJson !== 'string' || typeof manifest.historyWatermarkJson !== 'string' ||
    !Number.isSafeInteger(manifest.messageCount) || (manifest.messageCount as number) < 1 ||
    !Number.isSafeInteger(manifest.firstSequence) || !Number.isSafeInteger(manifest.lastSequence) ||
    manifest.firstSequence < 0 || manifest.lastSequence < manifest.firstSequence ||
    !isBlobRef(manifest.sequenceRoot) || !isBlobRef(manifest.idRoot) || !/^[a-f0-9]{64}$/.test(manifest.manifestDigest)) {
    fail('PAGED_CHAT_BODY_MANIFEST_INVALID')
  }
  if (Object.keys(manifest).sort().join(',') !== 'firstSequence,formatVersion,historyWatermarkJson,idRoot,lastSequence,manifestDigest,messageCount,messageRevision,sequenceRoot,sessionGeneration,sessionId,sourceIdentityJson,sourceRevision,specVersion') {
    fail('PAGED_CHAT_BODY_MANIFEST_INVALID')
  }
  try {
    const identity = JSON.parse(manifest.sourceIdentityJson) as { sessionGeneration?: unknown; messageRevision?: unknown; historyWatermark?: unknown }
    if (!identity || identity.sessionGeneration !== manifest.sessionGeneration || identity.messageRevision !== manifest.messageRevision ||
      JSON.stringify(identity.historyWatermark ?? null) !== manifest.historyWatermarkJson) fail('PAGED_CHAT_BODY_MANIFEST_INVALID')
  } catch { fail('PAGED_CHAT_BODY_MANIFEST_INVALID') }
  const { manifestDigest, ...payload } = manifest
  if (digest(json(payload)) !== manifestDigest) fail('PAGED_CHAT_BODY_MANIFEST_INVALID')
}

function assertBody(message: VerifiedChatBody & { sequence?: number }, allowSequenceField = false): void {
  const fields = Object.keys(message ?? {}).sort().join(',')
  if (!message || typeof message.id !== 'string' || !message.id ||
    (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' ||
    !Number.isSafeInteger(message.timestamp) || (fields !== 'content,id,role,timestamp' &&
      !(allowSequenceField && fields === 'content,id,role,sequence,timestamp' && Number.isSafeInteger(message.sequence)))) fail('PAGED_CHAT_BODY_MESSAGE_INVALID')
}

function makeBodyBlocks(entries: readonly SequencedBody[]): SequencedBody[][] {
  const blocks: SequencedBody[][] = []
  let current: SequencedBody[] = []
  const encodedSize = (items: readonly SequencedBody[]) => Buffer.byteLength(json({ formatVersion: FORMAT_VERSION, kind: 'body-block', entries: items }), 'utf8')
  for (const entry of entries) {
    if (current.length > 0 && (current.length >= BODY_BLOCK_MAX_MESSAGES || encodedSize([...current, entry]) > BODY_BLOCK_MAX_BYTES)) {
      blocks.push(current)
      current = []
    }
    current.push(entry)
    if (current.length === 1 && encodedSize(current) > BODY_BLOCK_MAX_BYTES) {
      blocks.push(current)
      current = []
    }
  }
  if (current.length) blocks.push(current)
  return blocks
}

export function createPagedChatBodyStore(blobs: ProjectionBlobStore) {
  async function readDirectory(ref: BlobRef, kind: 'sequence' | 'id'): Promise<Readonly<{ first: number | string; last: number | string; children?: readonly DirectoryChild[]; entries?: readonly DirectoryEntry[] }>> {
    const raw = await blobs.readVerified(ref)
    let node: Record<string, unknown>
    try { node = JSON.parse(raw) as Record<string, unknown> }
    catch { return fail('PAGED_CHAT_BODY_DIRECTORY_INVALID') }
    if (!node || node.formatVersion !== FORMAT_VERSION || node.kind !== `${kind}-directory` ||
      (typeof node.first !== 'number' && typeof node.first !== 'string') ||
      (typeof node.last !== 'number' && typeof node.last !== 'string') || node.first > node.last) {
      fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
    }
    const leaf = Array.isArray(node.entries)
    const values = (leaf ? node.entries : node.children) as unknown[]
    const maxEntries = leaf ? (kind === 'id' ? ID_DIRECTORY_LEAF_SIZE : DIRECTORY_FANOUT) : DIRECTORY_FANOUT
    if (leaf === Array.isArray(node.children) || values.length < 1 || values.length > maxEntries) {
      fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
    }
    const directoryValues = values as Array<Record<string, unknown>>
    let priorLast: number | string | undefined
    for (const value of directoryValues) {
      const expectedFields = leaf
        ? (kind === 'id' ? 'blob,first,id,index,last,sequence' : 'blob,count,first,last')
        : 'blob,first,last'
      if (Object.keys(value).sort().join(',') !== expectedFields) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
      const first = leaf ? value.first : value.first
      const last = leaf ? value.last : value.last
      if ((typeof first !== 'number' && typeof first !== 'string') || (typeof last !== 'number' && typeof last !== 'string') ||
        first > last || (priorLast !== undefined && priorLast >= first) || !isBlobRef(value.blob)) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
      if (kind === 'sequence' && (typeof first !== 'number' || typeof last !== 'number')) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
      if (kind === 'id' && (typeof first !== 'string' || typeof last !== 'string')) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
      if (leaf && kind === 'sequence' && (!Number.isSafeInteger(value.count) || (value.count as number) < 1)) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
      if (leaf && kind === 'id' && (value.id !== first || first !== last || !Number.isSafeInteger(value.sequence) ||
        !Number.isSafeInteger(value.index) || (value.index as number) < 0 || value.count !== undefined)) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
      priorLast = last
    }
    if (directoryValues[0]!.first !== node.first || directoryValues.at(-1)!.last !== node.last) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
    return { first: node.first as number | string, last: node.last as number | string,
      ...(leaf ? { entries: directoryValues as unknown as readonly DirectoryEntry[] } : { children: directoryValues as unknown as readonly DirectoryChild[] }) }
  }

  async function collectDirectory(ref: BlobRef, kind: 'sequence' | 'id', first: number | string, last: number | string,
    output: DirectoryEntry[]): Promise<void> {
    const node = await readDirectory(ref, kind)
    if (last < node.first || first > node.last) return
    if (node.entries) {
      for (const entry of node.entries) if (entry.last >= first && entry.first <= last) output.push(entry)
      return
    }
    for (const child of node.children!) {
      if (last < child.first || first > child.last) continue
      await collectDirectory(child.blob, kind, first, last, output)
    }
  }

  async function readBodyBlock(ref: BlobRef, expectedCount?: number, expectedFirst?: number, expectedLast?: number): Promise<readonly BodyBlockEntry[]> {
    const raw = await blobs.readVerified(ref)
    let envelope: Record<string, unknown>
    try { envelope = JSON.parse(raw) as Record<string, unknown> }
    catch { return fail('PAGED_CHAT_BODY_BLOCK_INVALID') }
    if (!envelope || envelope.formatVersion !== FORMAT_VERSION || envelope.kind !== 'body-block' || !Array.isArray(envelope.entries) ||
      Object.keys(envelope).sort().join(',') !== 'entries,formatVersion,kind' ||
      envelope.entries.length < 1 || envelope.entries.length > BODY_BLOCK_MAX_MESSAGES ||
      (expectedCount !== undefined && envelope.entries.length !== expectedCount)) fail('PAGED_CHAT_BODY_BLOCK_INVALID')
    let priorSequence = -1
    const ids = new Set<string>()
    const entries: BodyBlockEntry[] = []
    for (const rawEntry of envelope.entries as unknown[]) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) fail('PAGED_CHAT_BODY_BLOCK_INVALID')
      const entry = rawEntry as Record<string, unknown>
      if (Object.keys(entry).sort().join(',') !== 'message,sequence' || !entry.message || typeof entry.message !== 'object' || Array.isArray(entry.message) ||
        Object.keys(entry.message as Record<string, unknown>).sort().join(',') !== 'content,id,role,timestamp') fail('PAGED_CHAT_BODY_BLOCK_INVALID')
      if (!Number.isSafeInteger(entry.sequence) || (entry.sequence as number) <= priorSequence) fail('PAGED_CHAT_BODY_BLOCK_INVALID')
      assertBody(entry.message as VerifiedChatBody)
      if (ids.has((entry.message as VerifiedChatBody).id)) fail('PAGED_CHAT_BODY_BLOCK_INVALID')
      ids.add((entry.message as VerifiedChatBody).id)
      entries.push(Object.freeze({ sequence: entry.sequence as number, message: Object.freeze({ ...(entry.message as VerifiedChatBody) }) }))
      priorSequence = entry.sequence as number
    }
    if ((expectedFirst !== undefined && entries[0]!.sequence !== expectedFirst) ||
      (expectedLast !== undefined && entries.at(-1)!.sequence !== expectedLast)) fail('PAGED_CHAT_BODY_BLOCK_INVALID')
    return Object.freeze(entries)
  }

  return {
    async write(input: PagedChatBodyWriteInput): Promise<Readonly<{ manifest: PagedChatBodyManifest;
      blobReferences: readonly Readonly<BlobRef & { kind: 'body-block' | 'sequence-directory' | 'id-directory' }>[];
      release(): Promise<void> }>> {
      if (!input || typeof input.sessionId !== 'string' || !input.sessionId || typeof input.sessionGeneration !== 'string' || !input.sessionGeneration ||
        !Number.isSafeInteger(input.specVersion) || input.specVersion < 1 || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0 ||
        (input.messageRevision !== null && (!Number.isSafeInteger(input.messageRevision) || input.messageRevision < 0)) ||
        typeof input.sourceIdentityJson !== 'string' || typeof input.historyWatermarkJson !== 'string' ||
        !Array.isArray(input.messages) || input.messages.length < 1) fail('PAGED_CHAT_BODY_WRITE_REQUEST_INVALID')
      try {
        const identity = JSON.parse(input.sourceIdentityJson) as { sessionGeneration?: unknown; messageRevision?: unknown; historyWatermark?: unknown }
        if (identity.sessionGeneration !== input.sessionGeneration || identity.messageRevision !== input.messageRevision ||
          JSON.stringify(identity.historyWatermark ?? null) !== input.historyWatermarkJson) fail('PAGED_CHAT_BODY_WRITE_SOURCE_IDENTITY_INVALID')
      } catch { fail('PAGED_CHAT_BODY_WRITE_SOURCE_IDENTITY_INVALID') }
      const ids = new Set<string>()
      const sequences = new Set<number>()
      const ordered = input.messages.map((message, index) => {
        assertBody(message, true)
        const sequence = message.sequence ?? index
        if (!Number.isSafeInteger(sequence) || sequence < 0) fail('PAGED_CHAT_BODY_MESSAGE_INVALID')
        if (ids.has(message.id)) fail('PAGED_CHAT_BODY_DUPLICATE_ID')
        if (sequences.has(sequence)) fail('PAGED_CHAT_BODY_DUPLICATE_SEQUENCE')
        ids.add(message.id)
        sequences.add(sequence)
        return Object.freeze({ sequence, message: Object.freeze({ id: message.id, role: message.role, content: message.content, timestamp: message.timestamp }) })
      }).sort((left, right) => left.sequence - right.sequence)

      const promoted: Array<StagedProjectionBlob & { kind: 'body-block' | 'sequence-directory' | 'id-directory' }> = []
      const staged = await blobs.withWorkerStaging(async (promote, stage) => {
        const writeBlob = async (payload: string, kind: 'body-block' | 'sequence-directory' | 'id-directory'): Promise<BlobRef> => {
          const [tempLocator] = stage.allocate(1)
          if (!tempLocator) fail('PAGED_CHAT_BODY_STAGE_FAILED')
          const filePath = path.join(stage.root, tempLocator)
          const bytes = Buffer.from(payload, 'utf8')
          const file = await fs.open(filePath, 'wx', 0o600)
          try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
          const blob = await promote({ tempLocator, byteLength: bytes.byteLength, payloadDigest: digest(bytes) })
          promoted.push({ ...blob, kind })
          return Object.freeze({ locator: blob.locator, byteLength: blob.byteLength, payloadDigest: blob.payloadDigest })
        }
        const bodyBlocks = makeBodyBlocks(ordered)
        const bodyRefs: BodyBlockRef[] = []
        let bodyOffset = 0
        for (const block of bodyBlocks) {
          const payload = json({ formatVersion: FORMAT_VERSION, kind: 'body-block', entries: block })
          const blob = await writeBlob(payload, 'body-block')
          bodyRefs.push(Object.freeze({ first: block[0]!.sequence, last: block.at(-1)!.sequence, count: block.length, blob }))
          bodyOffset += block.length
        }
        if (bodyOffset !== ordered.length) fail('PAGED_CHAT_BODY_WRITE_COVERAGE_INVALID')

        const buildTree = async (kind: 'sequence' | 'id', leafValues: readonly (DirectoryEntry & { idEntries?: readonly Array<{ id: string; sequence: number; index: number; blob: BlobRef }>[] })[],
          leafSize: number): Promise<BlobRef> => {
          let level: Array<{ first: number | string; last: number | string; blob: BlobRef }> = []
          for (let offset = 0; offset < leafValues.length; offset += leafSize) {
            const entries = leafValues.slice(offset, offset + leafSize)
            const first = entries[0]!.first
            const last = entries.at(-1)!.last
            const payload = json(kind === 'id'
              ? { formatVersion: FORMAT_VERSION, kind: `${kind}-directory`, first, last,
                entries: entries.flatMap((entry) =>
                  (entry.idEntries ?? []).map((locator) => ({ first: locator.id, last: locator.id, ...locator }))) }
              : { formatVersion: FORMAT_VERSION, kind: `${kind}-directory`, first, last, entries })
            level.push({ first, last, blob: await writeBlob(payload, kind === 'sequence' ? 'sequence-directory' : 'id-directory') })
          }
          if (level.length === 0) fail('PAGED_CHAT_DIRECTORY_EMPTY')
          while (level.length > 1) {
            const next: typeof level = []
            for (let offset = 0; offset < level.length; offset += DIRECTORY_FANOUT) {
              const children = level.slice(offset, offset + DIRECTORY_FANOUT)
              const first = children[0]!.first
              const last = children.at(-1)!.last
              const payload = json({ formatVersion: FORMAT_VERSION, kind: `${kind}-directory`, first, last,
                children: children.map(({ first: childFirst, last: childLast, blob }) => ({ first: childFirst, last: childLast, blob })) })
              next.push({ first, last, blob: await writeBlob(payload, kind === 'sequence' ? 'sequence-directory' : 'id-directory') })
            }
            level = next
          }
          return level[0]!.blob
        }

        const sequenceLeaves = bodyRefs.map((block) => ({ first: block.first, last: block.last,
          blob: block.blob, count: block.count }))
        const sequenceRoot = await buildTree('sequence', sequenceLeaves, DIRECTORY_FANOUT)
        const blockBySequence = new Map<number, { blockIndex: number; entryIndex: number; blob: BlobRef }>()
        bodyRefs.forEach((block, blockIndex) => {
          const values = bodyBlocks[blockIndex]!
          values.forEach(({ sequence }, entryIndex) => blockBySequence.set(sequence, { blockIndex, entryIndex, blob: block.blob }))
        })
        const idLeaves = [...ordered].sort((left, right) => stableIdCompare(left.message.id, right.message.id)).map(({ sequence, message }) => {
          const position = blockBySequence.get(sequence)
          if (!position) fail('PAGED_CHAT_WRITE_COVERAGE_INVALID')
          return { first: message.id, last: message.id, idEntries: [{ id: message.id, sequence, index: position.entryIndex, blob: position.blob }] }
        })
        const idRoot = await buildTree('id', idLeaves, ID_DIRECTORY_LEAF_SIZE)
        const manifestPayload = { formatVersion: FORMAT_VERSION, sessionId: input.sessionId, sessionGeneration: input.sessionGeneration,
          specVersion: input.specVersion, sourceRevision: input.sourceRevision, messageRevision: input.messageRevision,
          sourceIdentityJson: input.sourceIdentityJson, historyWatermarkJson: input.historyWatermarkJson, messageCount: ordered.length,
          firstSequence: ordered[0]!.sequence, lastSequence: ordered.at(-1)!.sequence, sequenceRoot, idRoot }
        const manifest: PagedChatBodyManifest = Object.freeze({ ...manifestPayload, manifestDigest: digest(json(manifestPayload)) })
        const blobReferences = promoted.map((blob) => Object.freeze({ locator: blob.locator, byteLength: blob.byteLength,
          payloadDigest: blob.payloadDigest, kind: blob.kind }))
        return { manifest, blobReferences }
      })
      let released = false
      return Object.freeze({ manifest: staged.manifest, async release() {
        if (released) return
        released = true
        await promoted[0]?.release()
      } })
    },

    async readPage(input: Readonly<{ manifest: PagedChatBodyManifest; beforeSequence: number; limit: number }>): Promise<readonly VerifiedChatBody[]> {
      assertManifest(input.manifest)
      if (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 0 || !Number.isSafeInteger(input.limit) ||
        input.limit < 1 || input.limit > MAX_PAGE_SIZE) fail('PAGED_CHAT_BODY_RANGE_INVALID')
      const lower = Math.max(0, input.beforeSequence - input.limit)
      const blockEntries: DirectoryEntry[] = []
      await collectDirectory(input.manifest.sequenceRoot, 'sequence', lower, input.beforeSequence - 1, blockEntries)
      const selected: Array<{ sequence: number; message: VerifiedChatBody }> = []
      for (const entry of blockEntries) {
        const block = await readBodyBlock(entry.blob, entry.count, entry.first as number, entry.last as number)
        for (const item of block) if (item.sequence >= lower && item.sequence < input.beforeSequence) selected.push(item)
      }
      selected.sort((left, right) => left.sequence - right.sequence)
      if (selected.length > input.limit) selected.splice(0, selected.length - input.limit)
      return Object.freeze(selected.map(({ message }) => message))
    },

    async readByIds(input: Readonly<{ manifest: PagedChatBodyManifest; messageIds: readonly string[] }>): Promise<readonly VerifiedChatBody[]> {
      assertManifest(input.manifest)
      if (!Array.isArray(input.messageIds) || input.messageIds.some((id) => typeof id !== 'string' || !id) ||
        new Set(input.messageIds).size !== input.messageIds.length) fail('PAGED_CHAT_BODY_ID_REQUEST_INVALID')
      if (input.messageIds.length === 0) return Object.freeze([])
      const idEntries: DirectoryEntry[] = []
      const directoryCache = new Map<string, Awaited<ReturnType<typeof readDirectory>>>()
      const cachedReadDirectory = async (ref: BlobRef, kind: 'sequence' | 'id') => {
        const key = `${kind}:${ref.locator}`
        let value = directoryCache.get(key)
        if (!value) { value = await readDirectory(ref, kind); directoryCache.set(key, value) }
        return value
      }
      const readId = async (ref: BlobRef, id: string): Promise<void> => {
        const node = await cachedReadDirectory(ref, 'id')
        if (id < node.first || id > node.last) return
        if (node.entries) {
          const match = node.entries.find((entry) => entry.first === id)
          if (match) idEntries.push(match)
          return
        }
        for (const child of node.children!) if (id >= child.first && id <= child.last) await readId(child.blob, id)
      }
      for (const id of input.messageIds) await readId(input.manifest.idRoot, id)
      const byBlock = new Map<string, { blob: BlobRef; entries: Array<{ id: string; sequence: number; index: number }> }>()
      for (const entry of idEntries) {
        if (!entry.id || !Number.isSafeInteger(entry.sequence) || !Number.isSafeInteger(entry.index)) fail('PAGED_CHAT_BODY_DIRECTORY_INVALID')
        const group = byBlock.get(entry.blob.locator) ?? { blob: entry.blob, entries: [] }
        group.entries.push({ id: entry.id, sequence: entry.sequence!, index: entry.index! })
        byBlock.set(entry.blob.locator, group)
      }
      const bodies = new Map<string, VerifiedChatBody>()
      for (const group of byBlock.values()) {
        const entries = await readBodyBlock(group.blob)
        for (const locator of group.entries) {
          const entry = entries[locator.index]
          if (!entry || entry.sequence !== locator.sequence || entry.message.id !== locator.id) fail('PAGED_CHAT_BODY_LOCATOR_INVALID')
          bodies.set(locator.id, entry.message)
        }
      }
      if (bodies.size !== input.messageIds.length) fail('PROJECTION_CHAT_BODY_CACHE_MESSAGE_MISSING')
      return Object.freeze(input.messageIds.map((id) => bodies.get(id)!))
    }
  }
}
