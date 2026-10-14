import { describe, expect, it, vi } from 'vitest'
import {
  cancelActiveAgentTool,
  cancelAllActiveAgentToolsForTurn,
  registerActiveAgentToolCancellation
} from './activeAgentToolCancellation'

/** 模块级注册表无重置口；用随机前缀隔离用例间的 key 空间。 */
let seq = 0
const uniqueId = (label: string) => `${label}-${Date.now().toString(36)}-${seq++}-${Math.random().toString(36).slice(2, 8)}`

describe('cancelAllActiveAgentToolsForTurn', () => {
  it('cancels only the tools of the requested turn, returns the cancelled count, and leaves other turns registered', () => {
    const sessionId = uniqueId('session')
    const turnA = uniqueId('turn')
    const turnB = `${turnA}-sibling`
    const cancelA1 = vi.fn()
    const cancelA2 = vi.fn()
    const cancelB1 = vi.fn()
    registerActiveAgentToolCancellation(sessionId, turnA, `${turnA}-tool-1`, cancelA1)
    registerActiveAgentToolCancellation(sessionId, turnA, `${turnA}-tool-2`, cancelA2)
    const unregisterB = registerActiveAgentToolCancellation(sessionId, turnB, `${turnB}-tool-1`, cancelB1)

    const count = cancelAllActiveAgentToolsForTurn(sessionId, turnA)

    expect(count).toBe(2)
    expect(cancelA1).toHaveBeenCalledTimes(1)
    expect(cancelA2).toHaveBeenCalledTimes(1)
    expect(cancelB1).not.toHaveBeenCalled()
    // 兄弟 turn 的登记不被误伤（前缀含完整 turnId，`turnA` 不得匹配 `turnA-sibling`）
    expect(cancelActiveAgentTool(sessionId, turnB, `${turnB}-tool-1`)).toBe(true)
    unregisterB()
  })

  it('returns 0 without throwing when the turn has no active tool cancellations', () => {
    const count = cancelAllActiveAgentToolsForTurn(uniqueId('session-empty'), uniqueId('turn-empty'))
    expect(count).toBe(0)
  })

  it('still hits tools when the registration side degraded to requestId as the turn key (imRemote shape)', () => {
    // B2/三轮复核确认 A：唯一现实降级源是 imRemoteAgent（turnId/acceptedTurn 均可选），
    // invocationAssembler 落到 `runtimeTurnId = acceptedTurnId ?? requestId`；
    // 批量取消与 toolChatLoop 同用 `executionId = args.turnId ?? args.requestId`，两侧同源即必须命中。
    const sessionId = uniqueId('session')
    const requestId = uniqueId('request')
    const cancelDegraded = vi.fn()
    registerActiveAgentToolCancellation(sessionId, requestId, `${requestId}-tool`, cancelDegraded)

    const count = cancelAllActiveAgentToolsForTurn(sessionId, requestId)

    expect(count).toBe(1)
    expect(cancelDegraded).toHaveBeenCalledTimes(1)
  })
})
