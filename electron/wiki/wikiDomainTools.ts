import { createHash } from 'node:crypto'
import { definePlannedTool, type DirectToolSpec, type RegisteredTool, type ToolExecutionContext as PreparedToolExecutionContext } from '../tools/plannedToolRegistry'
import type { ToolExecutionContext, ToolExecutorResult } from '../tools/types'
import { createWikiLifecycleController } from './wikiLifecycle'
import { reconcileExternalWikiChanges } from './wikiReconciliationService'
import { createWikiFileStore } from './wikiFileStore'
import { resolveSharedWikiRoot } from './wikiInit'
import { parseWikiSchema } from './wikiSchema'
import type { WikiFileStore } from './wikiFileStore'
import { createWikiDomainReadService, WikiDomainReadError, type WikiReadCaller, type WikiPageReadRecord } from './wikiDomainRead'
import { createWikiSourceService, WikiSourceError } from './wikiSourceService'
import { listWikiPageRevisions } from './wikiHistoryService'
import { createWikiSchemaProposalService, WikiSchemaProposalError } from './wikiSchemaProposal'
import { createWikiDomainCoordinator, hasRecoverableWikiOperation, type WikiDomainSchema } from './wikiDomainCoordinator'
import { createWikiHistoryService } from './wikiHistoryService'
import { parseWikiPageMarker } from './wikiReconciler'
import { normalizeWikiRelativePath } from './wikiPaths'
import { readWikiConfig } from './wikiConfigReader'

type WikiInput = Record<string, unknown>
type WikiDomainContext = Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir' | 'appDatabase' | 'sessionId' | 'lane' | 'remoteContext' | 'requestId' | 'toolUseId' | 'toolUserConfirmed' | 'userConfirmationAnswerer'>
type PageReadService = ReturnType<typeof createWikiDomainReadService>
const pageReadServices = new Map<string, { pages: WikiPageReadRecord[]; service: PageReadService }>()
const sourceReadServices = new Map<string, ReturnType<typeof createWikiSourceService>>()
const schemaProposalServices = new Map<string, ReturnType<typeof createWikiSchemaProposalService>>()
const historyServices = new Map<string, { schema: WikiDomainSchema; coordinator: ReturnType<typeof createWikiDomainCoordinator>; service: ReturnType<typeof createWikiHistoryService> }>()

/** Wiki domain calls still use their own object/revision checks, but must enter the prepared dispatch lane. */
function defineWikiTool(spec: DirectToolSpec<WikiInput, ToolExecutorResult>): RegisteredTool {
  return definePlannedTool<WikiInput, { input: WikiInput }, ToolExecutorResult>({
    name: spec.name,
    actionClass: spec.actionClass,
    parseInput: spec.parseInput,
    plan: async (input) => ({ input: structuredClone(input) }),
    execute: async ({ input }, context) => withWikiErrorEnvelope(await spec.execute(input, { runtimeContext: wikiExecutionContext(context) } as never)),
    facts: () => ({ operation: spec.name }),
    display: () => ({ operation: spec.name })
  })
}

function wikiExecutionContext(context: PreparedToolExecutionContext): ToolExecutionContext {
  // final-check: only the prepared host confirmation receipt supplies confirmation facts to Wiki executors.
  return {
    ...(context.runtimeContext ?? {}),
    requestId: context.requestId,
    toolUseId: context.toolUseId,
    toolUserConfirmed: Boolean(context.userConfirmationReceipt),
    ...(context.userConfirmationAnswerer ? { userConfirmationAnswerer: context.userConfirmationAnswerer } : {})
  } as ToolExecutionContext
}

