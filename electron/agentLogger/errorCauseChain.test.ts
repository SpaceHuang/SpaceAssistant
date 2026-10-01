import { describe, expect, it } from 'vitest'
import { serializeErrorCauseChain } from './errorCauseChain'
import { HostedTurnFinalizedError } from '../runtime/hostedTurnFinalization'
import { ToolExecutionAfterDispatchError } from '../../packages/agent-sdk/src/toolExecutionPort'

describe('serializeErrorCauseChain', () => {
  it('还原 2026-10 会话 38 事故形态的三层包装链，最内层带 code 与抛出栈', () => {
    const root = Object.assign(new Error('file closed'), { code: 'EBADF' })
    const chain = serializeErrorCauseChain(
      new HostedTurnFinalizedError(new ToolExecutionAfterDispatchError(root), 'interrupted')
    )
    expect(chain).toHaveLength(3)
    expect(chain![0]).toMatchObject({ name: 'HostedTurnFinalizedError', message: 'tool execution failed after dispatch: file closed' })
    expect(chain![1]).toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(chain![2]).toMatchObject({ code: 'EBADF', message: 'file closed' })
    expect(chain![2].stack).toContain('Error: file closed')
  })

  it('无 cause 的普通错误返回单元素链', () => {
    const chain = serializeErrorCauseChain(new Error('plain'))
    expect(chain).toHaveLength(1)
    expect(chain![0]).toMatchObject({ name: 'Error', message: 'plain' })
  })

  it('非 Error 值与 null cause 正常终止', () => {
    expect(serializeErrorCauseChain('plain string')).toEqual([{ message: 'plain string' }])
    const err = new Error('wrapped')
    ;(err as Error & { cause?: unknown }).cause = null
    expect(serializeErrorCauseChain(err)).toHaveLength(1)
  })

  it('循环引用终止且不超过深度上限', () => {
    const a = new Error('a')
    const b = new Error('b')
    ;(a as Error & { cause?: unknown }).cause = b
    ;(b as Error & { cause?: unknown }).cause = a
    const chain = serializeErrorCauseChain(a)
    expect(chain).toHaveLength(2)

    const deep = new Error('leaf')
    let current: Error = deep
    for (let i = 0; i < 10; i++) {
      const wrapper = new Error(`wrap-${i}`)
      ;(wrapper as Error & { cause?: unknown }).cause = current
      current = wrapper
    }
    expect(serializeErrorCauseChain(current)).toHaveLength(5)
  })

  it('空输入返回 undefined', () => {
    expect(serializeErrorCauseChain(undefined)).toBeUndefined()
    expect(serializeErrorCauseChain(null)).toBeUndefined()
  })
})
