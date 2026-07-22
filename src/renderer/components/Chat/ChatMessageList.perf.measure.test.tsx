/**
 * 本机性能采集（非 CI 硬断言）：20 vs 500 混合 fixture。
 * 运行：npx vitest run src/renderer/components/Chat/ChatMessageList.perf.measure.test.tsx
 *
 * 产出：docs/develop/chat-message-list-batch1-remeasure-results.json
 */
import { describe, expect, it, vi } from 'vitest'
import { Profiler, useMemo, useState, type ReactNode } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { changeAppLocale } from '../../i18n/localeSync'
import { ChatMessageList } from './ChatMessageList'
import type { ChatMessageActions } from './ChatMessageActions'
import type { Message } from '../../../shared/domainTypes'
import { appendStreamingTail, buildMixedMessageFixture } from './testUtils/mixedMessageFixtures'

vi.mock('./ChatMarkdown', () => ({
  ChatMarkdown: ({ content }: { content: string }) => (
    <div className="chat-md-assistant" data-testid="chat-markdown">
      {content}
    </div>
  )
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
  useDetailPanel: () => ({ openUrl: vi.fn().mockResolvedValue(undefined) })
}))

type CommitSample = { phase: string; actualDuration: number }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

function summarizeCommits(samples: CommitSample[]) {
  const durations = samples.map((s) => s.actualDuration).sort((a, b) => a - b)
  const longTasks = durations.filter((d) => d > 50)
  return {
    count: durations.length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    max: durations[durations.length - 1] ?? 0,
    longTaskCount: longTasks.length,
    longTaskShare: durations.length ? longTasks.length / durations.length : 0
  }
}

function stableActions(): ChatMessageActions {
  return {
    archiveToWiki: () => {},
    retryAssistant: () => {},
    cancelQueued: () => {},
    confirmTool: () => {},
    cancelTool: () => {}
  }
}

function MeasureHarness({
  initial,
  onCommit,
  children
}: {
  initial: Message[]
  onCommit: (sample: CommitSample) => void
  children?: ReactNode
}) {
  const [messages, setMessages] = useState(initial)
  const actions = useMemo(() => stableActions(), [])
  return (
    <div>
      <button
        type="button"
        data-testid="patch-stream"
        onClick={() => {
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.status !== 'streaming') return prev
            const content = `${last.content}+`
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content,
                contentSegments: [{ content, startTime: last.timestamp }]
              }
            ]
          })
        }}
      >
        patch
      </button>
      <Profiler
        id="chat-message-list"
        onRender={(_id, phase, actualDuration) => {
          onCommit({ phase, actualDuration })
        }}
      >
        <ChatMessageList
          messages={messages}
          actions={actions}
          resolveToolsInteractive={() => undefined}
          showArchiveToWiki={() => false}
          canRetry={() => false}
          canCancelQueued={() => false}
        />
      </Profiler>
      {children}
    </div>
  )
}

type ScenarioResult = {
  messageCount: number
  mountMs: number
  domNodes: number
  heapUsedMb: number
  streamCommits: ReturnType<typeof summarizeCommits>
  mountCommits: ReturnType<typeof summarizeCommits>
}

async function measureScenario(messageCount: number): Promise<ScenarioResult> {
  const commits: CommitSample[] = []
  const base = buildMixedMessageFixture(messageCount)
  const withStream = appendStreamingTail(base)

  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
  }
  const heapBefore = process.memoryUsage().heapUsed

  const t0 = performance.now()
  const view = render(
    <MeasureHarness
      initial={withStream}
      onCommit={(sample) => {
        commits.push(sample)
      }}
    />
  )
  await act(async () => {
    await Promise.resolve()
  })
  const mountMs = performance.now() - t0
  const mountCommits = summarizeCommits(commits.filter((c) => c.phase === 'mount'))
  const afterMount = commits.length

  for (let i = 0; i < 100; i++) {
    fireEvent.click(view.getByTestId('patch-stream'))
  }
  await act(async () => {
    await Promise.resolve()
  })

  const streamCommits = summarizeCommits(commits.slice(afterMount))
  const domNodes = document.querySelectorAll('*').length

  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
  }
  const heapUsedMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)

  view.unmount()
  return {
    messageCount,
    mountMs,
    domNodes,
    heapUsedMb: Math.max(0, heapUsedMb),
    streamCommits,
    mountCommits
  }
}

