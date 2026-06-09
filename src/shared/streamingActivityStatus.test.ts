import { describe, expect, it } from 'vitest'
import type { Message } from './domainTypes'
import { formatStreamingElapsed, resolveStreamingActivityStatus } from './streamingActivityStatus'

const t = (key: string, options?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    'streaming.inProgress': '生成中',
    'streaming.thinking': '思考中',
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

describe('formatStreamingElapsed', () => {
  it('formats mm:ss', () => {
    expect(formatStreamingElapsed(0)).toBe('0:00')
    expect(formatStreamingElapsed(65_000)).toBe('1:05')
    expect(formatStreamingElapsed(185_000)).toBe('3:05')
  })
})

describe('resolveStreamingActivityStatus', () => {
  it('returns null when not streaming', () => {
    expect(
      resolveStreamingActivityStatus({
        message: assistantMessage({ status: 'completed' }),
        formatToolLabel: () => 'label',
        t
      })
    ).toBeNull()
  })

  it('prefers confirming tool', () => {
    const status = resolveStreamingActivityStatus({
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
    expect(status?.label).toBe('等待确认：写入 a.txt')
  })

  it('shows executing tool with progress detail', () => {
    const status = resolveStreamingActivityStatus({
      message: assistantMessage({
        toolCalls: [
          {
            id: 't1',
            toolName: 'run_shell',
            input: { command: 'npm install' },
            status: 'executing',
            riskLevel: 'medium',
            startedAt: 1,
            progressOutput: 'added 47 packages\nin 3s'
          }
        ]
      }),
      formatToolLabel: () => 'npm install',
      t
    })
    expect(status?.label).toBe('npm install')
    expect(status?.detail).toBe('added 47 packages')
  })

  it('falls back to thinking label', () => {
    const status = resolveStreamingActivityStatus({
      message: assistantMessage({
        thinking: {
          content: 'hmm',
          isVisible: true,
          startTime: 1,
          segments: [{ content: 'hmm', startTime: 1 }]
        }
      }),
      formatToolLabel: () => 'x',
      t
    })
    expect(status?.label).toBe('思考中')
  })

  it('falls back to generating', () => {
    const status = resolveStreamingActivityStatus({
      message: assistantMessage({}),
      formatToolLabel: () => 'x',
      t
    })
    expect(status?.label).toBe('生成中')
  })
})
