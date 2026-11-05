import { describe, expect, it, vi } from 'vitest'
import { wakeQueuedAgentSessions } from './desktopAgentSessionWake'

describe('wakeQueuedAgentSessions', () => {
  it('仅唤醒队首事实被分类为 agent-session 的桌面会话', async () => {
    const drain = vi.fn(async () => undefined)
    const recoverTarget = vi.fn(() => ({ status: 'ready' as const }))
    wakeQueuedAgentSessions({
      sessionIds: () => ['agent-target', 'ordinary-target', 'empty-target'],
      getNextQueued: (sessionId) => sessionId === 'agent-target' ? { source: 'agent-session' }
        : sessionId === 'ordinary-target' ? { source: 'ordinary-desktop' } : null,
      recoverTarget,
      drain
    })

    await Promise.resolve()

    expect(drain).toHaveBeenCalledOnce()
    expect(drain).toHaveBeenCalledWith('agent-target')
    expect(recoverTarget).toHaveBeenCalledWith('agent-target')
    expect(recoverTarget.mock.invocationCallOrder[0]).toBeLessThan(drain.mock.invocationCallOrder[0]!)
  })

  it('目标恢复被阻断时不进入排水执行', () => {
    const drain = vi.fn()
    wakeQueuedAgentSessions({ sessionIds: () => ['agent-target'], getNextQueued: () => ({ source: 'agent-session' }),
      recoverTarget: () => ({ status: 'blocked' }), drain })
    expect(drain).not.toHaveBeenCalled()
  })
})
