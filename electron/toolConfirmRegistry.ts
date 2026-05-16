export type ToolConfirmOutcome = 'approved' | 'rejected' | 'timeout'

type Waiter = {
  resolve: (v: ToolConfirmOutcome) => void
  timeoutId: ReturnType<typeof setTimeout>
}

const CONFIRM_MS = 5 * 60 * 1000

const pending = new Map<string, Waiter>()

export function confirmKey(requestId: string, toolUseId: string): string {
  return `${requestId}\0${toolUseId}`
}

export function waitForToolConfirm(requestId: string, toolUseId: string): Promise<ToolConfirmOutcome> {
  const key = confirmKey(requestId, toolUseId)
  return new Promise<ToolConfirmOutcome>((resolve) => {
    const timeoutId = setTimeout(() => {
      pending.delete(key)
      resolve('timeout')
    }, CONFIRM_MS)
    pending.set(key, { resolve, timeoutId })
  })
}

export function submitToolConfirmResponse(requestId: string, toolUseId: string, approved: boolean): void {
  const key = confirmKey(requestId, toolUseId)
  const w = pending.get(key)
  if (!w) return
  clearTimeout(w.timeoutId)
  pending.delete(key)
  w.resolve(approved ? 'approved' : 'rejected')
}

const cancelControllers = new Map<string, AbortController>()

export function registerToolCancel(requestId: string, toolUseId: string): AbortSignal {
  const key = confirmKey(requestId, toolUseId)
  const prev = cancelControllers.get(key)
  prev?.abort()
  const ac = new AbortController()
  cancelControllers.set(key, ac)
  return ac.signal
}

export function signalToolCancel(requestId: string, toolUseId: string): void {
  const key = confirmKey(requestId, toolUseId)
  cancelControllers.get(key)?.abort()
}

export function clearToolCancel(requestId: string, toolUseId: string): void {
  const key = confirmKey(requestId, toolUseId)
  cancelControllers.delete(key)
}

export function cancelAllToolConfirmsForRequest(requestId: string): void {
  const prefix = `${requestId}\0`
  for (const [key, w] of pending) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(w.timeoutId)
    pending.delete(key)
    w.resolve('rejected')
  }
}

export function cancelAllToolsForRequest(requestId: string): void {
  const prefix = `${requestId}\0`
  for (const [key, ctrl] of cancelControllers) {
    if (key.startsWith(prefix)) ctrl.abort()
  }
}
