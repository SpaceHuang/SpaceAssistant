import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { UsageCompositionBar } from './UsageCompositionBar'
import { UsageInsightCards } from './UsageInsightCards'
import { UsageBreakdownTable } from './UsageBreakdownTable'
import { UsageCompositionPanel } from './UsageCompositionPanel'
import type { UsageAttributionComposition, UsageAttributionDailyPoint, UsageAttributionOutputSplit, UsageToolAttributionBreakdown } from '../../../shared/usageStatsTypes'

function composition(overrides: Partial<UsageAttributionComposition> = {}): UsageAttributionComposition {
  return {
    estimatorVersion: 'block-v1',
    attributableInputTokens: 100_000,
    totalInputTokens: 100_000,
    attributionCoverage: 1,
    categories: {
      system: 2_000,
      tools: 18_000,
      userText: 10_000,
      assistantText: 20_000,
      toolResults: 48_000,
      assistantThinking: 1_000,
      assistantToolUse: 500,
      other: 500
    },
    ...overrides
  }
}

function breakdown(overrides: Partial<UsageToolAttributionBreakdown> = {}): UsageToolAttributionBreakdown {
  return {
    used: [
      { name: 'grep', source: 'builtin', declaredChars: 900, calls: 146, resultChars: 501_404 },
      { name: 'read_file', source: 'builtin', declaredChars: 800, calls: 76, resultChars: 302_598 },
      { name: 'list_directory', source: 'builtin', declaredChars: 700, calls: 12, resultChars: 50_265 }
    ],
    unused: [
      { name: 'mcp_scys_searchtopic', source: 'mcp', declaredChars: 4_802, calls: null, resultChars: null },
      { name: 'mcp_scys_searchparties', source: 'mcp', declaredChars: 2_465, calls: null, resultChars: null }
    ],
    totalDeclaredChars: 10_000,
    unusedDeclaredChars: 7_267,
    ...overrides
  }
}

function outputSplit(overrides: Partial<UsageAttributionOutputSplit> = {}): UsageAttributionOutputSplit {
  return {
    estimatorVersion: 'block-v1',
    attributableOutputTokens: 292_827,
    totalOutputTokens: 292_827,
    categories: { thinking: 200_000, text: 60_000, toolUseArgs: 32_827 },
    ...overrides
  }
}

