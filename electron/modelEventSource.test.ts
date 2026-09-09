import { describe, expect, it, vi } from 'vitest'
import { createEmittingModelEventSource, createModelEventSource } from './modelEventSource'

describe('createEmittingModelEventSource', () => {
  it('基础 adapter 也不会丢弃 runner 事件，并分配连续 eventSeq', async () => {
    const emit = vi.fn()
    const source = createModelEventSource(async ({ emit: emitEvent }) => {
      emitEvent({ type: 'thinking-delta', text: 'reasoning' })
      return { outcome: 'completed' as const }
    }, emit)
    await source({ turnId: 't0', requestId: 'r0', sessionId: 's1', assistantMessage: { id: 'a0', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming' }, version: 0, startToken: 'token' }, 'token')
    expect(emit).toHaveBeenCalledWith('t0', { type: 'thinking-delta', text: 'reasoning', eventSeq: 1 })
  })

  it('将 runner 的规范化事件转发给唯一事实消费者，并返回 usage/outcome', async () => {
    const emit = vi.fn()
    const source = createEmittingModelEventSource(async ({ emit: emitEvent }) => {
      emitEvent({ type: 'content-delta', text: 'hello' })
      emitEvent({ type: 'source-completed' })
      return { outcome: 'completed' as const, usage: { input: 3 } }
    }, emit)
    const result = await source({ turnId: 't1', requestId: 'r1', sessionId: 's1', assistantMessage: { id: 'a1', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming' }, version: 0, startToken: 'token' }, 'token')
    expect(emit).toHaveBeenNthCalledWith(1, 't1', { type: 'content-delta', text: 'hello', eventSeq: 1 })
    expect(emit).toHaveBeenNthCalledWith(2, 't1', { type: 'source-completed', eventSeq: 2 })
    expect(result).toEqual({ outcome: 'completed', usage: { input: 3 } })
  })

  it('tool-use 和递增 progress 事件保持结构化字段', async () => {
    const emit = vi.fn()
    const source = createEmittingModelEventSource(async ({ emit: emitEvent }) => {
      emitEvent({ type: 'tool-use', id: 'tool-1', toolName: 'run_shell', input: { command: 'pwd' } })
      emitEvent({ type: 'tool-progress', id: 'tool-1', seq: 2, text: 'done' })
      return { outcome: 'completed' as const }
    }, emit)
    await source({ turnId: 't2', requestId: 'r2', sessionId: 's1', assistantMessage: { id: 'a2', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming' }, version: 0, startToken: 'token' }, 'token')
    expect(emit).toHaveBeenNthCalledWith(1, 't2', expect.objectContaining({ type: 'tool-use', id: 'tool-1' }))
    expect(emit).toHaveBeenNthCalledWith(2, 't2', { type: 'tool-progress', id: 'tool-1', seq: 2, text: 'done', eventSeq: 2 })
  })

  it('tool-result 保留成功/错误结构', async () => {
    const emit = vi.fn()
    const source = createEmittingModelEventSource(async ({ emit: emitEvent }) => {
      emitEvent({ type: 'tool-result', id: 'tool-1', result: { success: false, error: 'denied' } })
      return { outcome: 'failed' as const, error: { code: 'tool-failed', message: 'denied' } }
    }, emit)
    await source({ turnId: 't3', requestId: 'r3', sessionId: 's1', assistantMessage: { id: 'a3', sessionId: 's1', role: 'assistant', content: '', timestamp: 1, status: 'streaming' }, version: 0, startToken: 'token' }, 'token')
    expect(emit).toHaveBeenCalledWith('t3', expect.objectContaining({ type: 'tool-result', id: 'tool-1', result: { success: false, error: 'denied' }, eventSeq: 1 }))
  })
})
