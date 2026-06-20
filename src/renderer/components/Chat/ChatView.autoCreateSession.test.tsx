import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import { ChatView } from './ChatView'
import type { AppConfig, Session } from '../../../shared/domainTypes'
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_FEISHU_CONFIG,
  DEFAULT_SHELL_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_WIKI_CONFIG
} from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'
import { runClaudeChatStream } from '../../services/chatStreamService'
import { store } from '../../store'
import { setMessages, setSession } from '../../store/chatSlice'
import { setConfig } from '../../store/configSlice'
import { setSessions } from '../../store/sessionSlice'

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    clear = vi.fn()
    resize = vi.fn()
    dispose = vi.fn()
    scrollToBottom = vi.fn()
    onScroll = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    hasSelection = vi.fn(() => false)
    getSelection = vi.fn(() => '')
    buffer = {
      active: {
        length: 1,
        baseY: 0,
        viewportY: 0,
        getLine: () => ({ translateToString: () => 'line' })
      }
    }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }))
  }
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    serialize = vi.fn(() => 'serialized')
  }
}))

vi.mock('../../utils/chatScroll', () => ({
  isChatScrollNearBottom: vi.fn(() => true),
  scrollChatToBottom: vi.fn()
}))

vi.mock('../../utils/motionPreference', () => ({
  scrollIntoViewWithMotionPreference: vi.fn()
}))

vi.mock('../DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => ({ openFile: vi.fn().mockResolvedValue(undefined) })
}))

vi.mock('../../services/chatSearchAdapter', () => ({
  useChatSearchAdapter: vi.fn()
}))

vi.mock('../../services/chatStreamService', () => ({
  runClaudeChatStream: vi.fn(async (_payload, callbacks) => {
    callbacks.onDone({ usage: { input_tokens: 1, output_tokens: 1 } })
  })
}))

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    locale: 'zh-CN',
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: [],
    activeLlmServiceId: '',
    model: 'claude-sonnet-4-6',
    defaultModel: 'claude-sonnet-4-6',
    temperature: 0.7,
    models: [
      {
        id: '1',
        name: 'claude-sonnet-4-6',
        maximumContext: 200000,
        maxTokens: 64000,
        isDefault: false,
        isFast: false,
        enabled: true
      }
    ],
    thinkingEnabled: false,
    workDir: '',
    maxParallelChatSessions: 3,
    tools: { ...DEFAULT_TOOLS_CONFIG, enabled: false },
    skills: { ...DEFAULT_SKILLS_CONFIG },
    wiki: { ...DEFAULT_WIKI_CONFIG },
    feishu: { ...DEFAULT_FEISHU_CONFIG },
    browser: { ...DEFAULT_BROWSER_CONFIG },
    shell: { ...DEFAULT_SHELL_CONFIG },
    ...overrides
  } as AppConfig
}

const newSession: Session = {
  id: 'new-session-id',
  name: '',
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 64000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  skillsState: { manualActivated: [], manualDisabled: [] },
  metadata: {},
  workDirProfileId: 'p1'
}

function renderChatView(options?: { currentSessionId?: string | null; sessions?: Session[] }) {
  store.dispatch(setConfig(makeConfig()))
  store.dispatch(setSession(options?.currentSessionId ?? null))
  store.dispatch(setMessages([]))
  store.dispatch(setSessions(options?.sessions ?? []))

  const view = render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <ChatView />
        </App>
      </ConfigProvider>
    </Provider>
  )

  return { store, ...view }
}

