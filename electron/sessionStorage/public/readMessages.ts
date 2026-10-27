import type { Message } from '../../../src/shared/domainTypes'
import type { ApiContextBaseline, ChatMessagePage, ExportPage, RetryContextTarget, SearchCorpusPage } from './model'
import { prepareChatBodyForRead, tryPreparedChatBodyForRead, type PreparedChatBodyReadPreparation, type SessionSwitchReadTrace } from './readPreparation'
export type SessionSwitchTraceEvent = Readonly<{
  event: 'session.switch.trace'
  instance: 'main' | 'renderer'
  traceId: string
  rendererProcessId?: number
  requestOrdinal?: number
  outcome: 'ok' | 'error' | 'cancelled' | 'timeout'
  cachePath: 'ready' | 'prior-authority' | 'cold' | 'invalidated' | 'unknown'
  pageSize: number
  durationMs: number
  stages: readonly Readonly<{ name: string; durationMs: number; outcome: 'ok' | 'error' }>[]
}>

type SessionSwitchTraceSummary = Readonly<Pick<SessionSwitchTraceEvent, 'outcome' | 'cachePath' | 'pageSize'>>

const SESSION_SWITCH_TRACE_STAGES = new Set([
  'page-read', 'renderer-page-request', 'failure-reason-hydration', 'store-commit', 'render-commit',
  'next-paint', 'main-ipc', 'projection-prepare', 'source-identity', 'page-select', 'body-read',
  'final-source-check', 'source-page-read', 'source-spill-discovery', 'worker-startup', 'worker-queue', 'worker-read', 'source-spill-verify',
  'worker-transport', 'worker-exit-wait', 'legacy-fallback', 'background-scheduler'
])

/** Process-local phase timings. Only fixed labels and bounded scalar fields can enter diagnostics. */
export function createSessionSwitchTrace(options: Readonly<{
  instance: 'main' | 'renderer'
  traceId: string
  now?: () => number
  emit: (event: SessionSwitchTraceEvent) => void
}>) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.traceId)) throw new Error('SESSION_SWITCH_TRACE_ID_INVALID')
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const stages: Array<{ name: string; durationMs: number; outcome: 'ok' | 'error' }> = []
  let finished = false
  return {
    async measure<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
      if (finished) throw new Error('SESSION_SWITCH_TRACE_FINISHED')
      if (!SESSION_SWITCH_TRACE_STAGES.has(name)) throw new Error('SESSION_SWITCH_TRACE_LABEL_INVALID')
      const stageStartedAt = now()
      try {
        const value = await operation()
        stages.push({ name, durationMs: sessionSwitchDuration(now() - stageStartedAt), outcome: 'ok' })
        return value
      } catch (error) {
        stages.push({ name, durationMs: sessionSwitchDuration(now() - stageStartedAt), outcome: 'error' })
        throw error
      }
    },
    record(name: string, durationMs: number): void {
      if (finished || !SESSION_SWITCH_TRACE_STAGES.has(name) || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 600_000) {
        throw new Error('SESSION_SWITCH_TRACE_STAGE_INVALID')
      }
      stages.push({ name, durationMs: sessionSwitchDuration(durationMs), outcome: 'ok' })
    },
    finish(summary: SessionSwitchTraceSummary): void {
      const keys = Object.keys(summary).sort().join(',')
      if (finished || keys !== 'cachePath,outcome,pageSize' || !['ok', 'error', 'cancelled', 'timeout'].includes(summary.outcome) ||
        !['ready', 'prior-authority', 'cold', 'invalidated', 'unknown'].includes(summary.cachePath) ||
        !Number.isSafeInteger(summary.pageSize) || summary.pageSize < 0 || summary.pageSize > 200) {
        throw new Error('SESSION_SWITCH_TRACE_SUMMARY_INVALID')
      }
      finished = true
      try {
        options.emit(Object.freeze({
          event: 'session.switch.trace', instance: options.instance, traceId: options.traceId,
          outcome: summary.outcome, cachePath: summary.cachePath, pageSize: summary.pageSize,
          durationMs: sessionSwitchDuration(now() - startedAt), stages: Object.freeze(stages.map((stage) => Object.freeze({ ...stage })))
        }))
      } catch {
        // Diagnostics must never alter the read path.
      }
    }
  }
}