export function createWikiDomainTools(): RegisteredTool[] {
  return [defineWikiTool({
    name: 'memory.wiki_get_schema',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (_input, context) => getWikiSchemaForContext(context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_import_source',
    actionClass: 'write',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => importWikiSourceForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_search',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => searchWikiForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_open_page',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => openWikiPageForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_read_page',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => readWikiPageForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_read_source',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => readWikiSourceForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_list_page_revisions',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => listWikiPageRevisionsForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_restore_page',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => prepareWikiRestoreForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_apply_restore',
    actionClass: 'write',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => applyWikiRestoreForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_save_page',
    actionClass: 'write',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => saveWikiPageForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_move_page',
    actionClass: 'write',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => moveWikiPageForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_propose_schema_change',
    actionClass: 'write',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => proposeWikiSchemaChangeForContext(input, context.runtimeContext as ToolExecutionContext)
  }), defineWikiTool({
    name: 'memory.wiki_update_schema',
    actionClass: 'write',
    parseInput: (input) => requireRecord(input),
    execute: async (input, context) => updateWikiSchemaForContext(input, context.runtimeContext as ToolExecutionContext)
  })]
}

export async function saveWikiPageForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.title !== 'string' || !input.title.trim() || typeof input.categoryId !== 'string' || typeof input.summary !== 'string' || typeof input.markdown !== 'string' ||
    !Number.isSafeInteger(input.schemaVersion) || (input.schemaVersion as number) < 1 ||
    (input.pageId !== undefined && (typeof input.pageId !== 'string' || !input.pageId)) ||
    (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1)) ||
    (input.parentPageId !== undefined && typeof input.parentPageId !== 'string') ||
    (input.pageId !== undefined && input.parentPageId !== undefined) ||
    (input.sourceRefs !== undefined && !isSourceRefs(input.sourceRefs))) return { success: false, error: 'wiki_page_input_invalid' }
  if (input.expectedRevision !== undefined && input.pageId === undefined) return { success: false, error: 'wiki_page_id_required_for_update' }
  if (!context.requestId || !context.toolUseId || !context.sessionId) return { success: false, error: 'wiki_invocation_invalid' }
  try {
    const store = await getReadyWikiStore(context, { operationIdentity: { requestId: context.requestId, toolUseId: context.toolUseId } })
    if (!(await validateSourceRefs(store, input.sourceRefs as Array<{ sourceId: string; sourceRevision: number }> | undefined))) return { success: false, error: 'source_missing' }
    const runtime = await getHistoryRuntime(store)
    const result = await runtime.coordinator.savePage({
      requestId: context.requestId, toolUseId: context.toolUseId, callerId: wikiCaller(context).callerId, lane: context.lane ?? 'desktop',
      ...(typeof input.pageId === 'string' ? { pageId: input.pageId } : {}), title: input.title, categoryId: input.categoryId, summary: input.summary, markdown: input.markdown,
      schemaVersion: input.schemaVersion as number, ...(typeof input.expectedRevision === 'number' ? { expectedRevision: input.expectedRevision } : {}),
      ...(typeof input.parentPageId === 'string' ? { parentPageId: input.parentPageId } : {}),
      ...(input.sourceRefs ? { sourceRefs: input.sourceRefs as Array<{ sourceId: string; sourceRevision: number }> } : {})
    })
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as { code?: string })?.code ?? (error instanceof WikiDomainToolError ? error.code : 'wiki_page_save_failed') } }
}

export async function moveWikiPageForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.pageId !== 'string' || !input.pageId || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
    (input.parentPageId !== undefined && input.parentPageId !== null && typeof input.parentPageId !== 'string')) return { success: false, error: 'wiki_page_input_invalid' }
  if (!context.requestId || !context.toolUseId || !context.sessionId) return { success: false, error: 'wiki_invocation_invalid' }
  try {
    const store = await getReadyWikiStore(context, { operationIdentity: { requestId: context.requestId, toolUseId: context.toolUseId } })
    const catalog = await store.readCatalog()
    const page = catalog?.pages.find(item => item.pageId === input.pageId)
    if (!page) return { success: false, error: 'page_not_found' }
    const parsed = parseWikiPageMarker((await store.readText(page.path)).replace(/\r\n/g, '\n'))
    if (!parsed.marker || parsed.marker.pageId !== input.pageId) return { success: false, error: 'wiki_external_change_conflict' }
    if (!(await validateSourceRefs(store, parsed.marker.sourceRefs))) return { success: false, error: 'source_missing' }
    const title = parsed.body.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim()
    if (!title) return { success: false, error: 'wiki_external_change_conflict' }
    const runtime = await getHistoryRuntime(store)
    const result = await runtime.coordinator.movePage({
      requestId: context.requestId, toolUseId: context.toolUseId, callerId: wikiCaller(context).callerId, lane: context.lane ?? 'desktop',
      pageId: input.pageId, expectedRevision: input.expectedRevision as number, parentPageId: typeof input.parentPageId === 'string' ? input.parentPageId : null,
      title, categoryId: parsed.marker.categoryId, summary: parsed.marker.summary,
      markdown: parsed.body.replace(/^#\s+.+?\s*#*\s*$(?:\r?\n)?/m, '').trim(), schemaVersion: runtime.schema.schemaVersion, sourceRefs: parsed.marker.sourceRefs
    })
    return { success: true, data: result }
  } catch (error) { return { success: false, error: (error as { code?: string })?.code ?? (error instanceof WikiDomainToolError ? error.code : 'wiki_page_move_failed') } }
}

