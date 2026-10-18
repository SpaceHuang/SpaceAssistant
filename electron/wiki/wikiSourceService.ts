import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { WikiFileStore } from './wikiFileStore'
import type { WikiReadCaller } from './wikiDomainRead'

export interface WikiBoundSource { path: string; displayName: string; projectId?: string }
interface StoredSource { formatVersion: 1; sourceId: string; sourceRevision: number; displayName: string; projectId?: string }
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
      const stored: StoredSource = { formatVersion: 1, sourceId, sourceRevision, displayName: source.displayName, ...(source.projectId ? { projectId: source.projectId } : {}) }
      await options.store.write(`.wiki-service/sources/${sourceId}.json`, `${JSON.stringify(stored, null, 2)}\n`)
      return { sourceId, sourceRevision, displayName: stored.displayName, projectId: stored.projectId }
    },
    async readSource(sourceId: string, caller: WikiReadCaller, input: { sourceRevision?: number; cursor?: string; maxChars?: number } = {}) {
      const stored = await readBinding(options.store, sourceId)
      const allowed = stored && await options.authorize(sourceId, caller)
      const revision = input.sourceRevision ?? stored?.sourceRevision
      if (!stored || !allowed || revision !== stored.sourceRevision) throw new WikiSourceError('source_missing')
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
  try { return JSON.parse(await store.readText(`.wiki-service/sources/${sourceId}.json`)) as StoredSource }
  catch { return undefined }
}
