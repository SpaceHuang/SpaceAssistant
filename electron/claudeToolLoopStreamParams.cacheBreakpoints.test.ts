import { describe, expect, it } from 'vitest'
import { buildClaudeToolLoopStreamParams, computeCacheBreakpointPositions } from './claudeToolLoopStreamParams'

/**
 * P0-1 wire 面断点观测（agent-context-token-cost-optimization-plan §5.2.3-2 / §7.1 场景 8–10）。
 * 断点位置推导必须与 buildClaudeToolLoopStreamParams 的注入规则同源（同文件），避免漂移。
 */

const SYSTEM = 'you are an assistant'

describe('computeCacheBreakpointPositions（§7.1 wire 面 8–10）', () => {
  it('场景 8：round:1（末条为字符串用户消息）→ positions = [system, msg:<末条>]，断点随尾', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' }
    ]
    const positions = computeCacheBreakpointPositions({ messages, hasSystem: true, cacheControl: true })
    expect(positions).toEqual(['system', 'msg:2'])
    // 与 serializer 实际注入同源验证：末条字符串消息被替换为带 cache_control 的 text 块
    const params = buildClaudeToolLoopStreamParams({ model: 'm', max_tokens: 1, system: SYSTEM, messages: messages as unknown[], tools: [], thinking: { type: 'disabled' }, cacheControl: true })
    const last = (params.messages as Array<{ content: unknown }>)[2]
    expect(Array.isArray(last.content)).toBe(true)
    expect((last.content as Array<Record<string, unknown>>)[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  it('场景 9：round:2+（末条为 tool_result 数组）→ tailIsString=false，count===1（断点②消失）', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] }
    ]
    const positions = computeCacheBreakpointPositions({ messages, hasSystem: true, cacheControl: true })
    expect(positions).toEqual(['system'])
    const params = buildClaudeToolLoopStreamParams({ model: 'm', max_tokens: 1, system: SYSTEM, messages: messages as unknown[], tools: [], thinking: { type: 'disabled' }, cacheControl: true })
    const serializedLast = (params.messages as Array<{ content: unknown }>)[2]
    expect(Array.isArray(serializedLast.content)).toBe(true)
  })

  it('场景 10：moved 由 prevPositions 与 positions 的差异决定；无 system 时仅消息断点', () => {
    const messages1 = [{ role: 'user', content: 'q1' }]
    const messages2 = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }, { role: 'user', content: 'q2' }]
    const p1 = computeCacheBreakpointPositions({ messages: messages1, hasSystem: true, cacheControl: true })
    const p2 = computeCacheBreakpointPositions({ messages: messages2, hasSystem: true, cacheControl: true })
    expect(p1).toEqual(['system', 'msg:0'])
    expect(p2).toEqual(['system', 'msg:2'])
    expect(JSON.stringify(p1) !== JSON.stringify(p2)).toBe(true)
    // cacheControl 关闭时仅 system 断点消失，消息级断点仍随尾注入（口径与注入实现一致）
    expect(computeCacheBreakpointPositions({ messages: messages2, hasSystem: true, cacheControl: false })).toEqual(['msg:2'])
  })
})