function isSourceRefs(value: unknown): value is Array<{ sourceId: string; sourceRevision: number }> {
  return Array.isArray(value) && value.every(ref => !!ref && typeof ref === 'object' && !Array.isArray(ref) &&
    typeof (ref as { sourceId?: unknown }).sourceId === 'string' && /^[0-9a-f-]{36}$/i.test((ref as { sourceId: string }).sourceId) &&
    Number.isSafeInteger((ref as { sourceRevision?: unknown }).sourceRevision) && ((ref as { sourceRevision: number }).sourceRevision > 0) &&
    Object.keys(ref).every(key => key === 'sourceId' || key === 'sourceRevision'))
}

async function validateSourceRefs(store: WikiFileStore, refs?: Array<{ sourceId: string; sourceRevision: number }>): Promise<boolean> {
  for (const ref of refs ?? []) {
    const bindingText = await store.readText(`.wiki-service/sources/${ref.sourceId}.json`).catch(() => undefined)
    if (!bindingText) return false
    let binding: Record<string, unknown>
    try { binding = JSON.parse(bindingText) as Record<string, unknown> } catch { return false }
    if (binding.formatVersion !== 1 || binding.sourceId !== ref.sourceId || !Number.isSafeInteger(binding.sourceRevision) ||
      typeof binding.displayName !== 'string' || !binding.displayName || binding.displayName.includes('/') || binding.displayName.includes('\\') ||
      (binding.projectId !== undefined && typeof binding.projectId !== 'string') ||
      (binding.rawPath !== undefined && (typeof binding.rawPath !== 'string' || !binding.rawPath.startsWith('raw/') || normalizeWikiRelativePath(binding.rawPath) !== binding.rawPath)) || ref.sourceRevision > (binding.sourceRevision as number)) return false
    if (!await store.identity(`.wiki-service/source-history/${ref.sourceId}/${ref.sourceRevision}.md`)) return false
  }
  return true
}

export async function getWikiSchemaForContext(context: Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir' | 'appDatabase'>): Promise<ToolExecutorResult> {
  let store: WikiFileStore
  try { store = await getReadyWikiStore(context, { reconcileExternalChanges: false }) }
  catch (error) { return { success: false, error: error instanceof WikiDomainToolError ? error.code : 'wiki_schema_unavailable' } }
  let content = await store.readText('SCHEMA.md').catch(() => undefined)
  if (content === undefined) return { success: false, error: 'wiki_schema_unavailable' }
  let parsed = parseWikiSchema(content)
  if (parsed.valid) {
    const reconciliation = await reconcileExternalWikiChanges(store)
    if (reconciliation.diagnostics.length) return { success: false, error: 'wiki_external_change_conflict' }
    content = await store.readText('SCHEMA.md').catch(() => undefined)
    if (content === undefined) return { success: false, error: 'wiki_schema_unavailable' }
    parsed = parseWikiSchema(content)
    if (!parsed.valid) return { success: false, error: 'wiki_external_change_conflict' }
  }
  const stateText = await store.readText('.wiki-service/schema-state.json').catch(() => undefined)
  let schemaVersion = 1
  let schemaState: { contentHash?: string } | undefined
  if (stateText !== undefined) {
    try {
      const state = JSON.parse(stateText) as { formatVersion?: unknown; schemaVersion?: unknown; contentHash?: unknown }
      if (state.formatVersion !== 1 || !Number.isSafeInteger(state.schemaVersion) || (state.schemaVersion as number) < 1 || typeof state.contentHash !== 'string') return { success: false, error: 'wiki_schema_state_invalid' }
      schemaVersion = state.schemaVersion as number
      schemaState = { contentHash: state.contentHash }
    } catch {
      return { success: false, error: 'wiki_schema_state_invalid' }
    }
  }
  if (parsed.valid && schemaState?.contentHash !== hash(content)) return { success: false, error: 'wiki_external_change_conflict' }
  let lastValid: { schemaVersion: number; content: string; categories: ReturnType<typeof parseWikiSchema>['categories'] } | undefined
  if (!parsed.valid && schemaState?.contentHash) {
    const previous = await store.readText(`.wiki-service/schema-history/${schemaVersion}.md`).catch(() => undefined)
    if (previous !== undefined && hash(previous) === schemaState.contentHash) {
      const previousParsed = parseWikiSchema(previous)
      if (previousParsed.valid) lastValid = { schemaVersion, content: previous, categories: previousParsed.categories }
    }
  }
  return { success: true, data: { schemaVersion, content, valid: parsed.valid, categories: parsed.categories, diagnostics: parsed.diagnostics, ...(lastValid ? { lastValid } : {}) } }
}

