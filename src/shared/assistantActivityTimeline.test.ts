import { describe, expect, it } from 'vitest'
import { buildAssistantActivityTimeline } from './assistantActivityTimeline'
import type { ThinkingData, ToolCallRecord } from './domainTypes'

const baseTool = (id: string, startedAt?: number): ToolCallRecord => ({
  id,
  toolName: 'read_file',
  input: { path: 'a.txt' },
  status: 'completed',
  riskLevel: 'low',
  ...(startedAt != null ? { startedAt } : {})
})

describe('buildAssistantActivityTimeline', () => {
  it('interleaves thinking, text and tools by timestamp', () => {
    const message = {
      content: 'answer',
      timestamp: 1,
      contentSegments: [{ content: 'answer', startTime: 300, endTime: 400 }],
      thinking: {
        content: 'think',
        isVisible: true,
        startTime: 1,
        segments: [{ content: 'think', startTime: 100, endTime: 200 }]
      } satisfies ThinkingData,
      toolCalls: [baseTool('t1', 250)]
    }
    expect(buildAssistantActivityTimeline(message)).toEqual([
      { kind: 'thinking', segmentIndex: 0 },
      { kind: 'tool', toolId: 't1' },
      { kind: 'text', segmentIndex: 0 }
    ])
  })

  it('zip interleaves legacy thinking and tools then appends text', () => {
    const message = {
      content: 'final',
      timestamp: 1,
      thinking: {
        content: 'ab',
        isVisible: true,
        startTime: 1,
        segments: [
          { content: 'a', startTime: 100, endTime: 200 },
          { content: 'b', startTime: 400, endTime: 500 }
        ]
      } satisfies ThinkingData,
      toolCalls: [baseTool('t1'), baseTool('t2')]
    }
    expect(buildAssistantActivityTimeline(message)).toEqual([
      { kind: 'thinking', segmentIndex: 0 },
      { kind: 'tool', toolId: 't1' },
      { kind: 'thinking', segmentIndex: 1 },
      { kind: 'tool', toolId: 't2' },
      { kind: 'text', segmentIndex: 0 }
    ])
  })
})
