import { describe, expect, it, vi } from 'vitest'
import { createPendingConfirmNotification } from './pendingConfirmNotification'

describe('pending confirm system notification', () => {
  it('does not expose tool parameters and navigates only after an explicit click', () => {
    const notification = { on: vi.fn(), show: vi.fn(), close: vi.fn() }
    const NotificationApi = Object.assign(vi.fn(function (this: unknown) { return notification }), { isSupported: vi.fn(() => true) })
    const navigate = vi.fn()
    const created = createPendingConfirmNotification({
      NotificationApi: NotificationApi as never,
      entry: { sessionId: 'session-1', sessionName: '会话一', toolUseId: 'tool-1', toolName: 'run_shell', input: { command: 'secret' }, requestId: 'request-1', createdAt: 1 },
      onClick: navigate
    })

    expect(NotificationApi).toHaveBeenCalledWith({ title: expect.any(String), body: expect.any(String) })
    expect(JSON.stringify(NotificationApi.mock.calls[0])).not.toContain('secret')
    expect(created).toBe(notification)
    expect(notification.show).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    notification.on.mock.calls[0][1]()
    expect(navigate).toHaveBeenCalledWith({ sessionId: 'session-1', toolUseId: 'tool-1' })
  })

  it('returns null without showing when system notifications are unsupported', () => {
    const NotificationApi = Object.assign(vi.fn(), { isSupported: vi.fn(() => false) })
    expect(createPendingConfirmNotification({ NotificationApi: NotificationApi as never, entry: {
      sessionId: 's', sessionName: '会话', toolUseId: 't', toolName: 'tool', input: {}, requestId: 'r', createdAt: 1
    }, onClick: vi.fn() })).toBeNull()
    expect(NotificationApi).not.toHaveBeenCalled()
  })
})
