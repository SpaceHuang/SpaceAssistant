import type { CacheKey, MemoryTier } from '../src/shared/confirmation/types'
import { canonicalKeyJson } from './confirmation/sqliteDecisionCache'

export type ToolConfirmOutcome = 'approved' | 'rejected' | 'timeout'

type Waiter = {
  resolve: (v: ToolConfirmOutcome) => void
  timeoutId: ReturnType<typeof setTimeout>
  /** 本次待确认请求决策层给出的记忆档位（规范化键集合）；无档位时不接受任何 memoryTier。 */
  memoryKeys?: Set<string>
}

const CONFIRM_MS = 5 * 60 * 1000

const pending = new Map<string, Waiter>()

export function confirmKey(requestId: string, toolUseId: string): string {
  return `${requestId}\0${toolUseId}`
}

export function waitForToolConfirm(
  requestId: string,
  toolUseId: string,
  memoryTiers?: MemoryTier[]
): Promise<ToolConfirmOutcome> {
  const key = confirmKey(requestId, toolUseId)
  return new Promise<ToolConfirmOutcome>((resolve) => {
    const timeoutId = setTimeout(() => {
      pending.delete(key)
      resolve('timeout')
    }, CONFIRM_MS)
    pending.set(key, {
      resolve,
      timeoutId,
      ...(memoryTiers?.length
        ? { memoryKeys: new Set(memoryTiers.map((t) => canonicalKeyJson(t.key))) }
        : {})
    })
  })
}

/**
 * 校验渲染端回传的 memoryTier 是否属于该待确认请求决策层给出的档位（B1）。
 * 无 pending 请求、请求未登记档位、或键不在档位内时一律 false（fail-closed）。
 */
export function isPendingMemoryTier(requestId: string, toolUseId: string, key: CacheKey): boolean {
  const w = pending.get(confirmKey(requestId, toolUseId))
  if (!w?.memoryKeys) return false
  return w.memoryKeys.has(canonicalKeyJson(key))
}

export function submitToolConfirmResponse(requestId: string, toolUseId: string, approved: boolean): void {
  const key = confirmKey(requestId, toolUseId)
  const w = pending.get(key)
  if (!w) return
  clearTimeout(w.timeoutId)
  pending.delete(key)
  const outcome: ToolConfirmOutcome = approved ? 'approved' : 'rejected'
  // 推迟到下一事件循环，避免在 IPC handler 返回前同步续跑 toolChatLoop（浏览器启动等重活）
  setImmediate(() => w.resolve(outcome))
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

export function cancelAllPendingToolConfirms(): void {
  for (const [key, w] of pending) {
    clearTimeout(w.timeoutId)
    pending.delete(key)
    w.resolve('rejected')
  }
  for (const [, ctrl] of cancelControllers) {
    ctrl.abort()
  }
  cancelControllers.clear()
}
