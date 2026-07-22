/**
 * Batch2 本机复测：全量 500 vs 最新页 60（窗口化数据面）。
 * 运行：npx vitest run src/renderer/components/Chat/ChatMessageList.perf.batch2.measure.test.tsx
 *
 * 产出：docs/develop/chat-message-list-batch2-remeasure-results.json
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
  onCommit
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
        id="chat-message-list-batch2"
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
    </div>
  )
}

type ScenarioResult = {
  label: string
  messageCount: number
  mountMs: number
  domNodes: number
  heapUsedMb: number
  streamCommits: ReturnType<typeof summarizeCommits>
  mountCommits: ReturnType<typeof summarizeCommits>
}

async function measureScenario(label: string, messageCount: number): Promise<ScenarioResult> {
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
  const heapUsedMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)
  view.unmount()

  return {
    label,
    messageCount,
    mountMs,
    domNodes,
    heapUsedMb,
    streamCommits,
    mountCommits
  }
}

describe('ChatMessageList batch2 remasure', () => {
  it('compares full-500 vs latest-page-60 mount cost', async () => {
    await changeAppLocale('zh-CN')
    const full500 = await measureScenario('full-500', 500)
    const page60 = await measureScenario('latest-page-60', 60)

    const outDir = path.join(process.cwd(), 'docs/develop')
    mkdirSync(outDir, { recursive: true })
    const payload = {
      measuredAt: new Date().toISOString(),
      machine: {
        platform: process.platform,
        arch: process.arch,
        node: process.version
      },
      scenarios: [full500, page60],
      ratios: {
        mountMsPageOverFull: page60.mountMs / Math.max(full500.mountMs, 0.001),
        domNodesPageOverFull: page60.domNodes / Math.max(full500.domNodes, 1),
        mountCommitMaxPage: page60.mountCommits.max,
        mountCommitMaxFull: full500.mountCommits.max
      }
    }
    writeFileSync(
      path.join(outDir, 'chat-message-list-batch2-remeasure-results.json'),
      JSON.stringify(payload, null, 2)
    )

    expect(page60.mountMs).toBeLessThan(full500.mountMs)
    expect(page60.domNodes).toBeLessThan(full500.domNodes)
    expect(page60.mountCommits.max).toBeLessThan(full500.mountCommits.max)
  }, 120_000)
})