export class WikiDomainToolError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WikiDomainToolError' }
}

export async function importWikiSourceForContext(
  input: WikiInput,
  context: WikiDomainContext
): Promise<ToolExecutorResult> {
  if (typeof input.sourceRef !== 'string' || !input.sourceRef || input.sourceRef.length > 1024) return { success: false, error: 'source_missing' }
  try {
    const store = await getReadyWikiStore(context)
    if (!/^[0-9a-f-]{36}$/i.test(input.sourceRef)) return { success: false, error: 'source_missing' }
    const sourceId = input.sourceRef
    const bindingText = await store.readText(`.wiki-service/sources/${sourceId}.json`).catch(() => undefined)
    if (!bindingText) return { success: false, error: 'source_missing' }
    const binding = JSON.parse(bindingText) as { formatVersion?: unknown; sourceId?: unknown; sourceRevision?: unknown; displayName?: unknown; projectId?: unknown; rawPath?: unknown }
    if (binding.formatVersion !== 1 || binding.sourceId !== sourceId || !Number.isSafeInteger(binding.sourceRevision) || typeof binding.displayName !== 'string' || !binding.displayName || typeof binding.rawPath !== 'string' || !binding.rawPath.startsWith('raw/')) return { success: false, error: 'source_missing' }
    await store.read(`.wiki-service/source-history/${sourceId}/${binding.sourceRevision}.md`)
    return { success: true, data: { sourceId, sourceRevision: binding.sourceRevision, displayName: binding.displayName, ...(typeof binding.projectId === 'string' ? { projectId: binding.projectId } : {}) } }
  } catch (error) {
    return { success: false, error: error instanceof WikiSourceError ? error.code : error instanceof WikiDomainToolError ? error.code : 'source_missing' }
  }
}

export async function searchWikiForContext(input: WikiInput, context: Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir' | 'appDatabase'>): Promise<ToolExecutorResult> {
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
    const page = await service.openPage(input.pageId, wikiCaller(context), input.revision as number | undefined)
    const sourceRefs = 'sourceRefs' in page && Array.isArray(page.sourceRefs) ? page.sourceRefs : []
    return { success: true, data: { ...page, sourceAttribution: await resolveSourceAttribution(store, sourceRefs) } }
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

export async function listWikiPageRevisionsForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.pageId !== 'string' || !input.pageId) return { success: false, error: 'wiki-page-unavailable' }
  try {
    const store = await getReadyWikiStore(context)
    const revisions = await listWikiPageRevisions(store, input.pageId)
    const enriched = await Promise.all(revisions.map(async revision => {
      const snapshot = await store.readText(`.wiki-service/page-history/${input.pageId}/${revision.revision}.md`).catch(() => '')
      const sourceRefs = parseWikiPageMarker(snapshot).marker?.sourceRefs ?? []
      return { ...revision, sourceRefs, sourceAttribution: await resolveSourceAttribution(store, sourceRefs) }
    }))
    return { success: true, data: enriched }
  } catch (error) {
    return { success: false, error: error instanceof WikiDomainToolError ? error.code : 'wiki-page-unavailable' }
  }
}

export async function prepareWikiRestoreForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.pageId !== 'string' || !input.pageId || !Number.isSafeInteger(input.targetRevision) || (input.targetRevision as number) < 1 || !Number.isSafeInteger(input.expectedCurrentRevision) || (input.expectedCurrentRevision as number) < 1) return { success: false, error: 'restore_conflict' }
  try {
    const store = await getReadyWikiStore(context)
    const runtime = await getHistoryRuntime(store)
    const overrides = {
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      ...(typeof input.categoryId === 'string' ? { categoryId: input.categoryId } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'parentPageId') ? { parentPageId: typeof input.parentPageId === 'string' ? input.parentPageId : null } : {})
    }
    const proposal = await runtime.service.prepareRestore({ pageId: input.pageId, targetRevision: input.targetRevision as number, expectedCurrentRevision: input.expectedCurrentRevision as number,
      callerId: wikiCaller(context).callerId, lane: context.lane ?? 'desktop', ...(Object.keys(overrides).length ? { overrides } : {}) })
    return { success: true, data: proposal }
  } catch (error) { return { success: false, error: error instanceof WikiDomainToolError ? error.code : 'restore_conflict' } }
}

