import { describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import chatReducer, { restoreLastUsage } from '../../store/chatSlice'
import { changeAppLocale } from '../../i18n/localeSync'
import type { SessionUsage } from '../../../shared/sessionUsage'
import configReducer, { setConfig } from '../../store/configSlice'
import { buildContextRingSegments, ContextUsageRing } from './ContextUsageRing'
import type { AppConfig, Message } from '../../../shared/domainTypes'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_SKILLS_CONFIG, DEFAULT_WIKI_CONFIG, DEFAULT_FEISHU_CONFIG, DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'
import { DEFAULT_BROWSER_CONFIG } from '../../../shared/domainTypes'

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
      { id: '1', name: 'claude-sonnet-4-6', maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: false, isVision: false, enabled: true }
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

function renderRing(
  lastUsage?: SessionUsage | null,
  configOverrides?: Partial<AppConfig>,
  ringProps?: ComponentProps<typeof ContextUsageRing>
) {
  const store = configureStore({
    reducer: { chat: chatReducer, config: configReducer }
  })
  store.dispatch(setConfig(makeConfig(configOverrides)))
  if (lastUsage !== undefined) {
    store.dispatch(restoreLastUsage(lastUsage))
  }
  return {
    store,
    ...render(
      <Provider store={store}>
        <ContextUsageRing {...ringProps} />
      </Provider>
    )
  }
}

describe('buildContextRingSegments', () => {
  const C = 100

  it('places used then reserved contiguously on one ring', () => {
    const segs = buildContextRingSegments(0.1, 0.32, C)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ color: 'var(--sa-primary)', dashLen: 10, dashOffset: 0 })
    expect(segs[1]).toEqual({ color: 'var(--sa-context-ring-reserved)', dashLen: 32, dashOffset: -10 })
  })

  it('omits zero-length segments', () => {
    expect(buildContextRingSegments(0, 0.5, C)).toEqual([
      { color: 'var(--sa-context-ring-reserved)', dashLen: 50, dashOffset: -0 }
    ])
    expect(buildContextRingSegments(0.2, 0, C)).toEqual([
      { color: 'var(--sa-primary)', dashLen: 20, dashOffset: 0 }
    ])
  })
})

describe('ContextUsageRing', () => {
  it('renders single gray track when no usage data', () => {
    renderRing()
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0]?.getAttribute('stroke')).toBe('var(--sa-context-ring-track)')
  })

  it('renders contiguous segments on one ring when usage data is available', () => {
    renderRing({ input_tokens: 10000, output_tokens: 5000 })
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(3)
    expect(circles[0]?.getAttribute('stroke')).toBe('var(--sa-context-ring-track)')
    const radii = Array.from(circles).map((c) => c.getAttribute('r'))
    expect(new Set(radii).size).toBe(1)
    const colors = Array.from(circles).map((c) => c.getAttribute('stroke'))
    expect(colors).toContain('var(--sa-primary)')
    expect(colors).toContain('var(--sa-context-ring-reserved)')
  })

  it('offsets reserved segment after used segment', () => {
    renderRing({ input_tokens: 10000, output_tokens: 5000 })
    const circles = Array.from(document.querySelectorAll('circle'))
    const used = circles.find((c) => c.getAttribute('stroke') === 'var(--sa-primary)')
    const reserved = circles.find((c) => c.getAttribute('stroke') === 'var(--sa-context-ring-reserved)')
    expect(used?.getAttribute('stroke-dashoffset')).toBe('0')
    expect(Number(reserved?.getAttribute('stroke-dashoffset'))).toBeLessThan(0)
  })

  it('clamps segments when estimated occupancy plus output max exceeds maximumContext', () => {
    renderRing({ input_tokens: 199000, output_tokens: 1000 })
    const circles = Array.from(document.querySelectorAll('circle'))
    expect(circles.length).toBeGreaterThan(1)
    const segments = circles.filter((c) => c.getAttribute('stroke') !== 'var(--sa-context-ring-track)')
    expect(segments.length).toBeGreaterThan(0)
    segments.forEach((c) => {
      expect(c.getAttribute('stroke-dasharray')).toBeTruthy()
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

  it('shows tooltip with estimated occupancy and breakdown on hover', async () => {
    renderRing({ input_tokens: 50, output_tokens: 4567, cache_read_input_tokens: 12_000 })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    await waitFor(() => {
      const text = screen.getByRole('tooltip').textContent ?? ''
      expect(text).toContain('预估占用')
      expect(text).toContain('16,617')
      expect(text).toContain('上轮输入')
      expect(text).toContain('12,050')
      expect(text).toContain('上轮输出')
      expect(text).toContain('4,567')
      expect(text).toContain('12,000')
      expect(text).toContain('输出预留')
      expect(text).toContain('64,000')
      expect(text).toContain('图例')
    })
    expect(screen.queryByText(/缓存写入/)).toBeNull()
  })

  it('uses model maxTokens for output reserve', async () => {
    renderRing({ input_tokens: 10000, output_tokens: 0 })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    await waitFor(() => {
      const text = screen.getByRole('tooltip').textContent ?? ''
      expect(text).toContain('输出预留')
      expect(text).toContain('64,000')
    })
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
    expect(circles[0]?.getAttribute('stroke')).toBe('var(--sa-context-ring-track)')
  })

  it('resets to empty ring when lastUsage is restored to null', () => {
    const { store, rerender } = renderRing({ input_tokens: 5000 })
    expect(document.querySelectorAll('circle').length).toBeGreaterThan(1)

    store.dispatch(restoreLastUsage(null))
    rerender(
      <Provider store={store}>
        <ContextUsageRing />
      </Provider>
    )
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0]?.getAttribute('stroke')).toBe('var(--sa-context-ring-track)')
  })

  it('shows English tooltip labels when locale is en-US', async () => {
    await changeAppLocale('en-US')
    renderRing({ input_tokens: 10000, output_tokens: 5000 })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    await waitFor(() => {
      const text = screen.getByRole('tooltip').textContent ?? ''
      expect(text).toContain('Estimated occupancy')
      expect(text).toContain('Last request input')
      expect(text).toContain('Output reserve')
    })
  })

  it('shows history image token estimate in tooltip', async () => {
    const historyMessages: Message[] = [
      {
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'with image',
        timestamp: 1,
        status: 'completed',
        attachments: [
          {
            id: 'att-1',
            stagingKey: 'chat-attachments/s1/a.png',
            fileName: 'a.png',
            mimeType: 'image/png',
            byteLength: 4000,
            width: 512,
            height: 512
          }
        ]
      }
    ]
    renderRing({ input_tokens: 10000, output_tokens: 5000 }, undefined, { historyMessages })
    const svg = document.querySelector('svg')!
    fireEvent.mouseEnter(svg)
    await waitFor(() => {
      const text = screen.getByRole('tooltip').textContent ?? ''
      expect(text).toContain('历史图片约')
      expect(text).toContain('后续请求将持续计入视觉输入')
    })
  })
})
