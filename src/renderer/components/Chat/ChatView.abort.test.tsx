import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import { ChatView } from './ChatView'
import type { AppConfig, Session } from '../../../shared/domainTypes'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_FEISHU_CONFIG, DEFAULT_SHELL_CONFIG, DEFAULT_SKILLS_CONFIG, DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { store } from '../../store'
import { setChatStatus, setMessages, setSession } from '../../store/chatSlice'
import { setConfig } from '../../store/configSlice'
import { setSessions } from '../../store/sessionSlice'

vi.mock('@xterm/xterm', () => ({ Terminal: class { loadAddon = vi.fn(); open = vi.fn(); write = vi.fn(); clear = vi.fn(); resize = vi.fn(); dispose = vi.fn(); onScroll = vi.fn(() => ({ dispose: vi.fn() })); buffer = { active: { length: 0, baseY: 0, viewportY: 0, getLine: () => ({ translateToString: () => '' }) } } } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 })) } }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class { serialize = vi.fn(() => '') } }))
vi.mock('../../utils/motionPreference', () => ({ scrollIntoViewWithMotionPreference: vi.fn() }))
vi.mock('../DetailPanel/DetailPanelContext', () => ({ useDetailPanel: () => ({ openFile: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('../../services/chatSearchAdapter', () => ({ useChatSearchAdapter: vi.fn() }))
vi.mock('./MessageInput', () => {
  const ReactLocal = require('react') as typeof import('react')
  return { MessageInput: ReactLocal.forwardRef(function MessageInputMock({ onAbort }: { onAbort?: () => void }, _ref: React.Ref<unknown>) {
    return <button aria-label="停止生成" onClick={onAbort}>停止生成</button>
  }) }
})

const session: Session = {
  id: 'session-a', name: 'Test', model: 'claude-sonnet-4-6', temperature: 0.7, maxTokens: 64000,
  createdAt: 1, updatedAt: 1, skillsState: { manualActivated: [], manualDisabled: [] }, metadata: {}, workDirProfileId: 'p1'
}

function config(): AppConfig {
  return {
    locale: 'zh-CN', apiKeyPresent: true, baseUrl: '', llmServices: [], activeLlmServiceId: '',
    model: 'claude-sonnet-4-6', defaultModel: 'claude-sonnet-4-6', models: [], thinkingEnabled: false,
    workDir: '/tmp', maxParallelChatSessions: 3,
    tools: { ...DEFAULT_TOOLS_CONFIG }, skills: { ...DEFAULT_SKILLS_CONFIG }, wiki: { ...DEFAULT_WIKI_CONFIG },
    feishu: { ...DEFAULT_FEISHU_CONFIG }, browser: { ...DEFAULT_BROWSER_CONFIG }, shell: { ...DEFAULT_SHELL_CONFIG },
    workDirProfiles: [{ id: 'p1', name: 'Default', path: '/tmp', isDefault: true }], activeWorkDirProfileId: 'p1'
  } as AppConfig
}

describe('ChatView stop action', () => {
  beforeEach(() => {
    store.dispatch(setConfig(config()))
    store.dispatch(setSession(session.id))
    store.dispatch(setSessions([session]))
    store.dispatch(setMessages([]))
    store.dispatch(setChatStatus({ status: 'streaming', sessionId: session.id, requestId: 'shared-request', turnId: 'turn-a' }))
    Object.assign(window.api, {
      chatGetMessagePage: vi.fn().mockResolvedValue({ entries: [], oldestSequence: null, hasMoreBefore: false }),
      chatGetApiContextBaseline: vi.fn().mockResolvedValue({ sessionId: session.id, entries: [] }),
      chatGetContextHistorySummaryBaseline: vi.fn().mockResolvedValue({ sessionId: session.id, entries: [] }),
      chatGetMessageSequence: vi.fn().mockResolvedValue(null),
      chatGetSearchCorpusPage: vi.fn().mockResolvedValue({ entries: [], nextSequence: 0, hasMore: false }),
      sessionGet: vi.fn().mockResolvedValue(session),
      sessionBackfillAutoTitleIfNeeded: vi.fn().mockResolvedValue(null),
      usageGet: vi.fn().mockResolvedValue(undefined),
      chatCancelTurn: vi.fn()
    })
  })

  it('routes the stop action through abortSessionRun and clears local running state immediately', async () => {
    render(<Provider store={store}><ConfigProvider><App><ChatView /></App></ConfigProvider></Provider>)
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))

    expect(window.api.chatCancelTurn).toHaveBeenCalledOnce()
    expect(window.api.chatCancelTurn).toHaveBeenCalledWith('turn-a')
    await waitFor(() => expect(store.getState().chat.runningSessions[session.id]).toBeUndefined())
  })

  it('turn 已结束但 renderer 仍残留 streaming assistant 时从持久消息页接管终态', async () => {
    const streaming = {
      id: 'assistant-orphaned-stream', sessionId: session.id, role: 'assistant' as const,
      content: 'partial', timestamp: 2, status: 'streaming' as const, schemaVersion: 1
    }
    const completed = { ...streaming, content: 'final answer', status: 'completed' as const }
    render(<Provider store={store}><ConfigProvider><App><ChatView /></App></ConfigProvider></Provider>)
    await waitFor(() => expect(window.api.chatGetMessagePage).toHaveBeenCalled())

    vi.mocked(window.api.chatGetMessagePage).mockResolvedValue({
      entries: [{ message: completed, sequence: 2 }], oldestSequence: 2, hasMoreBefore: false
    })
    act(() => {
      store.dispatch(setMessages([streaming]))
      store.dispatch(setChatStatus({ status: 'completed', requestId: null, sessionId: session.id, turnId: 'turn-a' }))
    })

    await waitFor(() => {
      expect(store.getState().chat.messages.find((message) => message.id === streaming.id)).toMatchObject({
        content: 'final answer', status: 'completed'
      })
    })
  })
})