describe('UsageCompositionBar（视图①：构成快照）', () => {
  it('渲染各类别段与图例，并带「估算」标注；估算器版本号不得出现在界面文本（内部口径）', () => {
    render(
      <ConfigProvider>
        <UsageCompositionBar composition={composition()} />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-composition-bar')).toBeTruthy()
    const segments = screen.getAllByTestId('usage-composition-segment')
    expect(segments.length).toBe(8)
    // 段宽按占比（横向 100% 堆叠条形，AD19 不做饼图）
    const widths = segments.map((el) => Number((el as HTMLElement).style.width.replace('%', '')))
    expect(Math.round(widths.reduce((a, b) => a + b, 0))).toBe(100)
    const bar = screen.getByTestId('usage-composition-bar')
    expect(bar.textContent).toContain('估算')
    // 版本号只保留在悬停 title 中（排障可查），不进可见文本
    expect(bar.textContent).not.toContain('block-v1')
    expect(bar.getAttribute('title')).toBe('block-v1')
  })
})

describe('UsageInsightCards（视图④：3 条硬编码规则，相对判据，AD22）', () => {
  it('未使用工具占声明成本过半 → 渲染未使用工具卡（SRC-B4）', () => {
    render(
      <ConfigProvider>
        <UsageInsightCards composition={composition()} toolBreakdown={breakdown()} />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-insight-unused-tools').textContent).toContain('2')
    expect(screen.getByTestId('usage-insight-unused-tools').textContent).toContain('72.7%')
  })

  it('固定成本占比 < 10% → 渲染固定/增量卡（SRC-A3）', () => {
    render(
      <ConfigProvider>
        <UsageInsightCards
          composition={composition({
            categories: { system: 500, tools: 4_000, userText: 10_000, assistantText: 20_000, toolResults: 60_000, assistantThinking: 1_000, assistantToolUse: 500, other: 0 }
          })}
          toolBreakdown={breakdown()}
        />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-insight-fixed-cost').textContent).toContain('4.5%')
  })

  it('Top 3 工具返回占全部返回过半 → 渲染工具返回膨胀卡（SRC-C1）', () => {
    render(
      <ConfigProvider>
        <UsageInsightCards composition={composition()} toolBreakdown={breakdown()} />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-insight-top-results').textContent).toContain('100.0%')
  })

  it('数据不足时对应卡片整张不渲染，不展示空卡（I5/§6.6.4）', () => {
    render(
      <ConfigProvider>
        <UsageInsightCards
          composition={composition({
            categories: { system: 40_000, tools: 40_000, userText: 5_000, assistantText: 5_000, toolResults: 5_000, assistantThinking: 0, assistantToolUse: 0, other: 0 }
          })}
          toolBreakdown={{ used: [], unused: [], totalDeclaredChars: 0, unusedDeclaredChars: 0 }}
        />
      </ConfigProvider>
    )
    expect(screen.queryByTestId('usage-insight-unused-tools')).toBeNull()
    expect(screen.queryByTestId('usage-insight-top-results')).toBeNull()
    expect(screen.queryByTestId('usage-insight-fixed-cost')).toBeNull()
  })
})

describe('UsageBreakdownTable（视图③：明细排行 + 未使用下钻，AT3/AT4）', () => {
  it('使用中工具按返回体量排序，字符口径带【派生】标注，不呈现为 token（I2）', () => {
    render(
      <ConfigProvider>
        <UsageBreakdownTable breakdown={breakdown()} />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-breakdown-table')).toBeTruthy()
    const rows = screen.getAllByTestId('usage-breakdown-row')
    expect(rows[0]!.textContent).toContain('grep')
    // 字符口径标注
    expect(screen.getByTestId('usage-breakdown-table').textContent).toContain('派生')
  })

  it('未使用工具可下钻到工具名清单（AT3）', () => {
    render(
      <ConfigProvider>
        <UsageBreakdownTable breakdown={breakdown()} />
      </ConfigProvider>
    )
    const unused = screen.getByTestId('usage-breakdown-unused')
    expect(unused.textContent).toContain('mcp_scys_searchtopic')
    expect(unused.textContent).toContain('mcp_scys_searchparties')
  })

  it('无未使用工具时显示空态文案，不渲染空清单', () => {
    render(
      <ConfigProvider>
        <UsageBreakdownTable breakdown={breakdown({ unused: [], unusedDeclaredChars: 0 })} />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-breakdown-unused').textContent).toContain('至少被调用过一次')
  })
})

describe('UsageCompositionPanel（覆盖率 I7 / 混合区间 AT16 / 空态）', () => {
  it('覆盖率 < 100% 时必须显式展示覆盖率与未归因量，不静默（I7）', () => {
    render(
      <ConfigProvider>
        <UsageCompositionPanel
          composition={composition({ attributableInputTokens: 100_000, totalInputTokens: 150_000, attributionCoverage: 2 / 3 })}
          daily={[]}
          outputSplit={outputSplit()}
          toolBreakdown={breakdown()}
        />
      </ConfigProvider>
    )
    const coverage = screen.getByTestId('usage-attribution-coverage')
    expect(coverage.textContent).toContain('66.7%')
    expect(coverage.textContent).toContain('无可归因数据')
  })

  it('覆盖率为 0 / 无可归因数据 → 空态 + 原因说明，不渲染构成图（AT16）', () => {
    render(
      <ConfigProvider>
        <UsageCompositionPanel
          composition={composition({
            attributableInputTokens: 0,
            totalInputTokens: 42_000,
            attributionCoverage: 0,
            categories: { system: 0, tools: 0, userText: 0, assistantText: 0, toolResults: 0, assistantThinking: 0, assistantToolUse: 0, other: 0 }
          })}
          daily={[]}
          outputSplit={outputSplit({ attributableOutputTokens: 0, categories: { thinking: 0, text: 0, toolUseArgs: 0 } })}
          toolBreakdown={breakdown({ used: [], unused: [], totalDeclaredChars: 0, unusedDeclaredChars: 0 })}
        />
      </ConfigProvider>
    )
    expect(screen.getByTestId('usage-attribution-empty')).toBeTruthy()
    expect(screen.queryByTestId('usage-composition-bar')).toBeNull()
  })

  it('覆盖率 100% 时正常渲染构成快照与漂移，不额外提示', () => {
    const daily: UsageAttributionDailyPoint[] = [
      { day: '2026-09-15', attributableInputTokens: 60_000, totalInputTokens: 60_000, categories: composition().categories },
      { day: '2026-09-16', attributableInputTokens: 40_000, totalInputTokens: 40_000, categories: composition().categories }
    ]
    render(
      <ConfigProvider>
        <UsageCompositionPanel
          composition={composition()}
          daily={daily}
          outputSplit={outputSplit()}
          toolBreakdown={breakdown()}
        />
      </ConfigProvider>
    )
    expect(screen.queryByTestId('usage-attribution-empty')).toBeNull()
    expect(screen.getByTestId('usage-composition-bar')).toBeTruthy()
    expect(screen.getByTestId('usage-composition-output')).toBeTruthy()
    expect(screen.getByTestId('usage-composition-output').textContent).toContain('思考')
  })
})