function getTextarea() {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('ChatView auto-create session', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await changeAppLocale('zh-CN')

    window.api = {
      ...window.api,
      sessionCreate: vi.fn().mockResolvedValue(newSession),
      chatGetMessages: vi.fn().mockResolvedValue([]),
      chatAppendMessage: vi.fn().mockResolvedValue(undefined),
      chatPatchMessage: vi.fn().mockResolvedValue(undefined),
      sessionGet: vi.fn().mockResolvedValue(null),
      sessionBackfillAutoTitleIfNeeded: vi.fn().mockResolvedValue(null),
      feishuOnInboundMessage: vi.fn().mockReturnValue(() => {}),
      skillRoute: vi.fn().mockResolvedValue({
        skills: [],
        meta: {
          sources: {},
          llmRecommended: false,
          routingFailed: false,
          routingError: undefined,
          routingRequestId: undefined
        }
      }),
      wikiGetSchema: vi.fn().mockResolvedValue(null),
      usageGet: vi.fn().mockResolvedValue(undefined),
      usageSet: vi.fn().mockResolvedValue(undefined),
      usageDelete: vi.fn().mockResolvedValue(undefined)
    } as typeof window.api
  })

  it('keeps textarea enabled when no session is selected (AC1)', () => {
    renderChatView()
    expect(getTextarea().disabled).toBe(false)
  })

  it('enables send button when text is entered without a session (AC2)', () => {
    renderChatView()
    fireEvent.change(getTextarea(), { target: { value: 'hello' } })
    expect(screen.getByRole('button', { name: '发送消息' }).disabled).toBe(false)
  })

  it('creates session and sends message when sending without a session (AC3)', async () => {
    const { store } = renderChatView()
    fireEvent.change(getTextarea(), { target: { value: 'hello world' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => {
      expect(window.api.sessionCreate).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        name: '',
        metadata: {}
      })
    })
    await waitFor(() => {
      expect(store.getState().chat.currentSessionId).toBe('new-session-id')
    })
    await waitFor(() => {
      expect(window.api.chatAppendMessage).toHaveBeenCalled()
    })
    expect(runClaudeChatStream).toHaveBeenCalled()
    const payload = vi.mocked(runClaudeChatStream).mock.calls[0]?.[0]
    expect(payload?.messages?.length).toBeGreaterThan(0)
    expect(payload?.messages?.some((m) => m.content === 'hello world')).toBe(true)
    expect(payload?.sessionId).toBe('new-session-id')
  })

  it('keeps user message in API payload when session message load races with send', async () => {
    vi.mocked(window.api.chatGetMessages).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 50))
    )
    renderChatView()
    fireEvent.change(getTextarea(), { target: { value: 'race test' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => {
      expect(runClaudeChatStream).toHaveBeenCalled()
    })
    const racePayload = vi.mocked(runClaudeChatStream).mock.calls[0]?.[0]
    expect(racePayload?.messages?.some((m) => m.content === 'race test')).toBe(true)
  })

  it('does not send when sessionCreate fails', async () => {
    vi.mocked(window.api.sessionCreate).mockRejectedValueOnce(new Error('create failed'))
    const { store } = renderChatView()
    fireEvent.change(getTextarea(), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => {
      expect(window.api.sessionCreate).toHaveBeenCalled()
    })
    expect(window.api.chatAppendMessage).not.toHaveBeenCalled()
    expect(store.getState().chat.currentSessionId).toBeNull()
  })

  it('does not call sessionCreate when a session is already selected (AC6)', async () => {
    const existing: Session = { ...newSession, id: 'existing-session', name: 'Existing' }
    renderChatView({
      currentSessionId: 'existing-session',
      sessions: [existing]
    })

    fireEvent.change(getTextarea(), { target: { value: 'follow up' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => {
      expect(window.api.chatAppendMessage).toHaveBeenCalled()
    })
    expect(window.api.sessionCreate).not.toHaveBeenCalled()
  })

  it('auto-creates session when pressing Enter without a session (AC5)', async () => {
    const { store } = renderChatView()
    const textarea = getTextarea()
    fireEvent.change(textarea, { target: { value: 'via enter' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(window.api.sessionCreate).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(store.getState().chat.currentSessionId).toBe('new-session-id')
    })
    await waitFor(() => {
      expect(window.api.chatAppendMessage).toHaveBeenCalled()
    })
  })
})
