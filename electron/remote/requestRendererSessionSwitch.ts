import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'

const SWITCH_TIMEOUT_MS = 5000

type PendingSwitch = {
  resolve: (result: { desktopSwitched: boolean; viewChanged: boolean }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingByRequestId = new Map<string, PendingSwitch>()
const wcMutexChains = new Map<number, Promise<void>>()

function withWebContentsMutex<T>(wc: WebContents, fn: () => Promise<T>): Promise<T> {
  const wcId = wc.id
  const prev = wcMutexChains.get(wcId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  wcMutexChains.set(
    wcId,
    prev.then(() => gate)
  )
  return prev
    .then(() => fn())
    .finally(() => {
      release()
      if (wcMutexChains.get(wcId) === gate) {
        wcMutexChains.delete(wcId)
      }
    })
}

export function completeRendererSessionSwitch(payload: {
  requestId: string
  desktopSwitched: boolean
  viewChanged: boolean
}): void {
  const pending = pendingByRequestId.get(payload.requestId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingByRequestId.delete(payload.requestId)
  pending.resolve({
    desktopSwitched: payload.desktopSwitched,
    viewChanged: payload.viewChanged
  })
}

export function requestRendererSessionSwitch(
  wc: WebContents,
  sessionId: string
): Promise<{ desktopSwitched: boolean; viewChanged: boolean }> {
  return withWebContentsMutex(wc, () => {
    const requestId = randomUUID()
    return new Promise<{ desktopSwitched: boolean; viewChanged: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingByRequestId.delete(requestId)
        reject(new Error('桌面会话切换超时'))
      }, SWITCH_TIMEOUT_MS)

      pendingByRequestId.set(requestId, { resolve, reject, timer })

      wc.send('remote:switch-session-request', { requestId, sessionId })
    })
  })
}

export function resetRendererSessionSwitchForTests(): void {
  for (const pending of pendingByRequestId.values()) {
    clearTimeout(pending.timer)
    pending.resolve({ desktopSwitched: false, viewChanged: false })
  }
  pendingByRequestId.clear()
  wcMutexChains.clear()
}