/** Wrap the IPC-owned page read and emit one bounded main-process trace on success or failure. */
export async function readChatPageWithSessionSwitchTrace<T extends Readonly<{ entries: readonly unknown[] }>>(
  read: (diagnostics: Readonly<{ trace: ReturnType<typeof createSessionSwitchTrace>; onCachePath: (path: 'ready' | 'prior-authority' | 'cold' | 'invalidated') => void }>) => Promise<T>,
  options: Readonly<{ traceId: string; rendererProcessId?: number; requestOrdinal?: number; emit: (event: SessionSwitchTraceEvent) => void }>
): Promise<T> {
  const trace = createSessionSwitchTrace({ instance: 'main', traceId: options.traceId, emit: (event) => options.emit({
    ...event,
    ...(Number.isSafeInteger(options.rendererProcessId) && options.rendererProcessId! >= 0 ? { rendererProcessId: options.rendererProcessId } : {}),
    ...(Number.isSafeInteger(options.requestOrdinal) && options.requestOrdinal! >= 1 ? { requestOrdinal: options.requestOrdinal } : {})
  }) })
  let cachePath: SessionSwitchTraceSummary['cachePath'] = 'unknown'
  try {
    const page = await trace.measure('main-ipc', () => read({ trace, onCachePath: (value) => { cachePath = value } }))
    trace.finish({ outcome: 'ok', cachePath, pageSize: page.entries.length })
    return page
  } catch (error) {
    trace.finish({ outcome: 'error', cachePath, pageSize: 0 })
    throw error
  }
}

function sessionSwitchDuration(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.max(0, value) * 100) / 100 : 0
}

async function prepareForRead(storage: PreparedChatBodyReadPreparation, sessionId: string, signal?: AbortSignal,
  onCachePath?: (path: 'ready' | 'prior-authority' | 'cold' | 'invalidated') => void): Promise<unknown> {
  const immediate = tryPreparedChatBodyForRead(storage, sessionId)
  onCachePath?.(immediate.cachePath)
  if (immediate.handled) return immediate.prepared
  const prepared = await prepareChatBodyForRead(storage.ensureChatBodyV1, sessionId, signal)
  if (prepared === undefined) onCachePath?.('invalidated')
  return prepared
}

type ChatMessageReadStorage = PreparedChatBodyReadPreparation & Readonly<{
  queries: Readonly<{
    readMessages(input: Readonly<{ sessionId: string; limit?: number; offset?: number }>): Message[]
    readPreparedMessages?(input: Readonly<{ sessionId: string; limit?: number; offset?: number; prepared?: unknown }>): Promise<Message[] | undefined>
  }>
}>

/** Prepare the derived view when possible, then execute the same authoritative query. */
export async function readChatMessagesAfterPreparation(
  storage: ChatMessageReadStorage,
  input: Readonly<{ sessionId: string; limit?: number; offset?: number }>
): Promise<Message[]> {
  const immediate = tryPreparedChatBodyForRead(storage, input.sessionId)
  if (immediate.handled && immediate.prepared === undefined) {
    const legacy = storage.readChatMessagesBeforePreparation?.(input)
    if (legacy !== undefined) return legacy as Message[]
    if (storage.requestChatBodyV1) {
      const preparedAfterFence = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
      const preparedRead = await storage.queries.readPreparedMessages?.({ ...input, prepared: preparedAfterFence })
      if (preparedRead) return preparedRead
      return storage.queries.readMessages(input)
    }
  }
  const preparedView = immediate.handled ? immediate.prepared : await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
  const prepared = await storage.queries.readPreparedMessages?.({ ...input, prepared: preparedView })
  if (prepared) return prepared
  return storage.queries.readMessages(input)
}

export async function readChatPageAfterPreparation(
  storage: PreparedChatBodyReadPreparation & Readonly<{
    queries: Readonly<{
      readChatPage(input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number }>): ChatMessagePage
      readSourceChatPage?(input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number;
        measure?: SessionSwitchReadTrace['measure']; recordStage?: SessionSwitchReadTrace['record'] }>): Promise<ChatMessagePage | undefined>
      readPreparedChatPage?(input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number; prepared?: unknown; measure?: SessionSwitchReadTrace['measure']; recordStage?: SessionSwitchReadTrace['record'] }>): Promise<ChatMessagePage | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number }>,
  diagnostics?: Readonly<{ trace?: SessionSwitchReadTrace; onCachePath?: (path: 'ready' | 'prior-authority' | 'cold' | 'invalidated') => void }>
): Promise<ChatMessagePage> {
  const measure = diagnostics?.trace ? diagnostics.trace.measure.bind(diagnostics.trace) : async <T>(_name: string, operation: () => T | Promise<T>) => operation()
  const readyView = storage.readPreparedChatBodyV1?.({ sessionId: input.sessionId })
  if (readyView !== undefined) {
    diagnostics?.onCachePath?.('ready')
    const readyPage = await storage.queries.readPreparedChatPage?.({ ...input, prepared: readyView, measure,
      recordStage: diagnostics?.trace?.record?.bind(diagnostics.trace) })
    if (readyPage) return readyPage
    diagnostics?.onCachePath?.('invalidated')
  }
  let sourcePage: ChatMessagePage | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      sourcePage = await measure('source-page-read', () => storage.queries.readSourceChatPage?.({ ...input, measure,
        recordStage: diagnostics?.trace?.record?.bind(diagnostics.trace) }))
      break
    } catch (error) {
      const retryable = error instanceof Error && ['PROJECTION_SOURCE_REVISION_CHANGED', 'PROJECTION_SOURCE_PAGE_CHANGED'].includes(error.message)
      if (!retryable || attempt === 1) throw error
    }
  }
  if (sourcePage) {
    diagnostics?.onCachePath?.('cold')
    return sourcePage
  }
  const preparedView = await measure('projection-prepare', () => prepareForRead(storage, input.sessionId, undefined, diagnostics?.onCachePath))
  const prepared = await storage.queries.readPreparedChatPage?.({ ...input, prepared: preparedView, measure, recordStage: diagnostics?.trace?.record?.bind(diagnostics.trace) })
  if (prepared) return prepared
  if (preparedView !== undefined) diagnostics?.onCachePath?.('invalidated')
  return measure('legacy-fallback', () => storage.queries.readChatPage(input))
}

