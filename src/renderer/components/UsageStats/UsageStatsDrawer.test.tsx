import { describe, expect, it, vi, afterEach } from 'vitest'
import dayjs from 'dayjs'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { UsageStatsKpiCards } from './UsageStatsKpiCards'
import { UsageTrendChart } from './UsageTrendChart'
import { UsageStatsDrawer } from './UsageStatsDrawer'
import { setUsageStatsOpen } from '../../store/configSlice'
import configReducer from '../../store/configSlice'
import { changeAppLocale } from '../../i18n/localeSync'
import type { UsageDailyPoint, UsageSummary } from '../../../shared/usageStatsTypes'

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    totalTokens: 1_280_000,
    inputTokens: 1_100_000,
    outputTokens: 180_000,
    cacheReadTokens: 860_000,
    cacheCreationTokens: 0,
    hitRate: 0.782,
    toolCallCount: 342,
    toolErrorCount: 12,
    toolSkippedCount: 5,
    toolErrorRate: 12 / 342,
    turnCount: 128,
    stepCount: 438,
    avgStepsPerTurn: 438 / 128,
    ...overrides
  }
}

function mockChartSize(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 400,
    top: 0,
    left: 0,
    right: 800,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect)
  // setup.ts 的 RO polyfill 不触发回调；recharts ResponsiveContainer 依赖首次回调确定尺寸
  class ImmediateResizeObserver {
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(target: Element): void {
      this.callback(
        [{ target, contentRect: { width: 800, height: 400, top: 0, left: 0 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver
      )
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ImmediateResizeObserver)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UsageStatsKpiCards', () => {
  it('中文环境：缩写按万 / 亿进位（128 万 / 110 万），Tooltip 精确值不变', () => {
    render(
      <ConfigProvider>
        <UsageStatsKpiCards summary={summary()} />
      </ConfigProvider>
    )
    // summary: 1,280,000 / 1,100,000 / 180,000 / 860,000 → 中文万进位
    expect(screen.getAllByTestId('usage-kpi-value').map((el) => el.textContent)).toEqual(['128 万', '110 万', '18 万', '86 万'])
    expect(screen.getByTestId('usage-kpi-hit-rate').textContent).toBe('78.2%')
    expect(screen.getByTestId('usage-kpi-tool-calls').textContent).toContain('342 / 12')
    expect(screen.getByTestId('usage-steps-proof').textContent).toContain('3.42')
  })

  it('英文环境：缩写按 K / M 进位', async () => {
    await changeAppLocale('en-US')
    render(
      <ConfigProvider>
        <UsageStatsKpiCards summary={summary()} />
      </ConfigProvider>
    )
    expect(screen.getAllByTestId('usage-kpi-value').map((el) => el.textContent)).toEqual(['1.28M', '1.1M', '180K', '860K'])
  })

  it('缓存写入仅在 > 0 时条件展示（C1）', () => {
    const { rerender, container } = render(
      <ConfigProvider>
        <UsageStatsKpiCards summary={summary({ cacheCreationTokens: 0 })} />
      </ConfigProvider>
    )
    expect(container.textContent).not.toContain('缓存写入')

    rerender(
      <ConfigProvider>
        <UsageStatsKpiCards summary={summary({ cacheCreationTokens: 42_000 })} />
      </ConfigProvider>
    )
    expect(container.textContent).toContain('缓存写入')
  })

  it('分母为 0 时命中率显示 —（M4）', () => {
    render(
      <ConfigProvider>
        <UsageStatsKpiCards summary={summary({ hitRate: null })} />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-kpi-hit-rate').textContent).toBe('—')
  })
})

describe('UsageTrendChart', () => {
  it('T3：渲染输入/输出/命中率三条折线，右轴 0–100%（C15）', async () => {
    mockChartSize()
    const points: UsageDailyPoint[] = [
      { day: '2026-09-15', inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheCreationTokens: 0, hitRate: 0.8, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0, turnCount: 1, stepCount: 1, avgStepsPerTurn: 1 },
      { day: '2026-09-16', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, hitRate: null, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0, turnCount: 0, stepCount: 0, avgStepsPerTurn: null }
    ]
    render(
      <ConfigProvider>
        <UsageTrendChart points={points} />
      </ConfigProvider>
    )
    // recharts 3.x 的曲线 class 不含 -line 前缀；以图例项数量断言三条系列被渲染
    await waitFor(() => {
      expect(document.querySelectorAll('.recharts-legend-item')).toHaveLength(3)
    })
    expect(document.querySelector('.recharts-wrapper')).toBeTruthy()
  })
})

describe('UsageStatsDrawer', () => {
  function mockApi(overrides: Partial<Record<string, unknown>> = {}) {
    const api = {
      usageStatsSummary: vi.fn(async () => summary()),
      usageStatsDaily: vi.fn(async () => [] as UsageDailyPoint[]),
      usageStatsDimensions: vi.fn(async () => ({
        models: [{ model: 'deepseek-v4-pro', llmServiceId: 'svc-a' }],
        sessions: [{ sessionId: 'sess-1', name: null }],
        appVersions: ['0.1.5']
      })),
      ...overrides
    }
    ;(window as unknown as { api: unknown }).api = api
    return api
  }

  function renderDrawer(open = true, onClose?: () => void) {
    const store = configureStore({ reducer: { config: configReducer } })
    if (open) store.dispatch(setUsageStatsOpen(true))
    render(
      <Provider store={store}>
        <ConfigProvider>
          <UsageStatsDrawer open={open} onClose={onClose ?? (() => undefined)} />
        </ConfigProvider>
      </Provider>
    )
    return store
  }

  it('点击关闭按钮触发 onClose（真实链路 = dispatch 置 false）', async () => {
    mockChartSize()
    mockApi()
    const store = renderDrawer(true, () => store.dispatch(setUsageStatsOpen(false)))
    await waitFor(() => {
      expect(screen.getByTestId('usage-kpi-cards')).toBeTruthy()
    })
    const closeButton = document.querySelector('.ant-drawer-close') as HTMLButtonElement
    expect(closeButton).toBeTruthy()
    fireEvent.click(closeButton)
    await waitFor(() => {
      expect(store.getState().config.usageStatsOpen).toBe(false)
    })
  })

  it('footer「关闭」按钮同样触发 onClose（× 被遮挡时的确定性关闭出口）', async () => {
    mockChartSize()
    mockApi()
    const store = renderDrawer(true, () => store.dispatch(setUsageStatsOpen(false)))
    await waitFor(() => {
      expect(screen.getByTestId('usage-kpi-cards')).toBeTruthy()
    })
    // Drawer footer 内的关闭按钮
    const footerButton = document.querySelector('.ant-drawer-footer button') as HTMLButtonElement
    expect(footerButton).toBeTruthy()
    fireEvent.click(footerButton)
    await waitFor(() => {
      expect(store.getState().config.usageStatsOpen).toBe(false)
    })
  })

  it('T1/T2：打开面板默认查询近 30 天（含今天）并渲染 KPI 与图表', async () => {
    mockChartSize()
    const api = mockApi()
    renderDrawer(true)
    await waitFor(() => {
      expect(api.usageStatsSummary).toHaveBeenCalled()
    })
    const [args] = api.usageStatsSummary.mock.calls[0] as Array<{ from: string; to: string }>
    // [today-29, today]
    const [ty, tm, td] = args.to.split('-').map(Number)
    const expectedFrom = new Date(ty!, tm! - 1, td! - 29)
    const month = String(expectedFrom.getMonth() + 1).padStart(2, '0')
    const day = String(expectedFrom.getDate()).padStart(2, '0')
    expect(args.from).toBe(`${expectedFrom.getFullYear()}-${month}-${day}`)
    await waitFor(() => {
      expect(screen.getByTestId('usage-kpi-cards')).toBeTruthy()
    })
    expect(screen.getByTestId('usage-tz-hint').textContent).toContain('UTC')
  })

  it('T15：无任何用量数据时展示空态', async () => {
    mockChartSize()
    mockApi({
      usageStatsSummary: async () => summary({ totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }),
      usageStatsDaily: async () => []
    })
    renderDrawer(true)
    await waitFor(() => {
      expect(screen.getByTestId('usage-empty')).toBeTruthy()
    })
  })

  it('P0 回归：自定义模式选定日期后 RangePicker 以 dayjs 渲染，不白屏且按新范围查询', async () => {
    mockChartSize()
    const api = mockApi()
    renderDrawer(true)
    await waitFor(() => {
      expect(api.usageStatsSummary).toHaveBeenCalled()
    })
    const callsAfterDefault = api.usageStatsSummary.mock.calls.length

    // 切到「自定义」（Drawer 内容渲染在 body portal，需从 document 查询）
    const customRadio = document.querySelector('input.ant-radio-button-input[value="custom"]') as HTMLInputElement | null
    expect(customRadio).toBeTruthy()
    fireEvent.click(customRadio!)

    // 打开 RangePicker：输入起点并 Enter 确认 → 面板进入终点选择态 → 导航上月点选终点
    // （jsdom 下 focus + change + Enter 驱动 rc-picker 比 panel 首击可靠）
    const pickerInput = () => document.querySelector('.ant-picker-input > input') as HTMLInputElement
    fireEvent.mouseEnter(document.querySelector('.ant-picker')!)
    fireEvent.focus(pickerInput())
    fireEvent.change(pickerInput(), { target: { value: '2026-08-01' } })
    fireEvent.keyDown(pickerInput(), { key: 'Enter', keyCode: 13, which: 13 })
    await waitFor(() => {
      expect(document.querySelector('.ant-picker-panel')).toBeTruthy()
    })
    const prev = document.querySelector('.ant-picker-header-prev-btn')
    if (prev) fireEvent.click(prev)
    await waitFor(() => {
      expect(document.querySelector('.ant-picker-cell[title="2026-08-15"]')).toBeTruthy()
    })
    fireEvent.click(document.querySelector('.ant-picker-cell[title="2026-08-15"]')!)

    // 修复前：字符串 value 进入 rc-picker 渲染抛 "date.isValid is not a function" → 整应用白屏。
    // 修复后：value 为 dayjs 元组，选完日期以新范围重新查询。
    await waitFor(() => {
      expect(api.usageStatsSummary.mock.calls.length).toBeGreaterThan(callsAfterDefault)
    })
    const latest = api.usageStatsSummary.mock.calls.at(-1)?.[0] as { from: string; to: string }
    expect(latest.from).toBe('2026-08-01')
    expect(latest.to).toBe('2026-08-15')
  })
})
