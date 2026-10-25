import type { Message } from '../../../src/shared/domainTypes'
import type { ApiContextBaseline, ChatMessagePage, ExportPage, RetryContextTarget, SearchCorpusPage } from './model'
import { prepareChatBodyForRead, tryPreparedChatBodyForRead, type PreparedChatBodyReadPreparation } from './readPreparation'

async function prepareForRead(storage: PreparedChatBodyReadPreparation, sessionId: string, signal?: AbortSignal): Promise<unknown> {
  const immediate = tryPreparedChatBodyForRead(storage, sessionId)
  if (immediate.handled) return immediate.prepared
  return prepareChatBodyForRead(storage.ensureChatBodyV1, sessionId, signal)
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
      readPreparedChatPage?(input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number; prepared?: unknown }>): Promise<ChatMessagePage | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number }>
): Promise<ChatMessagePage> {
  const preparedView = await prepareForRead(storage, input.sessionId)
  const prepared = await storage.queries.readPreparedChatPage?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readChatPage(input)
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
