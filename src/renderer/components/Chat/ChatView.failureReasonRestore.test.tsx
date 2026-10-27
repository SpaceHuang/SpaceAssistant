import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { resetChatUi, setScrollToMessageId, setSession } from '../../store/chatSlice'
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

const secondSession: Session = { ...testSession, id: 'session-b', name: 'Second session' }

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
  it('切换会话 trace 从 setSession 调用开始计时并在页面请求中保留关联', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    renderChatView()

    await waitFor(() => {
      const line = info.mock.calls.map(([value]) => String(value)).find((value) => value.startsWith('[session.switch.trace.renderer] '))
      expect(line).toBeDefined()
      const trace = JSON.parse(line!.replace('[session.switch.trace.renderer] ', '')) as {
        stages: Array<{ name: string; durationMs: number; outcome: string }>
        sessionId?: string
      }
      expect(trace.stages).toContainEqual({ name: 'selection-to-page-request', durationMs: expect.any(Number), outcome: 'ok' })
      expect(trace).not.toHaveProperty('sessionId')
    })
    info.mockRestore()
  })

  it('失败原因查询挂起时先提交并显示消息正文', async () => {
    let resolveReasons!: (value: Array<{ assistantMessageId: string; message: string }>) => void
    vi.mocked(window.api.chatGetTurnErrors).mockImplementation(() => new Promise((resolve) => { resolveReasons = resolve }))
    renderChatView()

    expect(await screen.findByText('partial')).toBeDefined()
    expect(window.api.chatGetTurnErrors).toHaveBeenCalledWith({ assistantMessageIds: ['a-failed'] })
    resolveReasons([{ assistantMessageId: 'a-failed', message: '延迟补齐的具体原因' }])
    expect(await screen.findByText('延迟补齐的具体原因')).toBeDefined()
  })

  it('向前翻页时先 prepend 消息，再等待失败原因补齐', async () => {
    let resolveReasons!: (value: Array<{ assistantMessageId: string; message: string }>) => void
    vi.mocked(window.api.chatGetMessagePage).mockImplementation(async ({ beforeSequence }) => beforeSequence === undefined
      ? { entries: [{ message: userMessage, sequence: 2 }], oldestSequence: 2, hasMoreBefore: true }
      : { entries: [{ message: failedAssistant, sequence: 1 }], oldestSequence: 1, hasMoreBefore: false })
    vi.mocked(window.api.chatGetMessageSequence).mockResolvedValue(1)
    vi.mocked(window.api.chatGetTurnErrors).mockImplementation(() => new Promise((resolve) => { resolveReasons = resolve }))
    renderChatView()

    expect(await screen.findByText('hello')).toBeDefined()
    act(() => store.dispatch(setScrollToMessageId(failedAssistant.id)))
    expect(await screen.findByText('partial')).toBeDefined()
    expect(window.api.chatGetTurnErrors).toHaveBeenCalledWith({ assistantMessageIds: ['a-failed'] })
    resolveReasons([{ assistantMessageId: 'a-failed', message: '翻页补齐的具体原因' }])
    expect(await screen.findByText('翻页补齐的具体原因')).toBeDefined()
  })

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
      chatSubmitOutbound: vi.fn().mockResolvedValue({
        accepted: 'turn-started', sessionId: testSession.id, turnId: 'retry-turn',
        assistantMessage: { ...failedAssistant, id: 'retry-assistant', status: 'streaming', content: '' }, warnings: []
      }),
      chatContinueFromCheckpoint: vi.fn().mockResolvedValue({ accepted: true, status: 'running' }),
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

  it('A→B→A 时旧 A 的晚到原因不能覆盖第二次 A 的结果', async () => {
    let resolveFirstA!: (value: Array<{ assistantMessageId: string; message: string }>) => void
    let failureLookups = 0
    const firstAReason = new Promise<Array<{ assistantMessageId: string; message: string }>>((resolve) => { resolveFirstA = resolve })
    vi.mocked(window.api.chatGetMessagePage).mockImplementation(async ({ sessionId }) => sessionId === secondSession.id
      ? { entries: [{ message: { ...failedAssistant, id: 'b-complete', sessionId: secondSession.id, role: 'assistant',
        status: 'completed', content: 'B 正文' }, sequence: 1 }], oldestSequence: 1, hasMoreBefore: false }
      : { entries: [{ message: { ...failedAssistant, content: '第二次 A 正文' }, sequence: 2 }], oldestSequence: 2, hasMoreBefore: false })
    vi.mocked(window.api.chatGetTurnErrors).mockImplementation(async () => {
      failureLookups += 1
      if (failureLookups === 1) return firstAReason
      return [{ assistantMessageId: 'a-failed', message: '第二次 A 的新原因' }]
    })
    renderChatView()
    await waitFor(() => expect(window.api.chatGetTurnErrors).toHaveBeenCalledTimes(1))

    act(() => {
      store.dispatch(setSessions([testSession, secondSession]))
      store.dispatch(setSession(secondSession.id))
    })
    expect(await screen.findByText('B 正文')).toBeDefined()
    act(() => store.dispatch(setSession(testSession.id)))
    expect(await screen.findByText('第二次 A 的新原因')).toBeDefined()

    act(() => resolveFirstA([{ assistantMessageId: 'a-failed', message: '第一次 A 的旧原因' }]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().chat.turnFailures['a-failed']).toBe('第二次 A 的新原因')
    expect(screen.queryByText('第一次 A 的旧原因')).toBeNull()
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

  it('失败原因查询拒绝时仍显示正文并保留通用失败提示', async () => {
    vi.mocked(window.api.chatGetTurnErrors).mockRejectedValue(new Error('IPC unavailable'))
    renderChatView()

    expect(await screen.findByText('partial')).toBeDefined()
    await waitFor(() => expect(window.api.chatGetTurnErrors).toHaveBeenCalledWith({ assistantMessageIds: ['a-failed'] }))
    expect(await screen.findByText('回复未能完成。你可以重试生成，或基于已有上下文继续对话。')).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('会话模型「claude-sonnet-4-20250514」当前不可用（未知模型），请在设置中重新选择模型')).toBeNull()
  })

  it('主进程没有失败记录时保持通用失败提示', async () => {
    vi.mocked(window.api.chatGetTurnErrors).mockResolvedValue([])
    renderChatView()

    await waitFor(() => {
      expect(window.api.chatGetTurnErrors).toHaveBeenCalled()
    })
    expect(screen.queryByText('失败原因')).toBeNull()
  })

  it('失败消息继续按钮将查询返回的 sourceTurnId 传给 checkpoint continuation IPC', async () => {
    vi.mocked(window.api.chatResolveRetryContext).mockResolvedValue({
      failedAssistant: { message: failedAssistant, sequence: 2 },
      currentUser: { message: userMessage, sequence: 1 },
      excludeMessageIds: ['a-failed'],
      sourceInvocationId: 'request-1',
      sourceTurnId: 'turn-1'
    })
    renderChatView()

    fireEvent.click(await screen.findByRole('button', { name: '继续上次执行' }))

    await waitFor(() => expect(window.api.chatResolveRetryContext).toHaveBeenCalledWith({
      sessionId: testSession.id, failedAssistantMessageId: 'a-failed'
    }))
    await waitFor(() => expect(window.api.chatContinueFromCheckpoint).toHaveBeenCalledWith({
      sessionId: testSession.id, sourceTurnId: 'turn-1', requestIdempotencyKey: expect.any(String)
    }))
  })

  it('失败消息重试按钮复用因果 user、boundary 与 exclude IDs', async () => {
    vi.mocked(window.api.chatResolveRetryContext).mockResolvedValue({
      failedAssistant: { message: failedAssistant, sequence: 2 },
      currentUser: { message: userMessage, sequence: 1 },
      excludeMessageIds: ['a-failed'],
      sourceInvocationId: 'request-1',
      sourceTurnId: 'turn-1'
    })
    renderChatView()

    fireEvent.click(await screen.findByRole('button', { name: '从头重试' }))

    await waitFor(() => expect(window.api.chatResolveRetryContext).toHaveBeenCalledWith({
      sessionId: testSession.id, failedAssistantMessageId: failedAssistant.id
    }))
    await waitFor(() => expect(window.api.chatSubmitOutbound).toHaveBeenCalledWith({
      sessionId: testSession.id,
      text: userMessage.content,
      contextIntent: {
        kind: 'reuse-user',
        currentUser: { message: userMessage, order: { kind: 'persisted', sequence: 1 } },
        excludeMessageIds: ['a-failed']
      }
    }))
  })
})
