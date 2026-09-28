import { describe, expect, it } from 'vitest'
import type { Message, ToolCallRecord } from '../../../shared/domainTypes'
import { areToolCallCardPropsEqual } from './ToolCallCard'

const baseProps = (record: ToolCallRecord) => ({
  record,
  messageId: 'm1',
  turnId: undefined,
  sessionId: 's1',
  focus: false,
  workDir: '/w',
  shellConfig: undefined,
  sessionMetadata: undefined,
  toolCalls: [record] as Message['toolCalls'],
  displaySummary: undefined,
  confirmationReady: undefined,
  onConfirm: undefined,
  onCancel: undefined,
  onOpenFile: undefined,
  activeSearchTarget: null
})

const record = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id: 't1',
  toolName: 'grep',
  input: { pattern: 'x' },
  status: 'failed',
  riskLevel: 'low',
  completedAt: 1000,
  result: { success: false, error: 'deny', userMessage: 'V1 文件读取仅支持单个普通文件目标' },
  ...over
})

describe('areToolCallCardPropsEqual（渲染边界内容防抖）', () => {
  it('内容相同的每帧新引用 record → 相等（memo 拦截,零重渲染）', () => {
    const prev = baseProps(record())
    const next = { ...prev, record: record(), toolCalls: [record()] as Message['toolCalls'] }
    expect(areToolCallCardPropsEqual(prev, next)).toBe(true)
  })

  it('progressOutput 尾部快照变化（执行中输出增长）→ 不相等', () => {
    const prev = baseProps(record({ status: 'executing', progressOutput: 'line1' }))
    const next = baseProps(record({ status: 'executing', progressOutput: 'line1\nline2' }))
    expect(areToolCallCardPropsEqual(prev, next)).toBe(false)
  })

  it('status 终态切换 → 不相等', () => {
    const prev = baseProps(record({ status: 'executing' }))
    const next = baseProps(record({ status: 'failed' }))
    expect(areToolCallCardPropsEqual(prev, next)).toBe(false)
  })

  it('result 内容变化（userMessage 更新）→ 不相等', () => {
    const prev = baseProps(record())
    const next = baseProps(record({ result: { success: false, error: 'deny', userMessage: '新原因' } }))
    expect(areToolCallCardPropsEqual(prev, next)).toBe(false)
  })

  it('input 内容相同引用不同 → 相等；内容不同 → 不相等', () => {
    const prev = baseProps(record({ input: { pattern: 'x' } }))
    const sameContent = baseProps(record({ input: { pattern: 'x' } }))
    expect(areToolCallCardPropsEqual(prev, sameContent)).toBe(true)
    const changed = baseProps(record({ input: { pattern: 'y' } }))
    expect(areToolCallCardPropsEqual(prev, changed)).toBe(false)
  })

  it('焦点/确认就绪等行级 props 变化 → 不相等', () => {
    const prev = baseProps(record())
    expect(areToolCallCardPropsEqual(prev, { ...prev, focus: true })).toBe(false)
    expect(areToolCallCardPropsEqual(prev, { ...prev, confirmationReady: true })).toBe(false)
  })

  it('displaySummary 展示位变化 → 不相等；同值新引用 → 相等', () => {
    const summary = { hasDetails: true, progressPreviewTruncated: false, resultPreviewTruncated: false, confirmRisk: 'low' as const }
    const prev = { ...baseProps(record()), displaySummary: summary }
    expect(areToolCallCardPropsEqual(prev, { ...prev, displaySummary: { ...summary } })).toBe(true)
    expect(areToolCallCardPropsEqual(prev, { ...prev, displaySummary: { ...summary, hasDetails: false } })).toBe(false)
  })
})
