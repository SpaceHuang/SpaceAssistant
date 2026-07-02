export type WriteDirChoice = { dir: string; confirmedAt: number } | null

type Waiter = {
  resolve: (v: WriteDirChoice) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const CONFIRM_MS = 5 * 60 * 1000
const pending = new Map<string, Waiter>()

export function writeDirConfirmKey(requestId: string, sessionId: string): string {
  return `${requestId}\0${sessionId}`
}

export function waitForWriteDirConfirm(requestId: string, sessionId: string): Promise<WriteDirChoice> {
  const key = writeDirConfirmKey(requestId, sessionId)
  return new Promise<WriteDirChoice>((resolve) => {
    const timeoutId = setTimeout(() => {
      pending.delete(key)
      resolve(null)
    }, CONFIRM_MS)
    pending.set(key, { resolve, timeoutId })
  })
}

export function submitWriteDirConfirm(
  requestId: string,
  sessionId: string,
  choice: { dir: string } | null
): void {
  const key = writeDirConfirmKey(requestId, sessionId)
  const w = pending.get(key)
  if (!w) return
  clearTimeout(w.timeoutId)
  pending.delete(key)
  const outcome: WriteDirChoice = choice ? { dir: choice.dir, confirmedAt: Date.now() } : null
  setImmediate(() => w.resolve(outcome))
}

export function cancelAllWriteDirConfirmsForRequest(requestId: string): void {
  const prefix = `${requestId}\0`
  for (const [key, w] of pending) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(w.timeoutId)
    pending.delete(key)
    w.resolve(null)
  }
}

export function cancelAllPendingWriteDirConfirms(): void {
  for (const [, w] of pending) {
    clearTimeout(w.timeoutId)
    w.resolve(null)
  }
  pending.clear()
}
