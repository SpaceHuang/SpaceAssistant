import { describe, expect, it } from 'vitest'
import {
  MAX_OUTPUT_RECOVERIES,
  buildOutputRecoveryMessage,
  buildTruncatedToolResults,
  classifyOutputRecovery,
  shouldRecoverOutput
} from './outputRecovery'

describe('output recovery policy', () => {
  it('classifies max_tokens without tools as recoverable, regardless of visible thinking', () => {
    expect(classifyOutputRecovery({ stopReason: 'max_tokens', content: [{ type: 'thinking', thinking: 'hidden' }] })).toBe('output_truncated_without_tools')
    expect(classifyOutputRecovery({ stopReason: 'max_tokens', content: [] })).toBe('output_truncated_without_tools')
    expect(classifyOutputRecovery({ stopReason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] })).toBe('output_truncated_without_tools')
  })

  it('does not infer truncation from content or usage when stop reason is absent/other', () => {
    expect(classifyOutputRecovery({ stopReason: undefined, content: [{ type: 'thinking', thinking: 'long' }] })).toBe('none')
    expect(classifyOutputRecovery({ stopReason: 'other', content: [] })).toBe('none')
  })

  it('classifies a response containing tools separately and pairs valid calls with failures', () => {
    expect(classifyOutputRecovery({ stopReason: 'max_tokens', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] })).toBe('output_truncated_with_tools')
    expect(buildTruncatedToolResults([{ id: 't1' }, { id: '' }, {}])).toHaveLength(1)
  })

  it('allows exactly two recoveries per turn', () => {
    expect(shouldRecoverOutput(0)).toBe(true)
    expect(shouldRecoverOutput(MAX_OUTPUT_RECOVERIES - 1)).toBe(true)
    expect(shouldRecoverOutput(MAX_OUTPUT_RECOVERIES)).toBe(false)
  })

  it('builds a runtime user message without pretending to be a real user turn', () => {
    const message = buildOutputRecoveryMessage({ attempt: 1, causeRequestId: 'turn:round:1', hadVisibleText: false })
    expect(message.role).toBe('user')
    expect(message.source).toBe('runtime')
    expect(message.content).toContain('model_output_token_limit')
    expect(message.content).toContain('不要重新执行')
    expect(message.content).not.toContain('没有生成用户可见正文或工具调用')
  })

  it('工具截断时不会否认已经生成工具调用', () => {
    const message = buildOutputRecoveryMessage({ attempt: 1, causeRequestId: 'turn:round:1', hadVisibleText: false, hadToolUse: true })
    expect(message.content).toContain('已生成工具调用')
    expect(message.content).toContain('未执行')
    expect(message.content).not.toContain('没有生成用户可见正文或工具调用')
  })
})
