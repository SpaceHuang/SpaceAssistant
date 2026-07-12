import { vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage } from '@wechatbot/wechatbot'

type MockBotState = {
  loggedIn: boolean
  pollState: 'stopped' | 'polling'
}

export type MockWeChatBot = EventEmitter & {
  login: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  reply: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  sendTyping: ReturnType<typeof vi.fn>
  stopTyping: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  getCredentials: ReturnType<typeof vi.fn>
  use: ReturnType<typeof vi.fn>
  onMessage: (handler: (msg: IncomingMessage) => void) => void
  _emitMessage: (msg: IncomingMessage) => void
  _state: MockBotState
}

export function makeIncomingMessage(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    userId: 'wx-user@test',
    text: 'hello',
    type: 'text',
    timestamp: new Date(),
    images: [],
    voices: [],
    files: [],
    videos: [],
    raw: {
      from_user_id: 'wx-user@test',
      to_user_id: 'bot',
      client_id: 'cid-mock',
      create_time_ms: Date.now(),
      message_type: 1,
      message_state: 2,
      context_token: 'ctx',
      item_list: []
    },
    _contextToken: 'ctx',
    ...partial
  } as IncomingMessage
}

export function createMockWeChatBot(): MockWeChatBot {
  let messageHandler: ((msg: IncomingMessage) => void) | undefined
  const bot = new EventEmitter() as MockWeChatBot
  bot._state = { loggedIn: false, pollState: 'stopped' }
  bot.use = vi.fn()
  bot.login = vi.fn(async () => {
    bot._state.loggedIn = true
    return { accountId: 'acc-1234', userId: 'user@wx' }
  })
  bot.logout = vi.fn(async () => {
    bot._state.loggedIn = false
  })
  bot.start = vi.fn(async () => {
    bot._state.pollState = 'polling'
  })
  bot.stop = vi.fn(async () => {
    bot._state.pollState = 'stopped'
  })
  bot.reply = vi.fn(async () => undefined)
  bot.send = vi.fn(async () => undefined)
  bot.sendTyping = vi.fn(async () => undefined)
  bot.stopTyping = vi.fn(async () => undefined)
  bot.download = vi.fn(async () => ({
    data: Buffer.from('mock'),
    type: 'image' as const,
    fileName: 'mock.jpg'
  }))
  bot.getCredentials = vi.fn(() => ({ accountId: 'acc-1234', userId: 'user@wx' }))
  ;(bot as unknown as { storage: { clear: ReturnType<typeof vi.fn> } }).storage = { clear: vi.fn(async () => undefined) }
  bot.onMessage = (handler) => {
    messageHandler = handler
  }
  bot._emitMessage = (msg) => messageHandler?.(msg)
  return bot
}
