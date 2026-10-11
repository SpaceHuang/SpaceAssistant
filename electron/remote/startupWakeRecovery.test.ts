import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { appendWakeEvent } from '../database/wakeEvents'
import { scheduleStartupWakeRecovery } from './startupWakeRecovery'

describe('startup wake recovery', () => {
  it('waits for pending sessions owned by the channel to finish recovery after restart', async () => {
    const db = createMemoryAppDb()
    const feishuSession = createSession(db, { name: 'startup-feishu', metadata: { source: 'feishu' } }).id
    const wechatSession = createSession(db, { name: 'startup-wechat', metadata: { source: 'wechat' } }).id
    appendWakeEvent(db, { sessionId: feishuSession, type: 'continuation', reasonKey: 'feishu-restart',
      payloadRef: { kind: 'continuation', continuationId: 'feishu-restart' } })
    appendWakeEvent(db, { sessionId: wechatSession, type: 'continuation', reasonKey: 'wechat-restart',
      payloadRef: { kind: 'continuation', continuationId: 'wechat-restart' } })
    const dispatchSession = vi.fn().mockResolvedValue(undefined)

    let finishDispatch!: () => void
    dispatchSession.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDispatch = resolve }))

    let settled = false
    const recovery = scheduleStartupWakeRecovery(db, 'feishu', { dispatchSession }, () => 123).then((value) => {
      settled = true
      return value
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(dispatchSession).toHaveBeenCalledExactlyOnceWith(feishuSession, { retryExhausted: true })
    finishDispatch()
    await expect(recovery).resolves.toEqual([feishuSession])
    db.close()
  })

  it('isolates dispatch failures so another startup session is still scheduled', async () => {
    const db = createMemoryAppDb()
    const first = createSession(db, { name: 'startup-fail', metadata: { source: 'feishu' } }).id
    const second = createSession(db, { name: 'startup-continue', metadata: { source: 'feishu' } }).id
    for (const [index, sessionId] of [first, second].entries()) {
      appendWakeEvent(db, { sessionId, type: 'continuation', reasonKey: `feishu-restart-${index}`,
        payloadRef: { kind: 'continuation', continuationId: `feishu-restart-${index}` } })
    }
    const dispatchSession = vi.fn().mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce(undefined)
    const onError = vi.fn()

    const recovery = scheduleStartupWakeRecovery(db, 'feishu', { dispatchSession }, () => 123, onError)
    expect(dispatchSession).toHaveBeenCalledTimes(2)
    const failedSessionId = dispatchSession.mock.calls[0]?.[0]
    expect([first, second]).toContain(failedSessionId)
    await expect(recovery).resolves.toEqual(expect.arrayContaining([first, second]))
    expect(onError).toHaveBeenCalledWith(failedSessionId, expect.objectContaining({ message: 'first failed' }))
    db.close()
  })
})
