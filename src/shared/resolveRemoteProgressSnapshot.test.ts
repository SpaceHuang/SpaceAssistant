import { describe, expect, it } from 'vitest'
import type { Message } from './domainTypes'
import { resolveRemoteProgressSnapshot } from './resolveRemoteProgressSnapshot'

const t = (key: string, options?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    'streaming.thinking': '思考中',
    'streaming.inProgress': '生成中',
    'streaming.preparing': '准备中…',
    'streaming.awaitingConfirm': `等待确认：${options?.action ?? ''}`
  }
  return map[key] ?? key
}

function assistantMessage(partial: Partial<Message>): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    content: '',
    timestamp: 1_000_000,
    status: 'streaming',
    schemaVersion: 1,
    ...partial
  }
}

describe('resolveRemoteProgressSnapshot', () => {
  it('returns publishable tool snapshot with progress detail', () => {
    const snap = resolveRemoteProgressSnapshot({
      message: assistantMessage({
        toolCalls: [
          {
            id: 't1',
            toolName: 'grep',
            input: { pattern: 'src' },
            status: 'executing',
            riskLevel: 'low',
            startedAt: 1,
            progressOutput: 'searching...\nline 2'
          }
        ]
      }),
      formatToolLabel: () => '搜索文件 src',
      t
    })
    expect(snap.publishable).toBe(true)
    expect(snap.kind).toBe('tool')
    expect(snap.label).toBe('搜索文件 src')
    expect(snap.detail).toBe('searching...')
  })

  it('returns non-publishable during thinking', () => {
    const snap = resolveRemoteProgressSnapshot({
      message: assistantMessage({
        toolCalls: [
          {
            id: 't1',
            toolName: 'grep',
            input: {},
            status: 'completed',
            riskLevel: 'low',
            startedAt: 1,
            completedAt: 2
          }
        ],
        thinking: {
          content: 'hmm',
          isVisible: true,
          startTime: 1,
          segments: [{ content: 'hmm', startTime: 1 }]
        }
      }),
      formatToolLabel: () => 'grep',
      t
    })
    expect(snap.publishable).toBe(false)
    expect(snap.label).toBe('思考中')
  })

  it('does not publish open content segment (streaming text)', () => {
    const snap = resolveRemoteProgressSnapshot({
      message: assistantMessage({
        content: 'partial sentence',
        contentSegments: [{ content: 'partial sentence', startTime: 1 }]
      }),
      formatToolLabel: () => 'x',
      t
    })
    expect(snap.publishable).toBe(false)
    expect(snap.label).toBe('生成中')
  })

  it('returns publishable text snapshot after segment closed', () => {
    const snap = resolveRemoteProgressSnapshot({
      message: assistantMessage({
        content: '已找到 12 个匹配文件\n正在读取前 3 个',
        contentSegments: [
          {
            content: '已找到 12 个匹配文件\n正在读取前 3 个',
            startTime: 1,
            endTime: 2
          }
        ]
      }),
      formatToolLabel: () => 'x',
      t
    })
    expect(snap.publishable).toBe(true)
    expect(snap.kind).toBe('text')
    expect(snap.label).toBe('已找到 12 个匹配文件')
    expect(snap.detail).toBe('正在读取前 3 个')
  })

  it('prefers confirm over tool', () => {
    const snap = resolveRemoteProgressSnapshot({
      message: assistantMessage({
        toolCalls: [
          {
            id: 't1',
            toolName: 'write_file',
            input: { path: 'a.txt' },
            status: 'confirming',
            riskLevel: 'medium',
            startedAt: 1
          }
        ]
      }),
      formatToolLabel: () => '写入 a.txt',
      t
    })
    expect(snap.kind).toBe('confirm')
    expect(snap.label).toBe('等待确认：写入 a.txt')
  })
})
