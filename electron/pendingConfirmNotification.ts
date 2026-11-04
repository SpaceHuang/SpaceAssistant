import type { PendingConfirmEntry } from './floatingNotificationManager'

export type PendingConfirmNotificationApi = {
  new (options: { title: string; body: string }): {
    on(event: 'click' | 'close', listener: () => void): unknown
    show(): void
    close(): void
  }
  isSupported(): boolean
}

/** Create a reminder without tool arguments; activation/navigation is gated on a user click. */
export function createPendingConfirmNotification(input: {
  NotificationApi: PendingConfirmNotificationApi
  entry: PendingConfirmEntry
  title: string
  body: string
  onClick: (target: { sessionId: string; toolUseId: string }) => void
}) {
  try {
    if (!input.NotificationApi.isSupported()) return null
    const notification = new input.NotificationApi({
      title: input.title,
      body: input.body
    })
    notification.on('click', () => input.onClick({
      sessionId: input.entry.sessionId,
      toolUseId: input.entry.toolUseId
    }))
    notification.show()
    return notification
  } catch {
    return null
  }
}
