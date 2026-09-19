import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('./ContextUsageRing', () => ({
  ContextUsageRing: () => null
}))
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import chatReducer from '../../store/chatSlice'
import configReducer, { setConfig } from '../../store/configSlice'
import { MessageInput } from './MessageInput'
import type { AppConfig } from '../../../shared/domainTypes'
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_FEISHU_CONFIG,
  DEFAULT_SHELL_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_WIKI_CONFIG
} from '../../../shared/domainTypes'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    locale: 'zh-CN',
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: [],
    activeLlmServiceId: '',
    activeLlmServiceIds: [],
    preferredLanguageModelId: '1',
    preferredFastLanguageModelId: '',
    preferredVisionModelId: '',
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
        isVision: false,
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

function renderInput(props: Partial<React.ComponentProps<typeof MessageInput>> = {}) {
  const store = configureStore({
    reducer: { chat: chatReducer, config: configReducer }
  })
  store.dispatch(setConfig(makeConfig()))
  const onSend = vi.fn()
  return {
    onSend,
    ...render(
      <Provider store={store}>
        <MessageInput sessionId="sess-1" onSend={onSend} {...props} />
      </Provider>
    )
  }
}

describe('MessageInput', () => {
  it(
    'renders textarea and attach button',
    () => {
      const { container } = renderInput()
      expect(container.querySelector('textarea')).not.toBeNull()
      expect(container.querySelector('.composer-add-attachment')).not.toBeNull()
    },
    30_000
  )

  it('disables send when text is empty', () => {
    renderInput()
    const sendBtn = screen.getByRole('button', { name: '发送消息' })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
  })

  // §5.2.1（OQ-9）：idle 态状态区整块不渲染（原「Enter 发送」提示已移除），不占位
  it('renders no composer status area while idle', () => {
    const { container } = renderInput()
    expect(container.querySelector('.composer-status')).toBeNull()
    expect(container.querySelector('.composer-hint-trigger')).toBeNull()
    expect(container.textContent).not.toContain('Enter 发送')
  })

  // §10.2 回归重点：running 态仍显示运行状态标签与耗时（§5.2.1 保留清单）
  it('still renders running status label and elapsed while running', () => {
    const { container } = renderInput({ running: true, runningStatus: '生成中', runningElapsed: '3s' })
    expect(container.querySelector('.composer-status__label')?.textContent).toBe('生成中')
    expect(container.querySelector('.composer-status__elapsed')?.textContent).toBe('3s')
  })

  // §10.2：排队提示（hintRunningQueue）保留——running + 已输入文本（canQueueSend）时显示
  it('still shows the queue hint when a send is queued while running', () => {
    const { container } = renderInput({ running: true, runningStatus: '生成中' })
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'hi' } })
    expect(container.querySelector('.composer-status__hint')?.textContent).toContain('发送并排队')
  })

  // §5.2：强度控件落位在模型 chip 之后、状态区之前
  it('places thinking slot after model slot and before status area', () => {
    const { container } = renderInput({
      modelSlot: <span data-testid="model-slot">model</span>,
      thinkingSlot: <button type="button">默认（中）</button>,
      running: true,
      runningStatus: '生成中'
    })
    const modelSlot = container.querySelector('[data-testid="model-slot"]')!
    const thinking = screen.getByRole('button', { name: '默认（中）' })
    const status = container.querySelector('.composer-status--running')!
    expect(modelSlot.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(thinking.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
