import type { WebContents } from 'electron'

export function isWebContentsAlive(sender: WebContents | null | undefined): sender is WebContents {
  return Boolean(sender && !sender.isDestroyed())
}

/** webContents 已销毁时静默跳过，避免 IPC handler 抛 Object has been destroyed */
export function safeWebContentsSend(
  sender: WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!isWebContentsAlive(sender)) return false
  try {
    sender.send(channel, ...args)
    return true
  } catch {
    return false
  }
}
