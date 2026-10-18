import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { WikiFileStore } from './wikiFileStore'
import type { WikiReadCaller } from './wikiDomainRead'
import { normalizeWikiRelativePath } from './wikiPaths'

export interface WikiBoundSource { path: string; displayName: string; projectId?: string }
interface StoredSource { formatVersion: 1; sourceId: string; sourceRevision: number; displayName: string; projectId?: string; rawPath?: string }
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
      stored = await reconcileRawSource(options.store, stored, maxBytes)
      const revision = input.sourceRevision ?? stored.sourceRevision
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > stored.sourceRevision) throw new WikiSourceError('source_missing')
      const bytes = await options.store.read(`.wiki-service/source-history/${sourceId}/${revision}.md`).catch(() => { throw new WikiSourceError('source_missing') })
      const text = bytes.toString('utf8')
      const codepoints = Array.from(text)
      let offset = 0
      if (input.cursor) {
        const cursor = cursorMap.get(input.cursor)
        if (!cursor || cursor.sourceId !== sourceId || cursor.sourceRevision !== revision || cursor.callerId !== caller.callerId || cursor.lane !== caller.lane) throw new WikiSourceError('source_cursor_invalid')
        offset = cursor.offset
      }
      const limit = Math.min(maxChars, Math.max(1, input.maxChars ?? maxChars))
      const end = Math.min(codepoints.length, offset + limit)
      const nextCursor = end < codepoints.length ? randomUUID() : undefined
      if (nextCursor) cursorMap.set(nextCursor, { sourceId, sourceRevision: revision, offset: end, callerId: caller.callerId, lane: caller.lane })
      return { sourceId, sourceRevision: revision, displayName: stored.displayName, projectId: stored.projectId, text: codepoints.slice(offset, end).join(''), startOffset: offset, endOffset: end, ...(nextCursor ? { nextCursor } : {}), hasMore: end < codepoints.length }
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
      (value.rawPath !== undefined && (typeof value.rawPath !== 'string' || !value.rawPath.startsWith('raw/') || normalizeWikiRelativePath(value.rawPath) !== value.rawPath))) return undefined
    return value as StoredSource
  }
  catch { return undefined }
}

async function reconcileRawSource(store: WikiFileStore, stored: StoredSource, maxBytes: number): Promise<StoredSource> {
  if (!stored.rawPath) return stored
  let bytes: Buffer
  try { bytes = await store.read(stored.rawPath) } catch { throw new WikiSourceError('source_missing') }
  if (bytes.length > maxBytes || bytes.includes(0)) throw new WikiSourceError('source_missing')
  const current = await store.read(`.wiki-service/source-history/${stored.sourceId}/${stored.sourceRevision}.md`).catch(() => { throw new WikiSourceError('source_missing') })
  if (hash(bytes) === hash(current)) return stored
  const next = { ...stored, sourceRevision: stored.sourceRevision + 1 }
  await store.writeImmutable(`.wiki-service/source-history/${stored.sourceId}/${next.sourceRevision}.md`, bytes)
  await store.write(`.wiki-service/sources/${stored.sourceId}.json`, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function safeSegment(value: string): string { return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : 'unassigned' }
function baseName(value: string): string { return value.replace(/\\/g, '/').split('/').at(-1) ?? '' }
function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
