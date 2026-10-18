import { createHash } from 'node:crypto'
import { defineDirectTool, type RegisteredTool } from '../tools/plannedToolRegistry'
import type { ToolExecutionContext, ToolExecutorResult } from '../tools/types'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiFileStore } from './wikiFileStore'
import { resolveSharedWikiRoot } from './wikiInit'
import { parseWikiSchema } from './wikiSchema'
import type { WikiFileStore } from './wikiFileStore'

type WikiInput = Record<string, unknown>

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

async function getReadyWikiStore(context: Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir'>): Promise<WikiFileStore> {
  if (!context.wikiConfig) throw new WikiDomainToolError('wiki_lifecycle_unavailable')
  const root = resolveSharedWikiRoot(context.userDataDir, context.wikiConfig)
  const lifecycle = await createWikiLifecycleController(root).read()
  if (lifecycle.lifecycle !== 'domain_ready' && lifecycle.lifecycle !== 'domain_enabled') throw new WikiDomainToolError('wiki_lifecycle_not_ready')
  return createWikiFileStore(root)
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
