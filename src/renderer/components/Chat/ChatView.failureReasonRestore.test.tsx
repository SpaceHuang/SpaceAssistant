import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { App, ConfigProvider } from 'antd'
import React from 'react'
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
import { store } from '../../store'
import { resetChatUi, setSession } from '../../store/chatSlice'
import { setConfig } from '../../store/configSlice'
import { setSessions } from '../../store/sessionSlice'

vi.mock('react-virtuoso', () => {
  const ReactLocal = require('react') as typeof React
  return {
    Virtuoso: ReactLocal.forwardRef(function VirtuosoMock(
      {
        data,
        itemContent
      }: {
        data: Message[]
        itemContent: (index: number, message: Message) => React.ReactNode
      },
      ref: React.Ref<{ scrollToIndex: () => void }>
    ) {
      ReactLocal.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }))
      return (
        <div className="chat-scroll" data-testid="virtuoso-mock">
          {data.map((message, index) => (
            <div key={message.id}>{itemContent(index, message)}</div>
          ))}
        </div>
      )
    })
  }
})

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

vi.mock('../DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => ({ openFile: vi.fn().mockResolvedValue(undefined) })
}))

vi.mock('../../services/chatSearchAdapter', () => ({
  useChatSearchAdapter: vi.fn()
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

const userMessage: Message = {
  id: 'u1',
  sessionId: testSession.id,
  role: 'user',
  content: 'hello',
  timestamp: 1,
  status: 'sent',
  schemaVersion: CURRENT_SCHEMA_VERSION
}

const failedAssistant: Message = {
  id: 'a-failed',
  sessionId: testSession.id,
  role: 'assistant',
  content: 'partial',
  timestamp: 2,
  status: 'failed',
  schemaVersion: CURRENT_SCHEMA_VERSION
}

function renderChatView(): ReturnType<typeof render> {
  store.dispatch(setConfig(makeConfig()))
  store.dispatch(setSession(testSession.id))
  store.dispatch(setSessions([testSession]))

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

describe('ChatView 失败原因回溯', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await changeAppLocale('zh-CN')
    store.dispatch(resetChatUi())

    Object.assign(window.api, {
      chatGetMessagePage: vi.fn().mockResolvedValue({
        entries: [
          { message: userMessage, sequence: 1 },
          { message: failedAssistant, sequence: 2 }
        ],
        oldestSequence: 1,
        hasMoreBefore: false
      }),
      chatGetTurnErrors: vi
        .fn()
        .mockResolvedValue([
          { assistantMessageId: 'a-failed', message: '会话模型「claude-sonnet-4-20250514」当前不可用（未知模型），请在设置中重新选择模型' }
        ]),
      chatGetApiContextBaseline: vi.fn().mockResolvedValue({ sessionId: testSession.id, entries: [] }),
      chatGetContextHistorySummaryBaseline: vi.fn().mockResolvedValue({ sessionId: testSession.id, entries: [] }),
      chatGetSearchCorpusPage: vi.fn().mockResolvedValue({ entries: [], nextSequence: 0, hasMore: false }),
      chatGetMessageSequence: vi.fn().mockResolvedValue(null),
      chatGetNextQueuedMessage: vi.fn().mockResolvedValue(null),
      chatResolveRetryContext: vi.fn().mockResolvedValue(null),
      messageAppendNonTurn: vi.fn().mockResolvedValue(null),
      messagePatchNonTurn: vi.fn().mockResolvedValue(null),
      sessionGet: vi.fn().mockResolvedValue(null),
      sessionBackfillAutoTitleIfNeeded: vi.fn().mockResolvedValue(null),
      feishuOnInboundMessage: vi.fn().mockReturnValue(() => {}),
      skillRoute: vi.fn().mockResolvedValue({
        skills: [],
        meta: { sources: {}, llmRecommended: false, routingFailed: false, routingError: undefined, routingRequestId: undefined }
      }),
      wikiGetSchema: vi.fn().mockResolvedValue(null),
      usageGet: vi.fn().mockResolvedValue(undefined),
      usageSet: vi.fn().mockResolvedValue(undefined),
      usageDelete: vi.fn().mockResolvedValue(undefined),
      workdirSwitch: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
      configGet: vi.fn().mockResolvedValue(makeConfig())
    })
  })

  it('加载消息后按 assistantMessageId 回查并展示真实失败原因', async () => {
    renderChatView()

    await waitFor(() => {
      expect(window.api.chatGetTurnErrors).toHaveBeenCalledWith({ assistantMessageIds: ['a-failed'] })
    })
    await waitFor(() => {
      expect(screen.getByText('失败原因')).toBeDefined()
    })
    expect(
      screen.getByText('会话模型「claude-sonnet-4-20250514」当前不可用（未知模型），请在设置中重新选择模型')
    ).toBeDefined()
  })

  it('主进程没有失败记录时保持通用失败提示', async () => {
    vi.mocked(window.api.chatGetTurnErrors).mockResolvedValue([])
    renderChatView()

    await waitFor(() => {
      expect(window.api.chatGetTurnErrors).toHaveBeenCalled()
    })
    expect(screen.queryByText('失败原因')).toBeNull()
  })
})