export async function applyWikiRestoreForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.proposalId !== 'string' || !input.proposalId || !isRestoreFinalPage(input.finalPage)) return { success: false, error: 'restore_conflict' }
  try {
    const store = await getReadyWikiStore(context)
    const runtime = await getHistoryRuntime(store)
    const receipt = { proposalId: input.proposalId, requestId: context.requestId, toolUseId: context.toolUseId, sessionId: context.sessionId,
      lane: context.lane ?? 'desktop', confirmed: context.toolUserConfirmed === true, answerer: context.userConfirmationAnswerer }
    const result = await runtime.service.applyRestore(input.proposalId, { requestId: context.requestId ?? '', toolUseId: context.toolUseId ?? '', callerId: wikiCaller(context).callerId,
      lane: context.lane ?? 'desktop', receipt, expectedFinalPage: input.finalPage })
    return { success: true, data: result }
  } catch (error) { return wikiFailure((error as { code?: string }).code ?? 'restore_conflict', error) }
}

export async function proposeWikiSchemaChangeForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.content !== 'string' || !Number.isSafeInteger(input.expectedSchemaVersion) || (input.expectedSchemaVersion as number) < 1) return { success: false, error: 'schema_invalid' }
  try {
    const store = await getReadyWikiStore(context)
    const service = getSchemaProposalService(store)
    return { success: true, data: await service.propose(input.content, input.expectedSchemaVersion as number) }
  } catch (error) {
    return { success: false, error: error instanceof WikiSchemaProposalError ? error.code : error instanceof WikiDomainToolError ? error.code : 'schema_invalid' }
  }
}

export async function updateWikiSchemaForContext(input: WikiInput, context: WikiDomainContext): Promise<ToolExecutorResult> {
  if (typeof input.proposalId !== 'string' || !input.proposalId || !Number.isSafeInteger(input.expectedSchemaVersion) || (input.expectedSchemaVersion as number) < 1 ||
    !isSchemaProposalDiff(input.proposalDiff)) return { success: false, error: 'schema_material_mismatch' }
  try {
    const store = await getReadyWikiStore(context)
    const receipt = {
      proposalId: input.proposalId,
      requestId: context.requestId,
      toolUseId: context.toolUseId,
      sessionId: context.sessionId,
      lane: context.lane ?? 'desktop',
      confirmed: context.toolUserConfirmed === true,
      answerer: context.userConfirmationAnswerer
    }
    return { success: true, data: await getSchemaProposalService(store).apply(input.proposalId, input.expectedSchemaVersion as number, receipt,
      input.proposalDiff) }
  } catch (error) {
    return wikiFailure(error instanceof WikiSchemaProposalError ? error.code : error instanceof WikiDomainToolError ? error.code : (error as { code?: string }).code ?? 'schema_conflict', error)
  }
}

function wikiFailure(code: string, cause?: unknown): ToolExecutorResult {
  const messageByCode: Record<string, string> = {
    restore_conflict: '页面恢复与当前 Wiki 约束冲突。',
    schema_conflict: 'SCHEMA 基线或受影响页面已变化，请刷新后重试。',
    schema_material_mismatch: '确认内容与已保存的 SCHEMA 提案不一致。',
    external_change_conflict: '检测到 Wiki 文件外部变化，服务未覆盖该文件。',
    wiki_external_change_conflict: '检测到 Wiki 文件外部变化，服务未覆盖该文件。',
  }
  const value = cause && typeof cause === 'object' ? cause as { conflicts?: unknown; cause?: { code?: unknown; message?: unknown } } : undefined
  const diagnostics = [
    ...(Array.isArray(value?.conflicts) ? value!.conflicts.map(item => typeof item === 'string' ? { code, detail: item } : item) : []),
    ...(typeof value?.cause?.code === 'string' ? [{ code: value.cause.code, message: '底层 Wiki 校验未通过。' }] : []),
  ]
  const retryable = ['schema_conflict', 'revision_conflict', 'external_change_conflict', 'wiki_external_change_conflict', 'projection_pending', 'operation_pending', 'page_read_handle_expired'].includes(code)
  return { success: false, error: code, data: { error: { code, message: messageByCode[code] ?? 'Wiki 操作未完成。', retryable, diagnostics } } }
}

