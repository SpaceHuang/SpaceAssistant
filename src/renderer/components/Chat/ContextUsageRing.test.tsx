import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import chatReducer, { setLastUsage, setSession } from '../../store/chatSlice'
import configReducer, { setConfig } from '../../store/configSlice'
import { ContextUsageRing } from './ContextUsageRing'
import type { AppConfig } from '../../../shared/domainTypes'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_SKILLS_CONFIG } from '../../../shared/domainTypes'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKeyPresent: true,
    baseUrl: '',
    model: 'claude-sonnet-4-6',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: '1', name: 'claude-sonnet-4-6', maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: false, enabled: true }
    ],
    temperature: 0,
    maxTokens: 4096,
    thinkingEnabled: false,
    workDir: '',
    uiTheme: 'system',
    defaultChatMode: 'normal',
    maxParallelChatSessions: 3,
    tools: { ...DEFAULT_TOOLS_CONFIG, enabled: false },
    skills: { ...DEFAULT_SKILLS_CONFIG },
    ...overrides
  } as AppConfig
}

function renderRing(lastUsage?: Parameters<typeof setLastUsage>[0], configOverrides?: Partial<AppConfig>) {
  const store = configureStore({
    reducer: { chat: chatReducer, config: configReducer }
  })
  store.dispatch(setConfig(makeConfig(configOverrides)))
  if (lastUsage !== undefined) {
    store.dispatch(setLastUsage(lastUsage))
  }
  return {
    store,
    ...render(
      <Provider store={store}>
        <ContextUsageRing />
      </Provider>
    )
  }
}

describe('ContextUsageRing', () => {
  it('renders single gray ring when no usage data', () => {
    renderRing()
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })

  it('renders three layers when usage data is available', () => {
    renderRing({ input_tokens: 10000, output_tokens: 5000 })
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(3)
    const colors = Array.from(circles).map((c) => c.getAttribute('stroke'))
    expect(colors).toContain('var(--sa-primary)')
    expect(colors).toContain('#666')
    expect(colors).toContain('#ddd')
  })

  it('clamps layers when input + maxTokens exceeds maximumContext', () => {
    renderRing(
      { input_tokens: 199000, output_tokens: 1000 },
      { maxTokens: 64000 }
    )
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(3)
    circles.forEach((c) => {
      const dash = c.getAttribute('stroke-dasharray')
      expect(dash).toBeTruthy()
    })
  })

  it('shows no-data tooltip on hover', async () => {
    renderRing()
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    await waitFor(() => {
      expect(screen.getByText('暂无上下文用量数据')).toBeDefined()
    })
  })

  it('shows tooltip with token details on hover', async () => {
    renderRing({ input_tokens: 12345, output_tokens: 4567, cache_read_input_tokens: 2000 })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    await waitFor(() => {
      expect(screen.getByText(/输入消耗/)).toBeDefined()
      expect(screen.getByText(/12,345/)).toBeDefined()
      expect(screen.getByText(/4,567/)).toBeDefined()
      expect(screen.getByText(/2,000/)).toBeDefined()
    })
    expect(screen.queryByText(/缓存写入/)).toBeNull()
  })

  it('shows cache creation only when > 0', async () => {
    renderRing({ input_tokens: 100, cache_creation_input_tokens: 500 })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    await waitFor(() => {
      expect(screen.getByText(/缓存写入/)).toBeDefined()
      expect(screen.getByText(/500/)).toBeDefined()
    })
  })

  it('does not crash when model list is empty', () => {
    renderRing({ input_tokens: 100 }, { models: [] })
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })

  it('resets to empty ring when lastUsage becomes null after session switch', () => {
    const { store, rerender } = renderRing({ input_tokens: 5000 })
    expect(document.querySelectorAll('circle')).toHaveLength(3)

    store.dispatch(setSession('new-session'))
    rerender(
      <Provider store={store}>
        <ContextUsageRing />
      </Provider>
    )
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })
})