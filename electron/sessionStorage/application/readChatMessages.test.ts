import { describe, expect, it } from 'vitest'
import { prepareChatBodiesForSessions, readChatMessageAfterPreparation, readChatMessagesAfterPreparation } from './readChatMessages'

describe('readChatMessagesAfterPreparation', () => {
  it('prepares the chat body view and reruns the complete synchronous selection', async () => {
    const events: string[] = []
    const messages = [{ id: 'selected-after-ensure' }]
    const result = await readChatMessagesAfterPreparation({
      ensureChatBodyV1: async ({ sessionId }) => { events.push(`ensure:${sessionId}`); return [{ id: 'discard-preparation-payload' }] },
      queries: { readMessages: (input) => { events.push(`select:${input.sessionId}`); return messages as never } }
    }, { sessionId: 'chat-session', limit: 20, offset: 3 })

    expect(result).toBe(messages)
    expect(events).toEqual(['ensure:chat-session', 'select:chat-session'])
  })

  it('prepares before selecting one message body', async () => {
    const events: string[] = []
    const message = { id: 'm', role: 'user', content: 'body', timestamp: 1 }
    const storage = {
      ensureChatBodyV1: async ({ sessionId }: { sessionId: string }) => { events.push(`ensure:${sessionId}`) },
      queries: { readMessage: (input: { sessionId: string; messageId: string }) => { events.push(`select:${input.sessionId}:${input.messageId}`); return message } }
    } as never

    await expect(readChatMessageAfterPreparation(storage, { sessionId: 's', messageId: 'm' })).resolves.toBe(message)
    expect(events).toEqual(['ensure:s', 'select:s:m'])
  })

  it('prepares each cross-session source once in stable order', async () => {
    const sessions: string[] = []
    await prepareChatBodiesForSessions({ ensureChatBodyV1: async ({ sessionId }) => { sessions.push(sessionId) } }, ['b', 'a', 'b'])
    expect(sessions).toEqual(['b', 'a'])
  })
})
