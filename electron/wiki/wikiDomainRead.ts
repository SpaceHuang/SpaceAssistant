import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { WikiFileStore } from './wikiFileStore'

export interface WikiPageReadRecord { pageId: string; title: string; categoryId: string; summary?: string; parentPageId?: string | null; path: string; revision: number; sourceRefs?: Array<{ sourceId: string; sourceRevision: number }> }
export interface WikiReadCaller { callerId: string; lane: string }
export interface WikiSourceBinding { sourceId: string; sourceRevision: number; displayName: string; path: string; projectId?: string }
export class WikiDomainReadError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'WikiDomainReadError' }
}
interface ReadHandle { caller: WikiReadCaller; page: WikiPageReadRecord; revision: number; text: string; expiresAt: number; cursors: Map<string, number> }

export function createWikiDomainReadService(options: {
  store: WikiFileStore
  pages: WikiPageReadRecord[]
  sourceBindings?: WikiSourceBinding[]
  maxChars?: number
  handleTtlMs?: number
  now?: () => number
  authorize?: (pageId: string, caller: WikiReadCaller) => boolean | Promise<boolean>
  authorizeSource?: (sourceId: string, caller: WikiReadCaller) => boolean | Promise<boolean>
}) {
  const handles = new Map<string, ReadHandle>()
  const now = options.now ?? Date.now
  const sourceBindings = new Map((options.sourceBindings ?? []).map(binding => [`${binding.sourceId}:${binding.sourceRevision}`, binding]))
  const maxChars = Math.min(8000, Math.max(1, options.maxChars ?? 4000))
  const handleTtlMs = options.handleTtlMs ?? 15 * 60_000

  return {
    async openPage(pageId: string, caller: WikiReadCaller, requestedRevision?: number) {
      const page = options.pages.find(item => item.pageId === pageId)
      if (!page || (options.authorize && !await options.authorize(pageId, caller))) throw new WikiDomainReadError('wiki-page-unavailable')
      const revision = requestedRevision ?? page.revision
      if (!Number.isSafeInteger(revision) || revision < 1) throw new WikiDomainReadError('wiki-page-unavailable')
      let text: string
      try { text = (await options.store.readText(`.wiki-service/page-history/${pageId}/${revision}.md`)) }
      catch { throw new WikiDomainReadError('wiki-page-unavailable') }
      const readHandle = randomUUID()
      handles.set(readHandle, { caller, page, revision, text, expiresAt: now() + handleTtlMs, cursors: new Map() })
      return { readHandle, pageId, revision, title: page.title, categoryId: page.categoryId, summary: page.summary ?? '', parentPageId: page.parentPageId ?? null, sourceRefs: page.sourceRefs ?? [], charCount: Array.from(text).length, lineCount: text.split('\n').length }
    },
    async readPage(readHandle: string, caller: WikiReadCaller, input: { cursor?: string; startLine?: number; maxChars?: number } = {}) {
      const handle = handles.get(readHandle)
      if (!handle || handle.expiresAt <= now() || handle.caller.callerId !== caller.callerId || handle.caller.lane !== caller.lane) throw new WikiDomainReadError('page_read_handle_expired')
      if (options.authorize && !await options.authorize(handle.page.pageId, caller)) throw new WikiDomainReadError('wiki-access-denied')
      if (input.cursor && input.startLine !== undefined) throw new WikiDomainReadError('wiki-read-cursor-invalid')
      const codepoints = Array.from(handle.text)
      let offset: number
      if (input.cursor) {
        const cursorOffset = handle.cursors.get(input.cursor)
        if (cursorOffset === undefined) throw new WikiDomainReadError('wiki-read-cursor-invalid')
        offset = cursorOffset
      } else if (input.startLine !== undefined) {
        if (!Number.isSafeInteger(input.startLine) || input.startLine < 1) throw new WikiDomainReadError('wiki-read-line-invalid')
        offset = 0
        for (let line = 1; line < input.startLine && offset < codepoints.length; line += 1) {
          const newline = codepoints.indexOf('\n', offset)
          if (newline < 0) { offset = codepoints.length; break }
          offset = newline + 1
        }
      } else offset = 0
      const limit = Math.min(maxChars, Math.max(1, input.maxChars ?? maxChars))
      const end = Math.min(codepoints.length, offset + limit)
      const text = codepoints.slice(offset, end).join('')
      const nextCursor = end < codepoints.length ? randomUUID() : undefined
      if (nextCursor) handle.cursors.set(nextCursor, end)
      const startLine = 1 + codepoints.slice(0, offset).filter(char => char === '\n').length
      const endLine = startLine + text.split('\n').length - 1 - (text.endsWith('\n') ? 1 : 0)
      return { text, startOffset: offset, endOffset: end, startLine, endLine: Math.max(startLine, endLine), ...(nextCursor ? { nextCursor } : {}), hasMore: end < codepoints.length }
    },
    async readSource(sourceId: string, caller: WikiReadCaller, sourceRevision?: number, input: { cursor?: string; maxChars?: number } = {}) {
      const bindings = [...sourceBindings.values()].filter(binding => binding.sourceId === sourceId && (sourceRevision === undefined || binding.sourceRevision === sourceRevision))
      const binding = bindings[0]
      const authorized = binding && (!options.authorizeSource || await options.authorizeSource(sourceId, caller))
      if (!binding || !authorized) throw new WikiDomainReadError('wiki-source-unavailable')
      const key = `${sourceId}:${binding.sourceRevision}`
      let text: string
      try { text = await options.store.readText(`.wiki-service/source-history/${key.replace(':', '/')}.md`) }
      catch {
        try { text = await readFile(binding.path, 'utf8') }
        catch { throw new WikiDomainReadError('wiki-source-unavailable') }
      }
      const offset = input.cursor ? decodeSourceCursor(input.cursor, key) : 0
      const codepoints = Array.from(text)
      const limit = Math.min(maxChars, Math.max(1, input.maxChars ?? maxChars))
      const end = Math.min(codepoints.length, offset + limit)
      const nextCursor = end < codepoints.length ? `${key}:${end}` : undefined
      return { sourceId, sourceRevision: binding.sourceRevision, displayName: binding.displayName, projectId: binding.projectId, text: codepoints.slice(offset, end).join(''), startOffset: offset, endOffset: end, ...(nextCursor ? { nextCursor } : {}), hasMore: end < codepoints.length }
    },
    async importSource(sourceRef: string, trustedSources: Map<string, { path: string; displayName: string; projectId?: string }>) {
      const source = trustedSources.get(sourceRef)
      if (!source) throw new WikiDomainReadError('wiki-source-unavailable')
      const absPath = path.resolve(source.path)
      const current = await readFile(absPath)
      if (current.length > 10 * 1024 * 1024 || current.includes(0)) throw new WikiDomainReadError('wiki-source-unavailable')
      const sourceId = randomUUID()
      const sourceRevision = 1
      await options.store.writeImmutable(`.wiki-service/source-history/${sourceId}/${sourceRevision}.md`, current)
      sourceBindings.set(`${sourceId}:${sourceRevision}`, { sourceId, sourceRevision, displayName: source.displayName, path: absPath, projectId: source.projectId })
      return { sourceId, sourceRevision, displayName: source.displayName, projectId: source.projectId }
    },
    search(query: string, input: { categoryId?: string; limit?: number } = {}) {
      const normalized = query.trim().toLocaleLowerCase()
      const matches = options.pages.filter(page => (!input.categoryId || page.categoryId === input.categoryId) && (!normalized || `${page.title} ${page.summary ?? ''}`.toLocaleLowerCase().includes(normalized)))
      const limit = Math.min(100, Math.max(1, input.limit ?? 20))
      return { results: matches.slice(0, limit).map(page => ({ pageId: page.pageId, title: page.title, categoryId: page.categoryId, summary: page.summary ?? '', revision: page.revision })), totalMatches: matches.length }
    },
  }
}

function decodeSourceCursor(cursor: string, key: string): number {
  const prefix = `${key}:`
  if (!cursor.startsWith(prefix)) throw new WikiDomainReadError('wiki-read-cursor-invalid')
  const offset = Number(cursor.slice(prefix.length))
  if (!Number.isSafeInteger(offset) || offset < 0) throw new WikiDomainReadError('wiki-read-cursor-invalid')
  return offset
}
