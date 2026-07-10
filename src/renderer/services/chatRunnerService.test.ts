import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  getMaxParallelChatSessions,
  mergeDbAndLive,
  routeAddMessage,
  initLiveSessionFromStore,
  getLiveMessages,
  clearLiveSession,
  registerToolChatController,
  getToolChatController,
  unregisterToolChatController
} from './chatRunnerService'
import { store } from '../store'
import { setConfig } from '../store/configSlice'
import { setSession, setMessages } from '../store/chatSlice'
import type { Message } from '../../shared/domainTypes'

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
          confirmMode: 'diff',
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

describe('mergeDbAndLive', () => {
  it('returns db when live empty', () => {
    const db = [baseMsg({ id: 'a', timestamp: 1 })]
    expect(mergeDbAndLive(db, null)).toEqual(db)
    expect(mergeDbAndLive(db, [])).toEqual(db)
  })

  it('overrides same id with live version', () => {
    const db = [baseMsg({ id: 'a', content: 'db', timestamp: 1 })]
    const live = [baseMsg({ id: 'a', content: 'live', timestamp: 1 })]
    const merged = mergeDbAndLive(db, live)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.content).toBe('live')
  })

  it('includes ids only in live', () => {
    const db = [baseMsg({ id: 'a', timestamp: 1 })]
    const live = [baseMsg({ id: 'a', timestamp: 1 }), baseMsg({ id: 'b', timestamp: 2 })]
    const merged = mergeDbAndLive(db, live)
    expect(merged.map((m) => m.id).sort()).toEqual(['a', 'b'])
  })

  it('sorts by timestamp', () => {
    const db = [baseMsg({ id: 'late', timestamp: 10 })]
    const live = [baseMsg({ id: 'early', timestamp: 2 })]
    const merged = mergeDbAndLive(db, live)
    expect(merged[0]?.id).toBe('early')
    expect(merged[1]?.id).toBe('late')
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
})

describe('tool chat controller registry', () => {
  it('register and resolve by requestId', () => {
    const controller = { subscribe: vi.fn(), unsubscribe: vi.fn(), applyConfirmOutcome: vi.fn() }
    registerToolChatController('req-a', controller)
    expect(getToolChatController('req-a')).toBe(controller)
    unregisterToolChatController('req-a')
    expect(getToolChatController('req-a')).toBeUndefined()
  })
})