function withWikiErrorEnvelope(result: ToolExecutorResult): ToolExecutorResult {
  if (result.success || typeof result.error !== 'string') return result
  const existingData = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {}
  const existingError = existingData.error && typeof existingData.error === 'object' ? existingData.error as { code?: unknown } : undefined
  if (existingError && existingError.code === result.error) return result
  const normalized = wikiFailure(result.error)
  const structured = (normalized.data as { error: unknown }).error
  return { ...result, data: { ...existingData, error: structured } }
}

function isSchemaProposalDiff(value: unknown): value is { before: string; after: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const diff = value as Record<string, unknown>
  return typeof diff.before === 'string' && typeof diff.after === 'string' && Object.keys(diff).every(key => key === 'before' || key === 'after')
}

export async function searchWikiCatalog(store: WikiFileStore, input: WikiInput) {
  if (typeof input.query !== 'string' || input.query.length > 256) throw new WikiDomainToolError('wiki-search-query-invalid')
  const query = input.query.normalize('NFKC').trim().toLocaleLowerCase()
  const terms = query ? query.split(/\s+/) : []
  const categoryId = typeof input.categoryId === 'string' ? input.categoryId : undefined
  const catalog = await store.readCatalog()
  const pages = [] as Array<{ page: NonNullable<typeof catalog>['pages'][number]; priority: number; matchLine?: number; snippet: string; sourceRefs: Array<{ sourceId: string; sourceRevision: number }>; sourceAttribution: { sourceIds: string[]; projectIds: string[] }; updatedAt: number }>
  for (const page of catalog?.pages ?? []) {
    if (categoryId && page.categoryId !== categoryId) continue
    let body = ''
    let sourceRefs = page.sourceRefs ?? []
    try {
      const stored = await store.readText(page.path)
      const parsed = parseWikiPageMarker(stored)
      if (!parsed.marker || parsed.marker.pageId === page.pageId) {
        if (!page.sourceRefs?.length && parsed.marker) sourceRefs = parsed.marker.sourceRefs
        body = parsed.body.replace(/^#\s+.+?\s*#*\s*$(?:\r?\n)?/m, '').replace(/^\r?\n/, '')
      }
    } catch { /* catalog metadata remains searchable when a page disappears before reconciliation */ }
    const titleText = (page.title ?? '').normalize('NFKC').toLocaleLowerCase()
    const summaryText = (page.summary ?? '').normalize('NFKC').toLocaleLowerCase()
    const bodyText = body.normalize('NFKC').toLocaleLowerCase()
    const hasAll = (value: string) => !terms.length || terms.every(term => value.includes(term))
    const categoryText = (page.categoryId ?? '').normalize('NFKC').toLocaleLowerCase()
    const searchable = `${titleText}\n${summaryText}\n${categoryText}\n${bodyText}`
    if (!hasAll(searchable)) continue
    const priority = !terms.length || hasAll(titleText) ? 0 : hasAll(summaryText) ? 1 : hasAll(bodyText) ? 2 : 3
    const lines = body.split(/\r?\n/)
    const matchingLineIndex = terms.length ? lines.findIndex(line => terms.some(term => line.normalize('NFKC').toLocaleLowerCase().includes(term))) : -1
    const snippetSource = matchingLineIndex >= 0 ? lines[matchingLineIndex]! : page.summary ?? page.title ?? ''
    const snippet = clipWikiSnippet(snippetSource, terms[0] ?? '')
    const sourceAttribution = await resolveSourceAttribution(store, sourceRefs)
    const identity = await store.identity(page.path).catch(() => null)
    pages.push({ page, priority, ...(matchingLineIndex >= 0 ? { matchLine: matchingLineIndex + 1 } : {}), snippet,
      sourceRefs: sourceRefs.map(ref => ({ ...ref })), sourceAttribution, updatedAt: identity?.mtimeMs ?? 0 })
  }
  pages.sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt || (a.page.title ?? '').localeCompare(b.page.title ?? '') || a.page.pageId.localeCompare(b.page.pageId))
  const catalogHash = hash(JSON.stringify(catalog ?? { formatVersion: 1, pages: [] }))
  if (input.cursor !== undefined && typeof input.cursor !== 'string') throw new WikiDomainToolError('wiki-search-cursor-invalid')
  const cursor = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : undefined
  if (cursor && (cursor.catalogHash !== catalogHash || cursor.query !== query || cursor.categoryId !== categoryId)) throw new WikiDomainToolError('wiki-search-cursor-invalid')
  const offset = cursor?.offset ?? 0
  const requestedLimit = typeof input.limit === 'number' && Number.isSafeInteger(input.limit) ? input.limit : 8
  const limit = Math.min(20, Math.max(1, requestedLimit))
  const matches = pages.slice(offset, offset + limit).map(({ page, matchLine, snippet, sourceRefs, sourceAttribution }) => ({
    pageId: page.pageId,
    pageRef: { type: 'wiki_page' as const, pageId: page.pageId },
    title: page.title ?? '',
    categoryId: page.categoryId ?? '',
    summary: Array.from(page.summary ?? '').slice(0, 1000).join(''),
    snippet,
    ...(matchLine !== undefined ? { matchLine } : {}),
    sourceAttribution,
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

function clipWikiSnippet(value: string, term: string): string {
  const chars = Array.from(value)
  if (chars.length <= 500) return value
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const index = term ? normalized.indexOf(term) : 0
  const start = Math.max(0, Math.min(chars.length - 500, index >= 0 ? index - 120 : 0))
  return `${start > 0 ? '…' : ''}${chars.slice(start, start + 500).join('')}${start + 500 < chars.length ? '…' : ''}`
}

async function resolveSourceAttribution(store: WikiFileStore, value: unknown): Promise<{ sourceIds: string[]; projectIds: string[] }> {
  const sourceIds = new Set<string>()
  const projectIds = new Set<string>()
  if (!Array.isArray(value)) return { sourceIds: [], projectIds: [] }
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const ref = item as { sourceId?: unknown; sourceRevision?: unknown }
    if (typeof ref.sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(ref.sourceId) || !Number.isSafeInteger(ref.sourceRevision) || (ref.sourceRevision as number) < 1) continue
    sourceIds.add(ref.sourceId)
    try {
      const binding = JSON.parse(await store.readText(`.wiki-service/sources/${ref.sourceId}.json`)) as { formatVersion?: unknown; sourceId?: unknown; sourceRevision?: unknown; projectId?: unknown }
      if (binding.formatVersion !== 1 || binding.sourceId !== ref.sourceId || !Number.isSafeInteger(binding.sourceRevision) ||
        (binding.sourceRevision as number) < (ref.sourceRevision as number) || typeof binding.projectId !== 'string' || !binding.projectId) continue
      if (binding.sourceRevision !== ref.sourceRevision && !await store.identity(`.wiki-service/source-history/${ref.sourceId}/${ref.sourceRevision}.md`)) continue
      projectIds.add(binding.projectId)
    } catch { /* absent or invalid source metadata does not justify project attribution */ }
  }
  return { sourceIds: [...sourceIds].sort(), projectIds: [...projectIds].sort() }
}

async function getReadyWikiStore(
  context: Pick<WikiDomainContext, 'wikiConfig' | 'userDataDir' | 'appDatabase'>,
  options: { reconcileExternalChanges?: boolean; operationIdentity?: { requestId: string; toolUseId: string } } = {}
): Promise<WikiFileStore> {
  const wikiConfig = context.wikiConfig ?? (context.appDatabase ? readWikiConfig(context.appDatabase) : undefined)
  if (!wikiConfig) throw new WikiDomainToolError('wiki_lifecycle_unavailable')
  const root = resolveSharedWikiRoot(context.userDataDir, wikiConfig)
  const lifecycle = await createWikiLifecycleController(root).read()
  if (lifecycle.lifecycle !== 'domain_ready' && lifecycle.lifecycle !== 'domain_enabled') throw new WikiDomainToolError('wiki_lifecycle_not_ready')
  const store = createWikiFileStore(root)
  const recoveringOperation = options.operationIdentity
    ? await hasRecoverableWikiOperation(store, options.operationIdentity.requestId, options.operationIdentity.toolUseId)
    : false
  if (options.reconcileExternalChanges !== false && !recoveringOperation && await store.identity('SCHEMA.md')) {
    const reconciliation = await reconcileExternalWikiChanges(store)
    if (reconciliation.diagnostics.length) throw new WikiDomainToolError('wiki_external_change_conflict')
  }
  return store
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
        const catalog = await store.readCatalog()
        return catalog?.pages.some((page) => page.pageId === pageId) || catalog?.tombstones?.some((page) => page.pageId === pageId) || false
      }
    }) }
    pageReadServices.set(store.root, cached)
  }
  const catalog = await store.readCatalog()
  cached.pages.splice(0, cached.pages.length,
    ...(catalog?.pages ?? []).map((page) => ({
      pageId: page.pageId, path: page.path, title: page.title ?? '', categoryId: page.categoryId ?? '', revision: page.revision ?? 1,
      summary: page.summary ?? '', parentPageId: page.parentPageId ?? null, sourceRefs: page.sourceRefs ?? []
    })),
    ...(catalog?.tombstones ?? []).map((page) => ({
      pageId: page.pageId, path: page.path, title: '', categoryId: '', revision: page.revision, deleted: true as const
    }))
  )
  return cached.service
}

