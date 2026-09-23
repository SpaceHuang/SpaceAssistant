import { describe, expect, it } from 'vitest'
import { buildAssistantActivityTimeline } from './assistantActivityTimeline'
import { toTurnDisplay, turnDisplayToMessage, truncateUtf8, MAX_BOUNDED_DISPLAY_META_BYTES, MAX_PREVIEW_BYTES, toConfirmationSnapshot, measureTurnDisplayBytes } from './turnDisplayProtocol'

const baseMessage = {
  id: 'm1', sessionId: 's1', role: 'assistant' as const, timestamp: 1,
  status: 'streaming' as const, schemaVersion: 1, content: '你好世界',
  contentSegments: [{ content: '你好', startTime: 10 }, { content: '世界', startTime: 30 }],
  thinking: { content: '思考', isVisible: true, startTime: 5 },
  skillHints: [{ id: 'skill-1', text: '技能提示', shownAt: 20 }],
  toolCalls: [{ id: 'tool-1', toolName: 'grep', input: { q: 'x' }, status: 'completed' as const, riskLevel: 'low' as const, result: { success: true, data: '结果'.repeat(1000) }, startedAt: 25 }]
}

describe('turn display protocol', () => {
  it('保留主进程 activity 排序，并将正文转换为 UTF-16 半开区间', () => {
    const display = toTurnDisplay({ turnId: 't1', requestId: 'r1', version: 3, lifecycle: 'running', message: baseMessage })
    expect(display.message.activity).toEqual(buildAssistantActivityTimeline(baseMessage).map((item) => {
      if (item.kind !== 'text') return item
      const segment = baseMessage.contentSegments[item.segmentIndex]!
      const start = baseMessage.contentSegments!.slice(0, item.segmentIndex).reduce((offset, previous) => offset + previous.content.length, 0)
      return { ...item, contentStart: start, contentEnd: start + segment.content.length }
    }))
    expect(display.message.toolCalls[0]!.display).toMatchObject({ hasDetails: true, resultPreviewTruncated: true })
    expect(baseMessage.toolCalls[0]!.result?.data).toHaveLength(2000)
  })

  it('重复正文片段按规范 segment 顺序定位，而不是回指第一次出现', () => {
    const message = {
      ...baseMessage,
      content: '继续继续',
      contentSegments: [
        { content: '继续', startTime: 10 },
        { content: '继续', startTime: 30 }
      ],
      thinking: undefined,
      skillHints: [],
      toolCalls: []
    }
    const display = toTurnDisplay({ turnId: 't-repeat', requestId: 'r1', version: 1, lifecycle: 'running', message })
    expect(display.message.contentSegments).toEqual([
      { segmentIndex: 0, start: 0, end: 2 },
      { segmentIndex: 1, start: 2, end: 4 }
    ])
    expect(display.message.activity).toEqual([
      { kind: 'text', segmentIndex: 0, contentStart: 0, contentEnd: 2 },
      { kind: 'text', segmentIndex: 1, contentStart: 2, contentEnd: 4 }
    ])
  })

  it('大字符串预览只扫描有界 UTF-8 前缀', () => {
    const value = 'a'.repeat(10_000_000)
    const startedAt = performance.now()
    const result = truncateUtf8(value, MAX_PREVIEW_BYTES)
    const elapsedMs = performance.now() - startedAt
    expect(result).toEqual({ value: 'a'.repeat(MAX_PREVIEW_BYTES), truncated: true })
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('按 UTF-8 字节截断且不切断 surrogate pair', () => {
    expect(truncateUtf8('😀😀a', 5)).toEqual({ value: '😀', truncated: true })
  })

  it('暴露固定的有界展示预算', () => {
    expect(MAX_BOUNDED_DISPLAY_META_BYTES).toBeGreaterThan(0)
    expect(toTurnDisplay({ turnId: 't1', requestId: 'r1', version: 1, lifecycle: 'completed', message: baseMessage })).toHaveProperty('version', 1)
  })

  it('从完整工具事实派生不可截断的确认快照', () => {
    const snapshot = toConfirmationSnapshot({ sessionId: 's1', turnId: 't1', requestId: 'r1', turnVersion: 8, tool: {
      ...baseMessage.toolCalls[0]!, status: 'confirming', confirmDiff: { oldContent: 'old', newContent: 'new', oldPath: 'a.txt' },
      memoryTiers: [{ key: { kind: 'path', path: 'a.txt', level: 'file' }, label: '记住此文件' }],
      shellSecurityHints: { requiresRiskAck: true, outsideWorkDirRisk: false, warnings: ['warning'] },
      autoApproveFallback: { reason: 'too large', reasonCode: 'SIZE' }
    } })
    expect(snapshot).toMatchObject({ sessionId: 's1', turnId: 't1', requestId: 'r1', turnVersion: 8, toolCallId: 'tool-1', confirmation: {
      complete: true, diff: JSON.stringify({ oldContent: 'old', newContent: 'new', oldPath: 'a.txt' }),
      memoryTiers: [{ optionId: 1, label: '记住此文件' }], shellSecurityHints: { requiresRiskAck: true }, autoApproveFallback: { reasonCode: 'SIZE' }
    } })
  })

  it('测量实际 payload 与 activity index，不改变 display 内容或协议', () => {
    const display = toTurnDisplay({ turnId: 't1', requestId: 'r1', version: 1, lifecycle: 'running', message: baseMessage })
    const measured = measureTurnDisplayBytes(display)
    expect(measured.payloadBytes).toBeGreaterThan(measured.activityIndexBytes)
    expect(measured.activityIndexBytes).toBeGreaterThan(0)
    expect(display.message.content).toBe(baseMessage.content)
  })

  it('可将 bounded display 转成不含大字段的 renderer Message', () => {
    const display = toTurnDisplay({ turnId: 't1', requestId: 'r1', version: 1, lifecycle: 'running', message: baseMessage })
    const message = turnDisplayToMessage(display)
    expect(message.toolCalls?.[0]).toMatchObject({ id: 'tool-1', toolName: 'grep', input: {} })
    expect(message.content).toBe(baseMessage.content)
    expect(message.toolCalls?.[0]?.result).toBeUndefined()
  })

  it('保留审批 Agent 标记，避免 bounded display 把自动裁决恢复成人工确认', () => {
    const messageWithAgentApproval = {
      ...baseMessage,
      toolCalls: [{ ...baseMessage.toolCalls[0]!, status: 'confirming' as const, autoAnswerer: true as const }]
    }
    const display = toTurnDisplay({ turnId: 't-agent', requestId: 'r-agent', version: 2, lifecycle: 'awaiting-confirmation', message: messageWithAgentApproval })

    expect(display.message.toolCalls[0]?.display.autoAnswerer).toBe(true)
    expect(turnDisplayToMessage(display).toolCalls?.[0]?.autoAnswerer).toBe(true)
  })
})
