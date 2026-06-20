import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import { ChatView } from './ChatView'
import type { AppConfig, Message, Session } from '../../../shared/domainTypes'
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_FEISHU_CONFIG,
  DEFAULT_SHELL_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_WIKI_CONFIG
} from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'
import { isChatScrollNearBottom, scrollChatToBottom } from '../../utils/chatScroll'
import { scrollBehaviorPreference } from '../../utils/motionPreference'
import { store } from '../../store'
import { setChatStatus, setMessages, setSession } from '../../store/chatSlice'
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

vi.mock('../../utils/chatScroll', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/chatScroll')>()
  return {
    ...actual,
    scrollChatToBottom: vi.fn()
  }
})

vi.mock('../../utils/motionPreference', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/motionPreference')>()
  return {
    ...actual,
    scrollIntoViewWithMotionPreference: vi.fn()
  }
})

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

const scrollChatToBottomMock = vi.mocked(scrollChatToBottom)

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

const testSession: Session = {
  id: 'session-a',
  name: 'Test',
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 64000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  skillsState: { manualActivated: [], manualDisabled: [] },
  metadata: {},
  workDirProfileId: 'p1'
}

function makeMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    sessionId: testSession.id,
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? Date.now(),
    status: overrides.status ?? 'completed',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...overrides
  }
}

function setupScrollContainer(
  el: HTMLElement,
  dims: { scrollHeight: number; clientHeight: number; scrollTop: number }
) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => dims.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => dims.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => dims.scrollTop,
    set: (value: number) => {
      dims.scrollTop = value
    }
  })
  el.scrollTo = vi.fn() as typeof el.scrollTo
}

function getScrollEl(container: HTMLElement) {
  const el = container.querySelector('.chat-scroll')
  if (!el) throw new Error('chat-scroll element not found')
  return el as HTMLElement
}

function getScrollToLatestButton(container: HTMLElement) {
  const button = container.querySelector('.chat-scroll-to-latest')
  if (!button) throw new Error('scroll-to-latest button not found')
  return button as HTMLButtonElement
}

function queryScrollToLatestButton(container: HTMLElement) {
  return container.querySelector('.chat-scroll-to-latest')
}

function expectButtonHidden(button: HTMLElement) {
  expect(button.getAttribute('aria-hidden')).toBe('true')
  expect(button.className).toContain('chat-scroll-to-latest--hidden')
}

function expectButtonVisible(button: HTMLElement) {
  expect(button.getAttribute('aria-hidden')).toBe('false')
  expect(button.className).not.toContain('chat-scroll-to-latest--hidden')
}

async function renderChatWithMessages(messages: Message[], session: Session = testSession) {
  store.dispatch(setConfig(makeConfig()))
  store.dispatch(setSession(session.id))
  store.dispatch(setMessages(messages))
  store.dispatch(setSessions([session]))

  const view = render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <ChatView />
        </App>
      </ConfigProvider>
    </Provider>
  )

  await waitFor(() => {
    expect(window.api.chatGetMessages).toHaveBeenCalled()
  })
  await waitFor(() => {
    expect(view.container.querySelector('.chat-scroll-to-latest')).not.toBeNull()
  })

  return view
}

function syncScrollState(container: HTMLElement, dims: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const el = getScrollEl(container)
  setupScrollContainer(el, dims)
  fireEvent.scroll(el)
  return el
}

