import { describe, expect, it, beforeEach } from 'vitest'
import {
  getMaxParallelChatSessions,
  routeAddMessage,
  routePatchMessage,
  removeLiveMessage,
  initLiveSessionFromStore,
  getLiveMessages,
  clearLiveSession
} from './chatRunnerService'
import { store } from '../store'
import { setConfig } from '../store/configSlice'
import { setSession, setMessages } from '../store/chatSlice'
import type { Message } from '../../shared/domainTypes'
import { resetContextHistorySummaryForTest, selectContextSummaryScalars } from './contextHistorySummaryService'

const baseMsg = (over: Partial<Message>): Message => ({
  id: 'm1',
  sessionId: 's',
  role: 'user',
  content: 'x',
  timestamp: 1,
  status: 'sent',
  schemaVersion: 1,
  ...over
})

describe('getMaxParallelChatSessions', () => {
  beforeEach(() => {
    store.dispatch(setConfig(null))
  })

  it('uses config value when present', () => {
    store.dispatch(
      setConfig({
        locale: 'zh-CN',
        apiKeyPresent: true,
        baseUrl: '',
        llmServices: [],
        activeLlmServiceId: '',
        model: 'm',
        defaultModel: 'm',
        models: [],
        thinkingEnabled: true,
        workDir: '/tmp',
        maxParallelChatSessions: 5,
        tools: {
          enabled: true,
          allowedTools: [],
          deniedTools: [],
          pythonPath: 'python',
          scriptTimeout: 300,
          fileCheckpointingEnabled: true,
          maxFileSnapshots: 100,
          grepTimeoutSec: 60
        },
        skills: {
          autoDetect: true,
          maxConcurrent: 5,
          disabled: [],
          alwaysLoad: [],
          routing: {
            mode: 'llm',
            enabled: true,
            context: 'last_user_turn',
            contextTurns: 2,
            contextMaxChars: 2000,
            timeoutMs: 15000,
            includeTriggersInCatalog: false
          }
        }
      })
    )
    expect(getMaxParallelChatSessions()).toBe(5)
  })
})

describe('live context summary deltas', () => {
  beforeEach(() => resetContextHistorySummaryForTest())

  it('updates image and latest-thinking scalars on relevant live mutations and removes deleted rows', () => {
    const image = baseMsg({ id: 'live-image', role: 'user', attachments: [{ id: 'image', stagingKey: 'chat-attachments/image.png',
      fileName: 'image.png', mimeType: 'image/png', byteLength: 4096, width: 512, height: 512 }] })
    routeAddMessage('summary-live-session', image)
    expect(selectContextSummaryScalars('summary-live-session')).toEqual({ historyImageTokens: 400, thinkingTokensToExclude: 0 })

    const assistant = baseMsg({ id: 'live-thinking', sessionId: 'summary-live-session', role: 'assistant', timestamp: 2 })
    routeAddMessage('summary-live-session', assistant)
    routePatchMessage('summary-live-session', assistant.id, { thinking: { content: 'reasoning text', isVisible: true } })
    expect(selectContextSummaryScalars('summary-live-session')).toEqual({ historyImageTokens: 400, thinkingTokensToExclude: 4 })

    removeLiveMessage('summary-live-session', assistant.id)
    expect(selectContextSummaryScalars('summary-live-session')).toEqual({ historyImageTokens: 400, thinkingTokensToExclude: 0 })
  })
})

describe('routeAddMessage parallel isolation', () => {
  beforeEach(() => {
    clearLiveSession('s1')
    clearLiveSession('s2')
    store.dispatch(setSession('s2'))
    store.dispatch(setMessages([baseMsg({ id: 's2-only', sessionId: 's2' })]))
  })

  it('background session message does not enter Redux when viewing another session', () => {
    routeAddMessage('s1', baseMsg({ id: 'bg-user', sessionId: 's1', content: 'bg' }))
    const redux = store.getState().chat.messages
    expect(redux.some((m) => m.id === 'bg-user')).toBe(false)
    expect(getLiveMessages('s1')?.some((m) => m.id === 'bg-user')).toBe(true)
  })

  it('initLiveSessionFromStore only keeps target session rows', () => {
    initLiveSessionFromStore('s1')
    const live = getLiveMessages('s1') ?? []
    expect(live.every((m) => m.sessionId === 's1')).toBe(true)
  })

  it('initializes a live session without cloning the loaded Redux history', () => {
    const history = Array.from({ length: 500 }, (_, index) => baseMsg({ id: `history-${index}`, sessionId: 's1', timestamp: index }))
    store.dispatch(setMessages(history))
    initLiveSessionFromStore('s1')
    expect(getLiveMessages('s1')).toHaveLength(0)
    routeAddMessage('s1', baseMsg({ id: 'live-new', sessionId: 's1', timestamp: 501 }))
    expect(getLiveMessages('s1')?.map(({ id }) => id)).toEqual(['live-new'])
  })

  it('after clearLiveSession, routeAddMessage retains only new live deltas', () => {
    store.dispatch(
      setMessages([
        baseMsg({ id: 'u1', sessionId: 's1', role: 'user', content: 'first', timestamp: 1 }),
        baseMsg({ id: 'a1', sessionId: 's1', role: 'assistant', content: 'reply', timestamp: 2 })
      ])
    )
    clearLiveSession('s1')
    routeAddMessage('s1', baseMsg({ id: 'u2', sessionId: 's1', role: 'user', content: 'second', timestamp: 3 }))
    expect(getLiveMessages('s1')?.map((m) => m.id)).toEqual(['u2'])
  })
})
