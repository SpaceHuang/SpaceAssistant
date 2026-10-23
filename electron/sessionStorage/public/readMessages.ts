import type { Message } from '../../../src/shared/domainTypes'
import type { ApiContextBaseline, ChatMessagePage } from './model'
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

export async function readChatMessageAfterPreparation(
  storage: Pick<ChatMessageReadStorage, 'ensureChatBodyV1'> & Readonly<{
    queries: Readonly<{ readMessage(input: Readonly<{ sessionId: string; messageId: string }>): Message | undefined }>
  }>,
  input: Readonly<{ sessionId: string; messageId: string }>
) {
  await prepareChatBodyForRead(storage.ensureChatBodyV1, input.sessionId)
  return storage.queries.readMessage(input)
}

export async function prepareChatBodiesForSessions(
  storage: Readonly<{ ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown> }>,
  sessionIds: readonly string[]
): Promise<void> {
  await Promise.all([...new Set(sessionIds)].map((sessionId) => prepareChatBodyForRead(storage.ensureChatBodyV1, sessionId)))
}
