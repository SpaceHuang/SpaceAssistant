import { describe, expect, it, beforeEach } from 'vitest'
import {
  RemoteTaskController,
  RemoteTaskCancelledError,
  buildScriptExecutionSummary,
  formatScriptAllowHint,
  formatScriptDenyUserMessage,
  __resetRemoteTaskControllerForTests,
  getRemoteTaskController
} from './remoteTaskController'

describe('remoteTaskController', () => {
  beforeEach(() => {
    __resetRemoteTaskControllerForTests()
  })

  it('allows one concurrent execution per task; second waits then grants after release', async () => {
    const c = getRemoteTaskController()
    c.ensureTask('t1', { maxConcurrent: 1 })
    const first = await c.acquireExecutionSlot('t1', 'e1', 'script')
    expect(c.runningCount('t1')).toBe(1)

    let secondGranted = false
    const secondPromise = c.acquireExecutionSlot('t1', 'e2', 'script').then((h) => {
      secondGranted = true
      return h
    })
    await Promise.resolve()
    expect(secondGranted).toBe(false)
    expect(c.queuedCount('t1')).toBe(1)

    first.release()
    const second = await secondPromise
    expect(secondGranted).toBe(true)
    expect(c.runningCount('t1')).toBe(1)
    second.release()
  })

  it('stop kills running, cancels queue, and rejects later acquires', async () => {
    const c = getRemoteTaskController()
    c.ensureTask('t1')
    let killed = false
    const handle = await c.acquireExecutionSlot('t1', 'e1', 'shell')
    handle.setKill(() => {
      killed = true
    })

    const queued = c.acquireExecutionSlot('t1', 'e2', 'shell')
    c.stopTask('t1', 'user-desktop')
    expect(killed).toBe(true)
    await expect(queued).rejects.toBeInstanceOf(RemoteTaskCancelledError)
    await expect(c.acquireExecutionSlot('t1', 'e3', 'script')).rejects.toBeInstanceOf(
      RemoteTaskCancelledError
    )
  })

  it('emergencyClose stops matching session tasks before listener teardown', () => {
    const c = new RemoteTaskController()
    c.ensureTask('a', { sessionId: 's1' })
    c.ensureTask('b', { sessionId: 's2' })
    const n = c.emergencyClose({ sessionId: 's1' })
    expect(n).toBe(1)
    expect(c.isCancelled('a')).toBe(true)
    expect(c.isCancelled('b')).toBe(false)
  })

  it('deny copy hides A/B codes and points to desktop', () => {
    const msg = formatScriptDenyUserMessage('pattern B3 matched')
    expect(msg).not.toMatch(/\bA\d+\b/)
    expect(msg).not.toMatch(/\bB\d+\b/)
    expect(msg).toContain('回桌面')
  })

  it('allow hint uses soft wording', () => {
    expect(formatScriptAllowHint()).toBe('未发现已知高风险模式')
  })

  it('builds execution summary', () => {
    const s = buildScriptExecutionSummary({
      durationMs: 2500,
      exitCode: 0,
      truncated: true,
      workspaceMayHaveChanged: true
    })
    expect(s.userMessage).toContain('已完成')
    expect(s.userMessage).toContain('截断')
  })
})