describe('ChatView scroll to latest', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    scrollChatToBottomMock.mockClear()
    await changeAppLocale('zh-CN')

    window.matchMedia = vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })) as typeof window.matchMedia

    window.api = {
      ...window.api,
      sessionCreate: vi.fn(),
      chatGetMessages: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) =>
        store.getState().chat.messages.filter((m) => m.sessionId === sessionId)
      ),
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

  it('hides the button when scrolled near the bottom', async () => {
    const messages = [
      makeMessage({ id: 'u1', role: 'user' }),
      makeMessage({ id: 'a1', role: 'assistant' })
    ]
    const { container } = await renderChatWithMessages(messages)
    syncScrollState(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 880 })

    expectButtonHidden(getScrollToLatestButton(container))
  })

  it('shows the button after scrolling up more than 120px', async () => {
    const messages = [
      makeMessage({ id: 'u1', role: 'user' }),
      makeMessage({ id: 'a1', role: 'assistant' })
    ]
    const { container } = await renderChatWithMessages(messages)
    syncScrollState(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 100 })

    const button = getScrollToLatestButton(container)
    expectButtonVisible(button)
    expect(button.getAttribute('aria-label')).toBe('跳到最新消息')
    expect(isChatScrollNearBottom(getScrollEl(container))).toBe(false)
  })

  it('scrolls to bottom when the button is clicked', async () => {
    const messages = [
      makeMessage({ id: 'u1', role: 'user' }),
      makeMessage({ id: 'a1', role: 'assistant' })
    ]
    const { container } = await renderChatWithMessages(messages)
    const el = syncScrollState(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 100 })

    fireEvent.click(getScrollToLatestButton(container))

    expect(scrollChatToBottomMock).toHaveBeenCalledWith(el, { force: true, behavior: 'smooth' })
  })

  it('degrades scroll behavior when prefers-reduced-motion is enabled', async () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })) as typeof window.matchMedia

    expect(scrollBehaviorPreference('smooth')).toBe('auto')
  })

  it('hides the button when content does not overflow', async () => {
    const messages = [makeMessage({ id: 'u1', role: 'user' })]
    const { container } = await renderChatWithMessages(messages)
    syncScrollState(container, { scrollHeight: 500, clientHeight: 500, scrollTop: 0 })

    expectButtonHidden(getScrollToLatestButton(container))
  })

  it('scrolls to bottom when Enter is pressed on the focused button', async () => {
    const messages = [
      makeMessage({ id: 'u1', role: 'user' }),
      makeMessage({ id: 'a1', role: 'assistant' })
    ]
    const { container } = await renderChatWithMessages(messages)
    const el = syncScrollState(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 100 })

    const button = getScrollToLatestButton(container)
    button.focus()
    fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' })

    expect(scrollChatToBottomMock).toHaveBeenCalledWith(el, { force: true, behavior: 'smooth' })
  })

  it('shows the button while streaming when scrolled up and hides when near bottom', async () => {
    const messages = [
      makeMessage({ id: 'u1', role: 'user' }),
      makeMessage({ id: 'a1', role: 'assistant', status: 'streaming' })
    ]
    const { container } = await renderChatWithMessages(messages)
    store.dispatch(
      setChatStatus({
        status: 'streaming',
        sessionId: testSession.id,
        requestId: 'req-stream-1'
      })
    )

    syncScrollState(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 100 })
    expectButtonVisible(getScrollToLatestButton(container))

    syncScrollState(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 880 })
    expectButtonHidden(getScrollToLatestButton(container))
  })

  it('resets button visibility when switching sessions', async () => {
    const sessionB: Session = { ...testSession, id: 'session-b', name: 'Other' }
    const messages = [
      makeMessage({ id: 'u1', role: 'user' }),
      makeMessage({ id: 'a1', role: 'assistant' })
    ]
    const { container } = await renderChatWithMessages(messages)
    syncScrollState(container, { scrollHeight: 1000, clientHeight: 100, scrollTop: 100 })
    expectButtonVisible(getScrollToLatestButton(container))

    store.dispatch(setSession('session-b'))
    store.dispatch(setMessages([]))
    store.dispatch(setSessions([testSession, sessionB]))
    vi.mocked(window.api.chatGetMessages).mockResolvedValueOnce([])

    await waitFor(() => {
      expect(store.getState().chat.currentSessionId).toBe('session-b')
    })

    expect(queryScrollToLatestButton(container)).toBeNull()
  })
})