export async function readApiBaselineAfterPreparation(
  storage: PreparedChatBodyReadPreparation & Readonly<{
    queries: Readonly<{
      readApiBaseline(input: Readonly<{ sessionId: string; limit?: number }>): ApiContextBaseline
      readPreparedApiBaseline?(input: Readonly<{ sessionId: string; limit?: number; prepared?: unknown }>): Promise<ApiContextBaseline | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; limit?: number }>
): Promise<ApiContextBaseline> {
  const preparedView = await prepareForRead(storage, input.sessionId)
  const prepared = await storage.queries.readPreparedApiBaseline?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readApiBaseline(input)
}

export async function readSearchCorpusPageAfterPreparation(
  storage: PreparedChatBodyReadPreparation & Readonly<{
    queries: Readonly<{
      readSearchCorpusPage(input: Readonly<{ sessionId: string; fromSequence: number; pageSize?: number }>): SearchCorpusPage
      readPreparedSearchCorpusPage?(input: Readonly<{ sessionId: string; fromSequence: number; pageSize?: number; prepared?: unknown }>): Promise<SearchCorpusPage | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; fromSequence: number; pageSize?: number }>
): Promise<SearchCorpusPage> {
  const preparedView = await prepareForRead(storage, input.sessionId)
  const prepared = await storage.queries.readPreparedSearchCorpusPage?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readSearchCorpusPage(input)
}

export async function readExportPageAfterPreparation(
  storage: PreparedChatBodyReadPreparation & Readonly<{
    queries: Readonly<{
      readExportPage(input: Readonly<{ sessionId: string; fromSequence: number; pageSize: number }>): ExportPage
      readPreparedExportPage?(input: Readonly<{ sessionId: string; fromSequence: number; pageSize: number; prepared?: unknown }>): Promise<ExportPage | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; fromSequence: number; pageSize: number; signal?: AbortSignal }>
): Promise<ExportPage> {
  const preparedView = await prepareForRead(storage, input.sessionId, input.signal)
  const prepared = await storage.queries.readPreparedExportPage?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readExportPage(input)
}

export async function readRetryTargetAfterPreparation(
  storage: PreparedChatBodyReadPreparation & Readonly<{
    queries: Readonly<{
      readRetryTarget(input: Readonly<{ sessionId: string; failedAssistantMessageId: string }>): RetryContextTarget | null
      readLatestRetryTarget(sessionId: string): RetryContextTarget | null
      readPreparedRetryTarget?(input: Readonly<{ sessionId: string; failedAssistantMessageId?: string; prepared?: unknown }>): Promise<RetryContextTarget | null | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; failedAssistantMessageId?: string }>
): Promise<RetryContextTarget | null> {
  const preparedView = await prepareForRead(storage, input.sessionId)
  const prepared = await storage.queries.readPreparedRetryTarget?.({ ...input, prepared: preparedView })
  if (prepared !== undefined) return prepared
  return input.failedAssistantMessageId
    ? storage.queries.readRetryTarget({ sessionId: input.sessionId, failedAssistantMessageId: input.failedAssistantMessageId })
    : storage.queries.readLatestRetryTarget(input.sessionId)
}

export async function readChatMessageAfterPreparation(
  storage: PreparedChatBodyReadPreparation & Readonly<{
    queries: Readonly<{
      readMessage(input: Readonly<{ sessionId: string; messageId: string }>): Message | undefined
      readPreparedMessage?(input: Readonly<{ sessionId: string; messageId: string; prepared?: unknown }>): Promise<Message | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; messageId: string }>
) {
  const preparedView = await prepareForRead(storage, input.sessionId)
  const prepared = await storage.queries.readPreparedMessage?.({ ...input, prepared: preparedView })
  if (prepared) return prepared
  return storage.queries.readMessage(input)
}

export async function prepareChatBodiesForSessions(
  storage: Readonly<{ ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown> }>,
  sessionIds: readonly string[]
): Promise<void> {
  await Promise.all([...new Set(sessionIds)].map((sessionId) => prepareChatBodyForRead(storage.ensureChatBodyV1, sessionId)))
}
