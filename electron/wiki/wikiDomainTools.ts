import { createHash } from 'node:crypto'
import { defineDirectTool, type RegisteredTool } from '../tools/plannedToolRegistry'
import type { ToolExecutionContext, ToolExecutorResult } from '../tools/types'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiFileStore } from './wikiFileStore'
import { resolveSharedWikiRoot } from './wikiInit'
import { parseWikiSchema } from './wikiSchema'
import type { WikiFileStore } from './wikiFileStore'
import { createWikiDomainReadService, WikiDomainReadError, type WikiReadCaller, type WikiPageReadRecord } from './wikiDomainRead'
import { createWikiSourceService, WikiSourceError } from './wikiSourceService'

type WikiInput = Record<string, unknown>
type WikiDomainContext = Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir' | 'sessionId' | 'lane' | 'remoteContext'>
type PageReadService = ReturnType<typeof createWikiDomainReadService>
const pageReadServices = new Map<string, { pages: WikiPageReadRecord[]; service: PageReadService }>()
const sourceReadServices = new Map<string, ReturnType<typeof createWikiSourceService>>()

export function createWikiDomainTools(): RegisteredTool[] {
  return [defineDirectTool<WikiInput, ToolExecutorResult>({
    name: 'memory.wiki_get_schema',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (_input, context) => getWikiSchemaForContext(context.runtimeContext as ToolExecutionContext)
  }), defineDirectTool<WikiInput, ToolExecutorResult>({
    name: 'memory.wiki_search',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => searchWikiForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineDirectTool<WikiInput, ToolExecutorResult>({
    name: 'memory.wiki_open_page',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => openWikiPageForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineDirectTool<WikiInput, ToolExecutorResult>({
    name: 'memory.wiki_read_page',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => readWikiPageForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineDirectTool<WikiInput, ToolExecutorResult>({
    name: 'memory.wiki_read_source',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => readWikiSourceForContext(input, context.runtimeContext as ToolExecutionContext)
  })]
}

export async function getWikiSchemaForContext(context: Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir'>): Promise<ToolExecutorResult> {
  let store: WikiFileStore
  try { store = await getReadyWikiStore(context) }
  catch (error) { return { success: false, error: error instanceof WikiDomainToolError ? error.code : 'wiki_schema_unavailable' } }
  const content = await store.readText('SCHEMA.md').catch(() => undefined)
  if (content === undefined) return { success: false, error: 'wiki_schema_unavailable' }
  const parsed = parseWikiSchema(content)
  const stateText = await store.readText('.wiki-service/schema-state.json').catch(() => undefined)
  let schemaVersion = 1
  if (stateText !== undefined) {
    try {
      const state = JSON.parse(stateText) as { formatVersion?: unknown; schemaVersion?: unknown }
      if (state.formatVersion !== 1 || !Number.isSafeInteger(state.schemaVersion) || (state.schemaVersion as number) < 1) return { success: false, error: 'wiki_schema_state_invalid' }
      schemaVersion = state.schemaVersion as number
    } catch {
      return { success: false, error: 'wiki_schema_state_invalid' }
    }
  }
  return { success: true, data: { schemaVersion, content, valid: parsed.valid, categories: parsed.categories, diagnostics: parsed.diagnostics } }
}

export class WikiDomainToolError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WikiDomainToolError' }
}

export async function searchWikiForContext(input: WikiInput, context: Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir'>): Promise<ToolExecutorResult> {
  try {
    return { success: true, data: await searchWikiCatalog(await getReadyWikiStore(context), input) }
  } catch (error) {
    return { success: false, error: error instanceof WikiDomainToolError ? error.code : 'wiki_search_unavailable' }
  }
}

export async function openWikiPageForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.pageId !== 'string' || !input.pageId) return { success: false, error: 'wiki-page-unavailable' }
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1)) return { success: false, error: 'wiki-page-unavailable' }
  try {
    const store = await getReadyWikiStore(context)
    const service = await getPageReadService(store)
    return { success: true, data: await service.openPage(input.pageId, wikiCaller(context), input.revision as number | undefined) }
  } catch (error) {
    return { success: false, error: readErrorCode(error, 'wiki-page-unavailable') }
  }
}

export async function readWikiPageForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.readHandle !== 'string' || !input.readHandle) return { success: false, error: 'page_read_handle_expired' }
  try {
    const store = await getReadyWikiStore(context)
    const service = await getPageReadService(store)
    return { success: true, data: await service.readPage(input.readHandle, wikiCaller(context), {
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      ...(typeof input.startLine === 'number' ? { startLine: input.startLine } : {}),
      ...(typeof input.maxChars === 'number' ? { maxChars: input.maxChars } : {})
    }) }
  } catch (error) {
    return { success: false, error: readErrorCode(error, 'wiki-page-unavailable') }
  }
}

export async function readWikiSourceForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.sourceId !== 'string' || !input.sourceId) return { success: false, error: 'source_missing' }
  try {
    const store = await getReadyWikiStore(context)
    let service = sourceReadServices.get(store.root)
    if (!service) {
      service = createWikiSourceService({ store, resolveSourceRef: () => undefined, validateSource: async () => false, authorize: async () => true })
      sourceReadServices.set(store.root, service)
    }
    const sourceRevision = typeof input.sourceRevision === 'number' ? input.sourceRevision : undefined
    return { success: true, data: await service.readSource(input.sourceId, wikiCaller(context), {
      ...(sourceRevision !== undefined ? { sourceRevision } : {}),
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      ...(typeof input.maxChars === 'number' ? { maxChars: input.maxChars } : {})
    }) }
  } catch (error) {
    return { success: false, error: error instanceof WikiSourceError ? error.code : error instanceof WikiDomainToolError ? error.code : 'source_missing' }
  }
}

