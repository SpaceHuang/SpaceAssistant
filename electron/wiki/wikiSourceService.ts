import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { WikiFileStore } from './wikiFileStore'
import type { WikiReadCaller } from './wikiDomainRead'
import { normalizeWikiRelativePath } from './wikiPaths'
import { withWikiWriteMutex } from './wikiWriteMutex'

export interface WikiBoundSource { path: string; displayName: string; projectId?: string }
interface StoredSource { formatVersion: 1; sourceId: string; sourceRevision: number; displayName: string; projectId?: string; rawPath?: string; deleted?: true }
interface SourceCursor { sourceId: string; sourceRevision: number; offset: number; callerId: string; lane: string }
export class WikiSourceError extends Error { constructor(readonly code: string) { super(code); this.name = 'WikiSourceError' } }

export function createWikiSourceService(options: {
  store: WikiFileStore
  resolveSourceRef: (sourceRef: string, caller: WikiReadCaller) => WikiBoundSource | undefined | Promise<WikiBoundSource | undefined>
  validateSource: (sourcePath: string, caller: WikiReadCaller) => boolean | Promise<boolean>
  authorize: (sourceId: string, caller: WikiReadCaller) => boolean | Promise<boolean>
  maxBytes?: number
  maxChars?: number
}) {
  const cursorMap = new Map<string, SourceCursor>()
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const maxChars = Math.min(8000, Math.max(1, options.maxChars ?? 4000))
  return {
    async importSource(sourceRef: string, caller: WikiReadCaller) {
      const source = await options.resolveSourceRef(sourceRef, caller)
      if (!source || !(await options.validateSource(source.path, caller))) throw new WikiSourceError('source_missing')
      const bytes = await readFile(source.path)
      if (bytes.length > maxBytes || bytes.includes(0)) throw new WikiSourceError('source_missing')
      const sourceId = randomUUID()
      const sourceRevision = 1
      await options.store.writeImmutable(`.wiki-service/source-history/${sourceId}/${sourceRevision}.md`, bytes)
      const projectSegment = safeSegment(source.projectId ?? 'unassigned')
      const displayName = baseName(source.displayName).replace(/[^\p{L}\p{N}._-]/gu, '_') || 'source.md'
      const rawPath = normalizeWikiRelativePath(`raw/${projectSegment}/${sourceId}/${displayName}`)
      await options.store.writeImmutable(rawPath, bytes)
      const stored: StoredSource = { formatVersion: 1, sourceId, sourceRevision, displayName, rawPath, ...(source.projectId ? { projectId: source.projectId } : {}) }
      await options.store.write(`.wiki-service/sources/${sourceId}.json`, `${JSON.stringify(stored, null, 2)}\n`)
      return { sourceId, sourceRevision, displayName: stored.displayName, projectId: stored.projectId }
    },
    async readSource(sourceId: string, caller: WikiReadCaller, input: { sourceRevision?: number; cursor?: string; maxChars?: number } = {}) {
      let stored = await readBinding(options.store, sourceId)
      const allowed = stored && await options.authorize(sourceId, caller)
      if (!stored || !allowed) throw new WikiSourceError('source_missing')
      const cursor = input.cursor ? cursorMap.get(input.cursor) : undefined
      if (input.cursor && (!cursor || cursor.sourceId !== sourceId || cursor.callerId !== caller.callerId || cursor.lane !== caller.lane ||
        (input.sourceRevision !== undefined && input.sourceRevision !== cursor.sourceRevision))) throw new WikiSourceError('source_cursor_invalid')
      stored = await withWikiWriteMutex(path.join(options.store.root, '.wiki-domain-lock'), async () => {
        const latest = await readBinding(options.store, sourceId)
        if (!latest || !(await options.authorize(sourceId, caller))) throw new WikiSourceError('source_missing')
        return reconcileRawSource(options.store, latest, maxBytes)
      })
      if (stored.deleted && !cursor && input.sourceRevision === undefined) throw new WikiSourceError('source_missing')
      const revision = cursor?.sourceRevision ?? input.sourceRevision ?? stored.sourceRevision
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > stored.sourceRevision) throw new WikiSourceError('source_missing')
      const bytes = await options.store.read(`.wiki-service/source-history/${sourceId}/${revision}.md`).catch(() => { throw new WikiSourceError('source_missing') })
      const text = bytes.toString('utf8')
      const codepoints = Array.from(text)
      const offset = cursor?.offset ?? 0
      const limit = Math.min(maxChars, Math.max(1, input.maxChars ?? maxChars))
      const end = Math.min(codepoints.length, offset + limit)
      const nextCursor = end < codepoints.length ? randomUUID() : undefined
      if (nextCursor) cursorMap.set(nextCursor, { sourceId, sourceRevision: revision, offset: end, callerId: caller.callerId, lane: caller.lane })
      return { sourceId, sourceRevision: revision, displayName: stored.displayName, projectId: stored.projectId, ...(stored.deleted ? { deleted: true as const } : {}), text: codepoints.slice(offset, end).join(''), startOffset: offset, endOffset: end, ...(nextCursor ? { nextCursor } : {}), hasMore: end < codepoints.length }
    },
  }
}

