import { describe, expect, it } from 'vitest'
import type { AssistantActivityItem } from './assistantActivityTimeline'
import {
  ACTIVITY_BATCH_IDLE_GAP_MS,
  buildActivityItemTimestampResolver,
  groupActivityTimeline
} from './activityBatchGrouping'
import type { SkillHintRecord, ThinkingData, ToolCallRecord } from './domainTypes'

const baseTool = (id: string, startedAt?: number): ToolCallRecord => ({
  id,
  toolName: 'read_file',
  input: { path: 'a.txt' },
  status: 'completed',
  riskLevel: 'low',
  ...(startedAt != null ? { startedAt } : {})
})

describe('groupActivityTimeline', () => {
  const ts = (item: AssistantActivityItem) => {
    if (item.kind === 'thinking') return item.segmentIndex * 100
    if (item.kind === 'tool') return item.toolId === 't1' ? 250 : 350
    if (item.kind === 'text') return 400
    return 150
  }

  it('merges consecutive thinking and tool into one batch', () => {
    const timeline: AssistantActivityItem[] = [
      { kind: 'thinking', segmentIndex: 0 },
      { kind: 'tool', toolId: 't1' },
      { kind: 'tool', toolId: 't2' }
    ]
    expect(groupActivityTimeline(timeline, ts)).toEqual([
      {
        kind: 'batch',
        items: [
          { kind: 'thinking', segmentIndex: 0 },
          { kind: 'tool', toolId: 't1' },
          { kind: 'tool', toolId: 't2' }
        ]
      }
    ])
  })

  it('splits batch on text and skill standalone items', () => {
    const timeline: AssistantActivityItem[] = [
      { kind: 'thinking', segmentIndex: 0 },
      { kind: 'tool', toolId: 't1' },
      { kind: 'text', segmentIndex: 0 },
      { kind: 'tool', toolId: 't2' },
      { kind: 'skill', hintId: 'h1' }
    ]
    expect(groupActivityTimeline(timeline, ts)).toEqual([
      {
        kind: 'batch',
        items: [
          { kind: 'thinking', segmentIndex: 0 },
          { kind: 'tool', toolId: 't1' }
        ]
      },
      { kind: 'standalone', item: { kind: 'text', segmentIndex: 0 } },
      { kind: 'standalone', item: { kind: 'tool', toolId: 't2' } },
      { kind: 'standalone', item: { kind: 'skill', hintId: 'h1' } }
    ])
  })

  it('splits batches when idle gap exceeds 3 minutes', () => {
    const timeline: AssistantActivityItem[] = [
      { kind: 'tool', toolId: 't1' },
      { kind: 'tool', toolId: 't2' }
    ]
    const getTimestamp = (item: AssistantActivityItem) => (item.toolId === 't1' ? 0 : ACTIVITY_BATCH_IDLE_GAP_MS)
    expect(groupActivityTimeline(timeline, getTimestamp)).toEqual([
      { kind: 'standalone', item: { kind: 'tool', toolId: 't1' } },
      { kind: 'standalone', item: { kind: 'tool', toolId: 't2' } }
    ])
  })

  it('renders single thinking or tool as standalone instead of batch', () => {
    expect(groupActivityTimeline([], ts)).toEqual([])
    expect(groupActivityTimeline([{ kind: 'thinking', segmentIndex: 0 }], ts)).toEqual([
      { kind: 'standalone', item: { kind: 'thinking', segmentIndex: 0 } }
    ])
    expect(groupActivityTimeline([{ kind: 'tool', toolId: 't1' }], ts)).toEqual([
      { kind: 'standalone', item: { kind: 'tool', toolId: 't1' } }
    ])
  })
})

describe('buildActivityItemTimestampResolver', () => {
  it('resolves timestamps from message data', () => {
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
      toolCalls: [baseTool('t1', 250)],
      skillHints: [{ id: 'h1', text: 'hint', shownAt: 120 } satisfies SkillHintRecord]
    }
    const resolve = buildActivityItemTimestampResolver(message)
    expect(resolve({ kind: 'thinking', segmentIndex: 0 })).toBe(100)
    expect(resolve({ kind: 'tool', toolId: 't1' })).toBe(250)
    expect(resolve({ kind: 'text', segmentIndex: 0 })).toBe(300)
    expect(resolve({ kind: 'skill', hintId: 'h1' })).toBe(120)
  })
})
