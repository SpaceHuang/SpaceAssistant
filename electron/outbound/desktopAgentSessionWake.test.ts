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
      reason: 'capacity-released',
      drain
    })

    await Promise.resolve()

    expect(drain).toHaveBeenCalledOnce()
    expect(drain).toHaveBeenCalledWith('agent-target', 'capacity-released')
    expect(recoverTarget).toHaveBeenCalledWith('agent-target')
    expect(recoverTarget.mock.invocationCallOrder[0]).toBeLessThan(drain.mock.invocationCallOrder[0]!)
  })

  it('目标恢复被阻断时不进入排水执行', () => {
    const drain = vi.fn()
    wakeQueuedAgentSessions({ sessionIds: () => ['agent-target'], getNextQueued: () => ({ source: 'agent-session' }),
      recoverTarget: () => ({ status: 'blocked' }), reason: 'startup-recovery', drain })
    expect(drain).not.toHaveBeenCalled()
  })

  it('无效物理队首交给排水器审计，不绕过它唤醒后续 Agent 来信', () => {
    const drain = vi.fn()
    const recoverTarget = vi.fn(() => ({ status: 'ready' as const }))
    wakeQueuedAgentSessions({ sessionIds: () => ['blocked-target'], getNextQueued: () => ({ source: 'invalid' }),
      recoverTarget, reason: 'startup-recovery', drain })
    expect(drain).toHaveBeenCalledWith('blocked-target', 'startup-recovery')
    expect(recoverTarget).not.toHaveBeenCalled()
  })
})