async function readBinding(store: WikiFileStore, sourceId: string): Promise<StoredSource | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) return undefined
  try {
    const value = JSON.parse(await store.readText(`.wiki-service/sources/${sourceId}.json`)) as Partial<StoredSource> | null
    if (!value || value.formatVersion !== 1 || value.sourceId !== sourceId || !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision as number) < 1 ||
      typeof value.displayName !== 'string' || !value.displayName || value.displayName.includes('/') || value.displayName.includes('\\') ||
      (value.projectId !== undefined && typeof value.projectId !== 'string') ||
      (value.deleted !== undefined && value.deleted !== true) ||
      (value.rawPath !== undefined && (typeof value.rawPath !== 'string' || !value.rawPath.startsWith('raw/') || normalizeWikiRelativePath(value.rawPath) !== value.rawPath))) return undefined
    return value as StoredSource
  }
  catch { return undefined }
}

async function reconcileRawSource(store: WikiFileStore, stored: StoredSource, maxBytes: number): Promise<StoredSource> {
  if (!stored.rawPath) return stored
  const bindingPath = `.wiki-service/sources/${stored.sourceId}.json`
  const bindingIdentity = await store.identity(bindingPath)
  if (!bindingIdentity) throw new WikiSourceError('source_missing')
  const rawIdentity = await store.identity(stored.rawPath)
  let bytes: Buffer
  try {
    bytes = await store.read(stored.rawPath)
    if (!sameIdentity(rawIdentity, await store.identity(stored.rawPath))) throw new WikiSourceError('source_revision_conflict')
  } catch (error) {
    if (error instanceof WikiSourceError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new WikiSourceError('source_missing')
    if (stored.deleted) return stored
    const deleted: StoredSource = { ...stored, deleted: true }
    await store.write(bindingPath, `${JSON.stringify(deleted, null, 2)}\n`, bindingIdentity)
    return deleted
  }
  if (bytes.length > maxBytes || bytes.includes(0)) throw new WikiSourceError('source_missing')
  const current = await store.read(`.wiki-service/source-history/${stored.sourceId}/${stored.sourceRevision}.md`).catch(() => { throw new WikiSourceError('source_missing') })
  if (hash(bytes) === hash(current)) {
    if (!stored.deleted) return stored
    const restored: StoredSource = { ...stored }
    delete restored.deleted
    await store.write(bindingPath, `${JSON.stringify(restored, null, 2)}\n`, bindingIdentity)
    return restored
  }
  const next: StoredSource = { ...stored, sourceRevision: stored.sourceRevision + 1 }
  delete next.deleted
  const snapshotPath = `.wiki-service/source-history/${stored.sourceId}/${next.sourceRevision}.md`
  if (await store.identity(snapshotPath)) {
    const existingSnapshot = await store.read(snapshotPath)
    if (hash(existingSnapshot) !== hash(bytes)) throw new WikiSourceError('source_revision_conflict')
  } else {
    await store.writeImmutable(snapshotPath, bytes)
  }
  if (!sameIdentity(rawIdentity, await store.identity(stored.rawPath)) || hash(await store.read(stored.rawPath)) !== hash(bytes)) {
    throw new WikiSourceError('source_revision_conflict')
  }
  await store.write(bindingPath, `${JSON.stringify(next, null, 2)}\n`, bindingIdentity)
  return next
}

function safeSegment(value: string): string { return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : 'unassigned' }
function baseName(value: string): string { return value.replace(/\\/g, '/').split('/').at(-1) ?? '' }
function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function sameIdentity(left: Awaited<ReturnType<WikiFileStore['identity']>>, right: Awaited<ReturnType<WikiFileStore['identity']>>): boolean {
  if (!left || !right) return left === right
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink
}
