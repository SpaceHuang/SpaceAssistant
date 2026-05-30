import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import chatReducer, { setLastUsage, setSession } from '../../store/chatSlice'
import configReducer, { setConfig } from '../../store/configSlice'
import { buildContextRingSegments, ContextUsageRing } from './ContextUsageRing'
import type { AppConfig } from '../../../shared/domainTypes'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_SKILLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: [],
    activeLlmServiceId: '',
    model: 'claude-sonnet-4-6',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: '1', name: 'claude-sonnet-4-6', maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: false, enabled: true }
    ],
    thinkingEnabled: false,
    workDir: '',
    uiTheme: 'system',
    defaultChatMode: 'normal',
    maxParallelChatSessions: 3,
    tools: { ...DEFAULT_TOOLS_CONFIG, enabled: false },
    skills: { ...DEFAULT_SKILLS_CONFIG },
    wiki: { ...DEFAULT_WIKI_CONFIG },
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

describe('buildContextRingSegments', () => {
  const C = 100

  it('places used then reserved contiguously on one ring', () => {
    const segs = buildContextRingSegments(0.1, 0.32, C)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ color: 'var(--sa-primary)', dashLen: 10, dashOffset: 0 })
    expect(segs[1]).toEqual({ color: '#666', dashLen: 32, dashOffset: -10 })
  })

  it('omits zero-length segments', () => {
    expect(buildContextRingSegments(0, 0.5, C)).toEqual([{ color: '#666', dashLen: 50, dashOffset: -0 }])
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
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })

  it('renders contiguous segments on one ring when usage data is available', () => {
    renderRing({ input_tokens: 10000, output_tokens: 5000 })
    const circles = document.querySelectorAll('circle')
    expect(circles).toHaveLength(3)
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
    const radii = Array.from(circles).map((c) => c.getAttribute('r'))
    expect(new Set(radii).size).toBe(1)
    const colors = Array.from(circles).map((c) => c.getAttribute('stroke'))
    expect(colors).toContain('var(--sa-primary)')
    expect(colors).toContain('#666')
  })

  it('offsets reserved segment after used segment', () => {
    renderRing({ input_tokens: 10000, output_tokens: 5000 })
    const circles = Array.from(document.querySelectorAll('circle'))
    const used = circles.find((c) => c.getAttribute('stroke') === 'var(--sa-primary)')
    const reserved = circles.find((c) => c.getAttribute('stroke') === '#666')
    expect(used?.getAttribute('stroke-dashoffset')).toBe('0')
    expect(Number(reserved?.getAttribute('stroke-dashoffset'))).toBeLessThan(0)
  })

  it('clamps segments when estimated occupancy plus output max exceeds maximumContext', () => {
    renderRing({ input_tokens: 199000, output_tokens: 1000 })
    const circles = Array.from(document.querySelectorAll('circle'))
    expect(circles.length).toBeGreaterThan(1)
    const segments = circles.filter((c) => c.getAttribute('stroke') !== '#ddd')
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
    expect(circles[0]?.getAttribute('stroke')).toBe('#ddd')
  })

  it('resets to empty ring when lastUsage becomes null after session switch', () => {
    const { store, rerender } = renderRing({ input_tokens: 5000 })
    expect(document.querySelectorAll('circle').length).toBeGreaterThan(1)

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