export async function searchWikiCatalog(store: WikiFileStore, input: WikiInput) {
  if (typeof input.query !== 'string' || input.query.length > 256) throw new WikiDomainToolError('wiki-search-query-invalid')
  const query = input.query.normalize('NFKC').trim().toLocaleLowerCase()
  const categoryId = typeof input.categoryId === 'string' ? input.categoryId : undefined
  const catalog = await store.readCatalog()
  const pages = [...(catalog?.pages ?? [])].filter((page) => {
    if (categoryId && page.categoryId !== categoryId) return false
    const searchable = `${page.title ?? ''}\n${page.summary ?? ''}\n${page.categoryId ?? ''}`.normalize('NFKC').toLocaleLowerCase()
    return !query || query.split(/\s+/).every((term) => searchable.includes(term))
  }).sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '') || a.pageId.localeCompare(b.pageId))
  const catalogHash = hash(JSON.stringify(catalog ?? { formatVersion: 1, pages: [] }))
  if (input.cursor !== undefined && typeof input.cursor !== 'string') throw new WikiDomainToolError('wiki-search-cursor-invalid')
  const cursor = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : undefined
  if (cursor && (cursor.catalogHash !== catalogHash || cursor.query !== query || cursor.categoryId !== categoryId)) throw new WikiDomainToolError('wiki-search-cursor-invalid')
  const offset = cursor?.offset ?? 0
  const requestedLimit = typeof input.limit === 'number' && Number.isSafeInteger(input.limit) ? input.limit : 8
  const limit = Math.min(20, Math.max(1, requestedLimit))
  const matches = pages.slice(offset, offset + limit).map((page) => ({
    pageId: page.pageId,
    title: page.title ?? '',
    categoryId: page.categoryId ?? '',
    summary: Array.from(page.summary ?? '').slice(0, 1000).join(''),
    revision: page.revision ?? 1
  }))
  const nextOffset = offset + matches.length
  return {
    matches,
    totalMatches: pages.length,
    truncated: nextOffset < pages.length,
    ...(nextOffset < pages.length ? { nextCursor: encodeCursor({ catalogHash, query, ...(categoryId ? { categoryId } : {}), offset: nextOffset }) } : {})
  }
}

async function getReadyWikiStore(context: Pick<WikiDomainContext, 'wikiConfig' | 'userDataDir'>): Promise<WikiFileStore> {
  if (!context.wikiConfig) throw new WikiDomainToolError('wiki_lifecycle_unavailable')
  const root = resolveSharedWikiRoot(context.userDataDir, context.wikiConfig)
  const lifecycle = await createWikiLifecycleController(root).read()
  if (lifecycle.lifecycle !== 'domain_ready' && lifecycle.lifecycle !== 'domain_enabled') throw new WikiDomainToolError('wiki_lifecycle_not_ready')
  return createWikiFileStore(root)
}

async function getPageReadService(store: WikiFileStore): Promise<PageReadService> {
  let cached = pageReadServices.get(store.root)
  if (!cached) {
    const pages: WikiPageReadRecord[] = []
    cached = { pages, service: createWikiDomainReadService({
      store,
      pages,
      authorize: async (pageId) => {
        const lifecycle = await createWikiLifecycleController(store.root).read()
        if (lifecycle.lifecycle !== 'domain_ready' && lifecycle.lifecycle !== 'domain_enabled') return false
        return (await store.readCatalog())?.pages.some((page) => page.pageId === pageId) ?? false
      }
    }) }
    pageReadServices.set(store.root, cached)
  }
  const catalog = await store.readCatalog()
  cached.pages.splice(0, cached.pages.length, ...(catalog?.pages ?? []).map((page) => ({
    pageId: page.pageId, path: page.path, title: page.title ?? '', categoryId: page.categoryId ?? '', revision: page.revision ?? 1,
    summary: page.summary ?? '', parentPageId: page.parentPageId ?? null, sourceRefs: page.sourceRefs ?? []
  })))
  return cached.service
}

function wikiCaller(context: Pick<ToolExecutionContext, 'sessionId' | 'lane' | 'remoteContext'>): WikiReadCaller {
  return { callerId: `${context.sessionId}:${context.remoteContext?.authOwner ?? 'local'}`, lane: context.lane ?? 'desktop' }
}

function readErrorCode(error: unknown, fallback: string): string {
  return error instanceof WikiDomainReadError ? error.code : error instanceof WikiDomainToolError ? error.code : fallback
}

interface SearchCursor { catalogHash: string; query: string; categoryId?: string; offset: number }
function encodeCursor(cursor: SearchCursor): string { return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') }
function decodeCursor(value: string): SearchCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SearchCursor
    if (!decoded || !/^[a-f0-9]{64}$/.test(decoded.catalogHash) || typeof decoded.query !== 'string' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || (decoded.categoryId !== undefined && typeof decoded.categoryId !== 'string')) throw new Error()
    return decoded
  } catch { throw new WikiDomainToolError('wiki-search-cursor-invalid') }
}
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

function requireRecord(value: unknown): WikiInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
  return structuredClone(value as WikiInput)
}
