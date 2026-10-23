import type { Message } from '../../../src/shared/domainTypes'
import type { ApiContextBaseline, ChatMessagePage, ExportPage, RetryContextTarget, SearchCorpusPage } from './model'
import { prepareChatBodyForRead } from './readPreparation'

type ChatMessageReadStorage = Readonly<{
  ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
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
  const preparedView = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
  const prepared = await storage.queries.readPreparedMessages?.({ ...input, prepared: preparedView })
  if (prepared) return prepared
  return storage.queries.readMessages(input)
}

export async function readChatPageAfterPreparation(
  storage: Readonly<{
    ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
    queries: Readonly<{
      readChatPage(input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number }>): ChatMessagePage
      readPreparedChatPage?(input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number; prepared?: unknown }>): Promise<ChatMessagePage | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; beforeSequence?: number | null; limit?: number }>
): Promise<ChatMessagePage> {
  const preparedView = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
  const prepared = await storage.queries.readPreparedChatPage?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readChatPage(input)
}

export async function readApiBaselineAfterPreparation(
  storage: Readonly<{
    ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
    queries: Readonly<{
      readApiBaseline(input: Readonly<{ sessionId: string; limit?: number }>): ApiContextBaseline
      readPreparedApiBaseline?(input: Readonly<{ sessionId: string; limit?: number; prepared?: unknown }>): Promise<ApiContextBaseline | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; limit?: number }>
): Promise<ApiContextBaseline> {
  const preparedView = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
  const prepared = await storage.queries.readPreparedApiBaseline?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readApiBaseline(input)
}

export async function readSearchCorpusPageAfterPreparation(
  storage: Readonly<{
    ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
    queries: Readonly<{
      readSearchCorpusPage(input: Readonly<{ sessionId: string; fromSequence: number; pageSize?: number }>): SearchCorpusPage
      readPreparedSearchCorpusPage?(input: Readonly<{ sessionId: string; fromSequence: number; pageSize?: number; prepared?: unknown }>): Promise<SearchCorpusPage | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; fromSequence: number; pageSize?: number }>
): Promise<SearchCorpusPage> {
  const preparedView = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
  const prepared = await storage.queries.readPreparedSearchCorpusPage?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readSearchCorpusPage(input)
}

export async function readExportPageAfterPreparation(
  storage: Readonly<{
    ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
    queries: Readonly<{
      readExportPage(input: Readonly<{ sessionId: string; fromSequence: number; pageSize: number }>): ExportPage
      readPreparedExportPage?(input: Readonly<{ sessionId: string; fromSequence: number; pageSize: number; prepared?: unknown }>): Promise<ExportPage | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; fromSequence: number; pageSize: number; signal?: AbortSignal }>
): Promise<ExportPage> {
  const preparedView = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId, input.signal)
  const prepared = await storage.queries.readPreparedExportPage?.({ ...input, prepared: preparedView })
  return prepared ?? storage.queries.readExportPage(input)
}

export async function readRetryTargetAfterPreparation(
  storage: Readonly<{
    ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
    queries: Readonly<{
      readRetryTarget(input: Readonly<{ sessionId: string; failedAssistantMessageId: string }>): RetryContextTarget | null
      readLatestRetryTarget(sessionId: string): RetryContextTarget | null
      readPreparedRetryTarget?(input: Readonly<{ sessionId: string; failedAssistantMessageId?: string; prepared?: unknown }>): Promise<RetryContextTarget | null | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; failedAssistantMessageId?: string }>
): Promise<RetryContextTarget | null> {
  const preparedView = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
  const prepared = await storage.queries.readPreparedRetryTarget?.({ ...input, prepared: preparedView })
  if (prepared !== undefined) return prepared
  return input.failedAssistantMessageId
    ? storage.queries.readRetryTarget({ sessionId: input.sessionId, failedAssistantMessageId: input.failedAssistantMessageId })
    : storage.queries.readLatestRetryTarget(input.sessionId)
}

export async function readChatMessageAfterPreparation(
  storage: Pick<ChatMessageReadStorage, 'ensureChatBodyV1'> & Readonly<{
    queries: Readonly<{
      readMessage(input: Readonly<{ sessionId: string; messageId: string }>): Message | undefined
      readPreparedMessage?(input: Readonly<{ sessionId: string; messageId: string; prepared?: unknown }>): Promise<Message | undefined>
    }>
  }>,
  input: Readonly<{ sessionId: string; messageId: string }>
) {
  const preparedView = await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
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
