import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
import { store } from '../../store'
import { setChatStatus, setMessages, setSession } from '../../store/chatSlice'
import { setConfig } from '../../store/configSlice'
import { setSessions } from '../../store/sessionSlice'

// 仅 spy abortSessionRun，其余保持真实实现（ChatView 依赖 routeAddMessage 等真实路径）
vi.mock('../../services/chatRunnerService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/chatRunnerService')>()),
  abortSessionRun: vi.fn()
}))

import { abortSessionRun } from '../../services/chatRunnerService'

vi.mock('../../utils/motionPreference', () => ({
  scrollIntoViewWithMotionPreference: vi.fn()
}))

vi.mock('../DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => ({ openFile: vi.fn().mockResolvedValue(undefined) })
}))

vi.mock('../../services/chatSearchAdapter', () => ({
  useChatSearchAdapter: vi.fn()
}))

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
    buffer = { active: { length: 1, baseY: 0, viewportY: 0, getLine: () => ({ translateToString: () => 'line' }) } }
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

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    locale: 'zh-CN',
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: [],
    activeLlmServiceId: '',
    model: 'claude-sonnet-4-6',
    defaultModel: 'claude-sonnet-4-6',
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
    workDir: '/tmp',
    workDirProfiles: [{ id: 'p1', name: 'Default', path: '/tmp', isDefault: true }],
    activeWorkDirProfileId: 'p1',
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

const abortSession: Session = {
  id: 's-abort',
  name: '进行中的会话',
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 64000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  skillsState: { manualActivated: [], manualDisabled: [] },
  metadata: {},
  workDirProfileId: 'p1'
}

function renderChatView() {
  return render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <ChatView />
        </App>
      </ConfigProvider>
    </Provider>
  )
}

describe('ChatView 中止按钮本地止血（chat-abort-latency 方案 Phase 2）', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    store.dispatch(setConfig(makeConfig()))
    store.dispatch(setSession('s-abort'))
    store.dispatch(setMessages([]))
    store.dispatch(setSessions([abortSession]))

    Object.assign(window.api, {
      chatCancelTurn: vi.fn().mockResolvedValue(undefined),
      chatGetMessages: vi.fn().mockResolvedValue([]),
      chatGetMessagePage: vi.fn().mockResolvedValue({ entries: [], oldestSequence: null, hasMoreBefore: false }),
      chatGetApiContextBaseline: vi.fn().mockResolvedValue({ sessionId: 's-abort', entries: [] }),
      chatGetContextHistorySummaryBaseline: vi.fn().mockResolvedValue({ sessionId: 's-abort', entries: [] }),
      chatResolveRetryContext: vi.fn().mockResolvedValue(null),
      chatGetMessageSequence: vi.fn().mockResolvedValue(null),
      messageAppendNonTurn: vi.fn().mockImplementation(async (msg: { id: string }) => ({ messageId: msg.id, sequence: Date.now() })),
      messagePatchNonTurn: vi.fn().mockResolvedValue(null),
      sessionGet: vi.fn().mockResolvedValue(null),
      sessionBackfillAutoTitleIfNeeded: vi.fn().mockResolvedValue(null),
      feishuOnInboundMessage: vi.fn().mockReturnValue(() => {}),
      skillRoute: vi.fn().mockResolvedValue({
        skills: [],
        meta: { sources: {}, llmRecommended: false, routingFailed: false, routingError: undefined, routingRequestId: undefined }
      }),
      wikiGetSchema: vi.fn().mockResolvedValue(null),
      configGet: vi.fn().mockResolvedValue(makeConfig())
    })
  })

  it('中止按钮点击走 abortSessionRun（本地立即清理），不再只发 chat:cancel-turn', () => {
    store.dispatch(setChatStatus({ status: 'streaming', requestId: 'req-abort', sessionId: 's-abort', turnId: 'turn-abort' }))
    renderChatView()

    fireEvent.click(screen.getByRole('button', { name: '中止生成' }))

    expect(vi.mocked(abortSessionRun)).toHaveBeenCalledWith('s-abort')
    expect(window.api.chatCancelTurn).not.toHaveBeenCalled()
  })
})