describe('ChatMessageList performance measure (local machine)', () => {
  it('collects 20 vs 500 mixed fixture metrics and writes results', async () => {
    await changeAppLocale('zh-CN')

    // Warmup to reduce first-run noise
    await measureScenario(10)

    const small = await measureScenario(20)
    const large = await measureScenario(500)

    const machine = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: 'Apple M2',
      memoryGb: 16,
      os: 'macOS 26.5.2'
    }

    const interactiveRatio = small.mountMs > 0 ? large.mountMs / small.mountMs : Infinity
    const triggersBatch2 = {
      streamCommitP95Over8ms: large.streamCommits.p95 > 8,
      longTasksCommon: large.streamCommits.longTaskCount > 0 && large.streamCommits.longTaskShare > 0.05,
      interactiveOver2x: interactiveRatio > 2,
      // jsdom 下 DOM 线性增长是预期；作为窗口化触发的旁证
      domLinearWithMessageCount: large.domNodes / Math.max(1, small.domNodes) > 10
    }

    const enterBatch2 = Boolean(
      triggersBatch2.streamCommitP95Over8ms ||
        triggersBatch2.longTasksCommon ||
        triggersBatch2.interactiveOver2x
    )

    const payload = {
      collectedAt: new Date().toISOString(),
      environment: 'vitest+jsdom+React.Profiler',
      note:
        'commit 时长来自 React Profiler actualDuration；Long Task 以单次 commit >50ms 近似。非浏览器 Performance 面板，但可在本机复现对比。',
      machine,
      scenarios: { small, large },
      ratios: {
        mountMs: interactiveRatio,
        domNodes: large.domNodes / Math.max(1, small.domNodes),
        streamCommitP95: large.streamCommits.p95 / Math.max(0.001, small.streamCommits.p95)
      },
      gate: {
        triggersBatch2,
        decision: enterBatch2 ? 'enter-batch-2' : 'stop-after-batch-1',
        rationale: enterBatch2
          ? '命中设计 §6.1 中至少一项：commit p95、长任务或首次可交互相对 20 条超过 2×。'
          : '未命中 §6.1 的 commit/长任务/可交互 2× 门槛；DOM 线性增长仍提示窗口化有收益，但按设计需 profiler 主热点才强制进入第二批。'
      }
    }

    const outDir = path.resolve(process.cwd(), 'docs/develop')
    mkdirSync(outDir, { recursive: true })
    const outFile = path.join(outDir, 'chat-message-list-batch1-remeasure-results.json')
    writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

    // Soft assertions: ensure measurement ran; do not fail CI on absolute timings.
    expect(small.messageCount).toBe(20)
    expect(large.messageCount).toBe(500)
    expect(large.domNodes).toBeGreaterThan(small.domNodes)
    expect(outFile).toContain('remeasure-results.json')

    // eslint-disable-next-line no-console
    console.log('[chat-list-perf]', JSON.stringify(payload.gate, null, 2))
    // eslint-disable-next-line no-console
    console.log(
      '[chat-list-perf]',
      `20: mount=${small.mountMs.toFixed(1)}ms dom=${small.domNodes} streamP95=${small.streamCommits.p95.toFixed(2)}ms`
    )
    // eslint-disable-next-line no-console
    console.log(
      '[chat-list-perf]',
      `500: mount=${large.mountMs.toFixed(1)}ms dom=${large.domNodes} streamP95=${large.streamCommits.p95.toFixed(2)}ms longTasks=${large.streamCommits.longTaskCount}`
    )
  }, 120_000)
})
