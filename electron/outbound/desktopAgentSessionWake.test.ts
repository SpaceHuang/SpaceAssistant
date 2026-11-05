import { describe, expect, it, vi } from 'vitest'
import { wakeQueuedAgentSessions } from './desktopAgentSessionWake'

describe('wakeQueuedAgentSessions', () => {
  it('仅唤醒队首事实被分类为 agent-session 的桌面会话', async () => {
    const drain = vi.fn(async () => undefined)
    wakeQueuedAgentSessions({
      sessionIds: () => ['agent-target', 'ordinary-target', 'empty-target'],
      getNextQueued: (sessionId) => sessionId === 'agent-target' ? { source: 'agent-session' }
        : sessionId === 'ordinary-target' ? { source: 'ordinary-desktop' } : null,
      drain
    })

    await Promise.resolve()

    expect(drain).toHaveBeenCalledOnce()
    expect(drain).toHaveBeenCalledWith('agent-target')
  })
})