function getSchemaProposalService(store: WikiFileStore): ReturnType<typeof createWikiSchemaProposalService> {
  let service = schemaProposalServices.get(store.root)
  if (!service) {
    service = createWikiSchemaProposalService({ store, verifyConfirmation: (receipt, proposalId) => {
      // final-check: only host-derived confirmation on the current non-automation invocation can apply this proposal.
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false
      const value = receipt as Record<string, unknown>
      return value.proposalId === proposalId && typeof value.requestId === 'string' && !!value.requestId &&
        typeof value.toolUseId === 'string' && !!value.toolUseId && typeof value.sessionId === 'string' && !!value.sessionId &&
        typeof value.lane === 'string' && value.lane !== 'automation' && value.confirmed === true && value.answerer === 'user'
    } })
    schemaProposalServices.set(store.root, service)
  }
  return service
}

async function getHistoryRuntime(store: WikiFileStore) {
  const content = await store.readText('SCHEMA.md').catch(() => undefined)
  if (content === undefined) throw new WikiDomainToolError('wiki_schema_unavailable')
  const parsed = parseWikiSchema(content)
  if (!parsed.valid) throw new WikiDomainToolError('wiki_schema_unavailable')
  const stateText = await store.readText('.wiki-service/schema-state.json').catch(() => undefined)
  let schemaVersion = 1
  if (stateText !== undefined) {
    try {
      const state = JSON.parse(stateText) as { formatVersion?: unknown; schemaVersion?: unknown }
      if (state.formatVersion !== 1 || !Number.isSafeInteger(state.schemaVersion) || (state.schemaVersion as number) < 1) throw new Error()
      schemaVersion = state.schemaVersion as number
    } catch { throw new WikiDomainToolError('wiki_schema_state_invalid') }
  }
  let runtime = historyServices.get(store.root)
  if (!runtime) {
    const state: { schema: WikiDomainSchema } = { schema: { schemaVersion, categories: parsed.categories } }
    const coordinator = createWikiDomainCoordinator({ store, schema: () => state.schema })
    const service = createWikiHistoryService({ store, coordinator, schema: () => ({ schemaVersion: state.schema.schemaVersion, categories: state.schema.categories }), verifyConfirmation: (receipt, proposalId) => {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false
      const value = receipt as Record<string, unknown>
      return value.proposalId === proposalId && typeof value.requestId === 'string' && !!value.requestId && typeof value.toolUseId === 'string' && !!value.toolUseId &&
        typeof value.sessionId === 'string' && !!value.sessionId && typeof value.lane === 'string' && value.lane !== 'automation' && value.confirmed === true && value.answerer === 'user'
    } })
    runtime = { schema: state.schema, coordinator, service }
    historyServices.set(store.root, runtime)
  } else Object.assign(runtime.schema, { schemaVersion, categories: parsed.categories })
  return runtime
}

function isRestoreFinalPage(value: unknown): value is { title: string; categoryId: string; summary: string; markdown: string; parentPageId: string | null; sourceRefs: Array<{ sourceId: string; sourceRevision: number }> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const page = value as Record<string, unknown>
  return typeof page.title === 'string' && typeof page.categoryId === 'string' && typeof page.summary === 'string' && typeof page.markdown === 'string' &&
    (page.parentPageId === null || typeof page.parentPageId === 'string') && Array.isArray(page.sourceRefs) && page.sourceRefs.every(ref => !!ref && typeof ref === 'object' &&
      typeof (ref as { sourceId?: unknown }).sourceId === 'string' && Number.isSafeInteger((ref as { sourceRevision?: unknown }).sourceRevision))
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
