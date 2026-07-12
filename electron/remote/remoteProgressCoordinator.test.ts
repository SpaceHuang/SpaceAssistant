import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  runHeartbeat,
  sendInstantRemoteProgressReply,
  startRemoteProgressSession,
  stopRemoteProgressSession,
  clearAllRemoteProgressCoordinatorSessions
} from './remoteProgressCoordinator'
import { clearAllRemoteProgressSessions, updateRemoteProgressSnapshot } from './remoteProgressStore'
import type { RemoteProgressAdapter } from './remoteProgressCoordinator'

function makeAdapter(): RemoteProgressAdapter & { typingCalls: number; replies: string[] } {
  let typingCalls = 0
  const replies: string[] = []
  return {
    channel: 'wechat',
    get typingCalls() {
      return typingCalls
    },
    replies,
    sendTyping: () => {
      typingCalls += 1
    },
    reply: (text: string) => {
      replies.push(text)
    },
    logProgress: vi.fn()
  }
}

describe('remoteProgressCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearAllRemoteProgressSessions()
    clearAllRemoteProgressCoordinatorSessions()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearAllRemoteProgressCoordinatorSessions()
    clearAllRemoteProgressSessions()
  })

  it('typing tick does not send progress reply', async () => {
    const adapter = makeAdapter()
    startRemoteProgressSession('s1', adapter, {
      remoteTypingEnabled: true,
      remoteProgressHeartbeatSec: 0,
      remoteProgressMode: 'activity_snapshot'
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(adapter.replies).toHaveLength(0)
    expect(adapter.typingCalls).toBeGreaterThan(0)
    stopRemoteProgressSession('s1')
  })

  it('heartbeat sends activity snapshot text', async () => {
    const adapter = makeAdapter()
    updateRemoteProgressSnapshot('s1', {
      kind: 'tool',
      label: '读取 config.json',
      detail: '准备中…',
      publishable: true
    })

    startRemoteProgressSession('s1', adapter, {
      remoteTypingEnabled: false,
      remoteProgressHeartbeatSec: 60,
      remoteProgressMinIntervalSec: 0,
      remoteProgressMode: 'activity_snapshot'
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(adapter.replies[0]).toContain('config.json')
    stopRemoteProgressSession('s1')
  })

  it('dedupes identical heartbeat replies', async () => {
    const adapter = makeAdapter()
    updateRemoteProgressSnapshot('s1', {
      kind: 'tool',
      label: 'grep src',
      publishable: true
    })

    startRemoteProgressSession('s1', adapter, {
      remoteTypingEnabled: false,
      remoteProgressHeartbeatSec: 60,
      remoteProgressMinIntervalSec: 0,
      remoteProgressMode: 'activity_snapshot'
    })

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(adapter.replies).toHaveLength(1)
    stopRemoteProgressSession('s1')
  })

  it('dedupes when second reply only differs by session suffix', async () => {
    const adapter = makeAdapter()
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    startRemoteProgressSession('s1', adapter, {
      remoteTypingEnabled: false,
      remoteProgressHeartbeatSec: 0,
      remoteProgressMinIntervalSec: 0,
      remoteProgressMode: 'activity_snapshot'
    })

    await sendInstantRemoteProgressReply('s1', '【进度】grep src')
    await sendInstantRemoteProgressReply('s1', `【进度】grep src 会话$${sessionId}$`)
    expect(adapter.replies).toHaveLength(1)
    stopRemoteProgressSession('s1')
  })

  it('legacy_heartbeat sends fallback only', async () => {
    const adapter = makeAdapter()
    startRemoteProgressSession('s1', adapter, {
      remoteTypingEnabled: false,
      remoteProgressHeartbeatSec: 60,
      remoteProgressMinIntervalSec: 0,
      remoteProgressMode: 'legacy_heartbeat',
      remoteProgressFallbackText: '仍在处理…'
    })

    updateRemoteProgressSnapshot('s1', {
      kind: 'tool',
      label: 'should not appear',
      publishable: true
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(adapter.replies[0]).toBe('仍在处理…')
    stopRemoteProgressSession('s1')
  })

  it('instant reply bypasses min interval', async () => {
    const adapter = makeAdapter()
    startRemoteProgressSession('s1', adapter, {
      remoteProgressMode: 'activity_snapshot',
      remoteProgressHeartbeatSec: 0,
      remoteProgressMinIntervalSec: 60
    })

    await sendInstantRemoteProgressReply('s1', '【进度】等待确认：写入文件')
    expect(adapter.replies).toHaveLength(1)
    stopRemoteProgressSession('s1')
  })
})
