import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { VerifiedChatBody } from './projectionChatBodyCachePayload'

type BlobRef = Readonly<{ locator: string; byteLength: number; payloadDigest: string }>
type StagedBlob = Readonly<BlobRef & { tempLocator: string; kind: 'body-block' | 'sequence-directory' | 'id-directory' | 'body-manifest' }>
type BodyEntry = Readonly<{ sequence: number; message: VerifiedChatBody }>
type DirectoryEntry = Readonly<{ first: number | string; last: number | string; blob: BlobRef; count?: number;
  id?: string; sequence?: number; index?: number }>
const FANOUT = 8
const BODY_BLOCK_MAX_MESSAGES = 64
const BODY_BLOCK_MAX_BYTES = 256 * 1024
const MAX_ARTIFACTS = 100_000

function digest(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function json(value: unknown): string { return JSON.stringify(value) }
function fail(code: string): never { throw new Error(code) }

export async function writeProjectionPagedBody(input: Readonly<{
  root: string
  messages: AsyncIterable<VerifiedChatBody>
  sessionId: string
  sessionGeneration: string
  specVersion: number
  sourceRevision: number
  messageRevision: number | null
  sourceIdentityJson: string
  historyWatermarkJson: string
}>): Promise<Readonly<{
  manifest?: string
  manifestBlob?: StagedBlob
  payloadDigest: string
  byteLength: number
  stagedBlobs: readonly StagedBlob[]
  blobReferences: readonly Readonly<BlobRef & { kind: StagedBlob['kind'] }>[]
}>> {
  const root = path.resolve(input.root)
  if (!input.sessionId || !input.sessionGeneration || !Number.isSafeInteger(input.specVersion) || input.specVersion < 1 ||
    !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0 ||
    (input.messageRevision !== null && (!Number.isSafeInteger(input.messageRevision) || input.messageRevision < 0))) fail('PAGED_CHAT_BODY_SOURCE_INVALID')
  let identity: { sessionGeneration?: unknown; sourceRevision?: unknown; messageRevision?: unknown; historyWatermark?: unknown }
  try { identity = JSON.parse(input.sourceIdentityJson) as typeof identity } catch { fail('PAGED_CHAT_BODY_SOURCE_INVALID') }
  if (identity.sessionGeneration !== input.sessionGeneration || identity.sourceRevision !== input.sourceRevision ||
    identity.messageRevision !== input.messageRevision || JSON.stringify(identity.historyWatermark ?? null) !== input.historyWatermarkJson) {
    fail('PAGED_CHAT_BODY_SOURCE_INVALID')
  }
  const stagedBlobs: StagedBlob[] = []
  const writeBlob = async (payload: string, kind: StagedBlob['kind']): Promise<BlobRef> => {
    if (stagedBlobs.length >= MAX_ARTIFACTS) fail('PAGED_CHAT_BODY_ARTIFACT_LIMIT_EXCEEDED')
    const tempLocator = `.projection-${randomUUID()}.tmp`
    // Derive the published locator from the staging UUID so the blob store can verify the promotion pair.
    const finalLocator = `projection-${tempLocator.slice('.projection-'.length, -'.tmp'.length)}.blob`
    const tempPath = path.join(root, tempLocator)
    if (path.dirname(tempPath) !== root) fail('PAGED_CHAT_BODY_ROOT_INVALID')
    const bytes = Buffer.from(payload, 'utf8')
    const handle = await fs.open(tempPath, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    } finally { await handle.close() }
    const reference = Object.freeze({ locator: finalLocator, byteLength: bytes.byteLength, payloadDigest: digest(bytes) })
    stagedBlobs.push(Object.freeze({ ...reference, tempLocator, kind }))
    return reference
  }
  try {
  const bodyRefs: Array<{ first: number; last: number; count: number; blob: BlobRef }> = []
  const idIndex: Array<{ id: string; sequence: number; index: number; blob: BlobRef }> = []
  let sequence = 0
  let current: BodyEntry[] = []
  const encoded = (entries: readonly BodyEntry[]) => json({ formatVersion: 1, kind: 'body-block', entries })
  const flush = async () => {
    if (!current.length) return
    const payload = encoded(current)
    const blob = await writeBlob(payload, 'body-block')
    const first = current[0]!.sequence
    const last = current.at(-1)!.sequence
    bodyRefs.push({ first, last, count: current.length, blob })
    current.forEach(({ sequence: itemSequence, message }, index) => idIndex.push({ id: message.id, sequence: itemSequence, index, blob }))
    current = []
  }
  for await (const message of input.messages) {
    if (!message || typeof message.id !== 'string' || !message.id ||
      (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' ||
      !Number.isSafeInteger(message.timestamp)) fail('PAGED_CHAT_BODY_MESSAGE_INVALID')
    const entry = Object.freeze({ sequence, message: Object.freeze({ id: message.id, role: message.role,
      content: message.content, timestamp: message.timestamp }) }) as BodyEntry
    if (current.length && (current.length >= BODY_BLOCK_MAX_MESSAGES ||
      Buffer.byteLength(encoded([...current, entry]), 'utf8') > BODY_BLOCK_MAX_BYTES)) await flush()
    current.push(entry)
    if (current.length === 1 && Buffer.byteLength(encoded(current), 'utf8') > BODY_BLOCK_MAX_BYTES) await flush()
    sequence += 1
  }
  await flush()
  idIndex.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  for (let index = 1; index < idIndex.length; index += 1) if (idIndex[index - 1]!.id === idIndex[index]!.id) fail('PAGED_CHAT_DUPLICATE_MESSAGE_ID')

  const buildTree = async (kind: 'sequence' | 'id', leaves: readonly DirectoryEntry[], leafSize: number): Promise<BlobRef> => {
    let level: Array<{ first: number | string; last: number | string; blob: BlobRef }> = []
    for (let offset = 0; offset < leaves.length; offset += leafSize) {
      const entries = leaves.slice(offset, offset + leafSize)
      const first = entries[0]!.first
      const last = entries.at(-1)!.last
      const payload = json(kind === 'id' ? { formatVersion: 1, kind: 'id-directory', first, last,
        entries: entries.map((entry) => ({ first: entry.id, last: entry.id, id: entry.id, sequence: entry.sequence, index: entry.index, blob: entry.blob })) }
        : { formatVersion: 1, kind: 'sequence-directory', first, last, entries })
      level.push({ first, last, blob: await writeBlob(payload, kind === 'sequence' ? 'sequence-directory' : 'id-directory') })
    }
    if (!level.length) fail('PAGED_CHAT_DIRECTORY_EMPTY')
    while (level.length > 1) {
      const next: typeof level = []
      for (let offset = 0; offset < level.length; offset += FANOUT) {
        const children = level.slice(offset, offset + FANOUT)
        const first = children[0]!.first
        const last = children.at(-1)!.last
        const payload = json({ formatVersion: 1, kind: `${kind}-directory`, first, last,
          children: children.map(({ first: childFirst, last: childLast, blob }) => ({ first: childFirst, last: childLast, blob })) })
        next.push({ first, last, blob: await writeBlob(payload, kind === 'sequence' ? 'sequence-directory' : 'id-directory') })
      }
      level = next
    }
    return level[0]!.blob
  }
  const sequenceRoot = bodyRefs.length ? await buildTree('sequence', bodyRefs.map(({ first, last, count, blob }) => ({ first, last, count, blob })), FANOUT) : null
  const idRoot = idIndex.length ? await buildTree('id', idIndex.map((entry) => ({ first: entry.id, last: entry.id, id: entry.id,
    sequence: entry.sequence, index: entry.index, blob: entry.blob })), 512) : null
  let historyWatermark: unknown
  try { historyWatermark = JSON.parse(input.historyWatermarkJson) } catch { fail('PAGED_CHAT_BODY_WATERMARK_INVALID') }
  const manifestPayload = { formatVersion: 1, sessionId: input.sessionId, sessionGeneration: input.sessionGeneration,
    specVersion: input.specVersion, sourceRevision: input.sourceRevision, messageRevision: input.messageRevision,
    sourceIdentityJson: input.sourceIdentityJson, historyWatermarkJson: input.historyWatermarkJson, messageCount: sequence,
    firstSequence: 0, lastSequence: sequence ? sequence - 1 : -1, sequenceRoot, idRoot }
  if (historyWatermark === undefined) fail('PAGED_CHAT_BODY_WATERMARK_INVALID')
  const manifest = json({ ...manifestPayload, manifestDigest: digest(json(manifestPayload)) })
  const byteLength = Buffer.byteLength(manifest, 'utf8')
  if (byteLength > 16 * 1024 * 1024) fail('PAGED_CHAT_BODY_MANIFEST_TOO_LARGE')
  const payloadDigest = digest(manifest)
  if (byteLength > BODY_BLOCK_MAX_BYTES) await writeBlob(manifest, 'body-manifest')
  const manifestBlob = byteLength > BODY_BLOCK_MAX_BYTES ? stagedBlobs.at(-1) : undefined
  return Object.freeze({ ...(manifestBlob ? {} : { manifest }), ...(manifestBlob ? { manifestBlob } : {}), payloadDigest, byteLength,
    stagedBlobs: Object.freeze(stagedBlobs), blobReferences: Object.freeze(stagedBlobs.map(({ tempLocator: _tempLocator, ...ref }) => ref)) })
  } catch (error) {
    await Promise.all(stagedBlobs.map(({ tempLocator }) => fs.rm(path.join(root, tempLocator), { force: true }).catch(() => undefined)))
    throw error
  }
}
