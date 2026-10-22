import type { Message } from '../../../src/shared/domainTypes'
import type { SessionQueries } from '../public/ports'

type ChatMessageReadStorage = Readonly<{
  ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>
  queries: Pick<SessionQueries, 'readMessages'>
}>

/** Prepare a session body view asynchronously, then rerun the complete synchronous query. */
export async function readChatMessagesAfterPreparation(
  storage: ChatMessageReadStorage,
  input: Readonly<{ sessionId: string; limit?: number; offset?: number }>
): Promise<Message[]> {
  await storage.ensureChatBodyV1?.({ sessionId: input.sessionId })
  return storage.queries.readMessages(input)
}

export async function readChatMessageAfterPreparation(
  storage: Pick<ChatMessageReadStorage, 'ensureChatBodyV1'> & Readonly<{
    queries: Pick<SessionQueries, 'readMessage'>
  }>,
  input: Readonly<{ sessionId: string; messageId: string }>
) {
  await storage.ensureChatBodyV1?.({ sessionId: input.sessionId })
  return storage.queries.readMessage(input)
}

export async function prepareChatBodiesForSessions(
  storage: Readonly<{ ensureChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<unknown> }>,
  sessionIds: readonly string[]
): Promise<void> {
  await Promise.all([...new Set(sessionIds)].map((sessionId) => storage.ensureChatBodyV1?.({ sessionId })))
}
