import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

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
})
