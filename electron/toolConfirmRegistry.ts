import type { CacheKey, MemoryTier } from '../src/shared/confirmation/types'
import { canonicalKeyJson } from './confirmation/sqliteDecisionCache'
import { tokenizeShellArgv } from './shell/shellCommandParser'
import { DEFAULT_USER_CONFIRMATION_TIMEOUT_MS } from './confirmation/confirmationTimeout'

export type ToolConfirmOutcome = 'approved' | 'rejected' | 'timeout' | 'cancelled' | 'unavailable'

type Waiter = {
  promise: Promise<ToolConfirmOutcome>
  resolve: (v: ToolConfirmOutcome) => void
  timeoutId: ReturnType<typeof setTimeout>
  /** 本次待确认请求决策层给出的记忆档位（规范化键集合）；无档位时不接受任何 memoryTier。 */
  memoryKeys?: Set<string>
  toolName?: string
  lane?: string
  memoryTiers?: readonly MemoryTier[]
  trustCommands?: Set<string>
  trustDomains?: Set<string>
  trustActDomains?: Set<string>
  trustMcpServerId?: string
  trustMcpToolName?: string
  sessionId?: string
  generation: number
  revision: number
  status?: 'pending' | 'committing' | 'cancelled'
  deadlineAt: number
}

export const CONFIRM_MS = DEFAULT_USER_CONFIRMATION_TIMEOUT_MS

const pending = new Map<string, Waiter>()
let nextConfirmationGeneration = 0

export function confirmKey(requestId: string, toolUseId: string): string {
  return `${requestId}\0${toolUseId}`
}

export function waitForToolConfirm(
  requestId: string,
  toolUseId: string,
  memoryTiers?: MemoryTier[],
  scope?: { toolName: string; lane: string; sessionId?: string; generation?: number; revision?: number; trustCommands?: string[]; trustDomains?: string[]; trustActDomains?: string[]; trustMcpServerId?: string; trustMcpToolName?: string },
  timeoutMs?: number
): Promise<ToolConfirmOutcome> {
  const key = confirmKey(requestId, toolUseId)
  const existing = pending.get(key)
  if (existing) return existing.promise
  let promise!: Promise<ToolConfirmOutcome>
  promise = new Promise<ToolConfirmOutcome>((resolve) => {
    // P1-4 超时可配：调用方显式 timeoutMs 优先；缺省 CONFIRM_MS=5min（user 回答者默认不变）
    const deadlineAt = Date.now() + (timeoutMs ?? CONFIRM_MS)
    const timeoutId = setTimeout(() => {
      if (pending.get(key)?.status === 'committing') {
        expireReservedToolConfirm(requestId, toolUseId)
        return
      }
      pending.delete(key)
      resolve('timeout')
    }, timeoutMs ?? CONFIRM_MS)
    pending.set(key, {
      promise,
      resolve,
      timeoutId,
      deadlineAt,
      generation: scope?.generation ?? ++nextConfirmationGeneration,
      revision: scope?.revision ?? 1,
      status: 'pending',
      ...(memoryTiers?.length
        ? { memoryKeys: new Set(memoryTiers.map((t) => canonicalKeyJson(t.key))) }
        : {}),
      ...(scope ? { toolName: scope.toolName, lane: scope.lane } : {}),
      ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(scope?.trustCommands ? { trustCommands: new Set(scope.trustCommands) } : {}),
      ...(scope?.trustDomains ? { trustDomains: new Set(scope.trustDomains) } : {}),
      ...(scope?.trustActDomains ? { trustActDomains: new Set(scope.trustActDomains) } : {}),
      ...(scope?.trustMcpServerId ? { trustMcpServerId: scope.trustMcpServerId } : {}),
      ...(scope?.trustMcpToolName ? { trustMcpToolName: scope.trustMcpToolName } : {}),
      ...(memoryTiers?.length ? { memoryTiers: memoryTiers.map((tier) => ({ ...tier })) } : {})
    })
  })
  const registered = pending.get(key)
  if (registered) registered.promise = promise
  return promise
}

/** 在发布桌面卡片前登记 waiter；后续 waitForToolConfirm 会复用同一 promise。 */
export function prepareToolConfirm(
  requestId: string,
  toolUseId: string,
  memoryTiers?: MemoryTier[],
  scope?: { toolName: string; lane: string; sessionId?: string; generation?: number; revision?: number; trustCommands?: string[]; trustDomains?: string[]; trustActDomains?: string[]; trustMcpServerId?: string; trustMcpToolName?: string },
  timeoutMs?: number
): Promise<ToolConfirmOutcome> {
  return waitForToolConfirm(requestId, toolUseId, memoryTiers, scope, timeoutMs)
}

export function isPendingTrust(requestId: string, toolUseId: string, kind: 'command' | 'domain' | 'act-domain' | 'mcp', value: string, secondaryValue?: string): boolean {
  const w = pending.get(confirmKey(requestId, toolUseId))
  if (!w) return false
  if (kind === 'command') { const argv = tokenizeShellArgv(value); return !!w.trustCommands && !!argv && w.trustCommands.has(JSON.stringify(argv)) }
  if (kind === 'domain') return !!w.trustDomains && w.trustDomains.has(value)
  if (kind === 'act-domain') return !!w.trustActDomains && w.trustActDomains.has(value)
  return w.trustMcpServerId === value && w.trustMcpToolName === secondaryValue
}

export function getPendingMcpTrust(requestId: string, toolUseId: string): { serverId: string; toolName: string } | undefined {
  const waiter = pending.get(confirmKey(requestId, toolUseId))
  if (!waiter?.trustMcpServerId || !waiter.trustMcpToolName) return undefined
  return { serverId: waiter.trustMcpServerId, toolName: waiter.trustMcpToolName }
}

export function rejectPendingConfirmsForTool(lane: string, toolName: string): number {
  let rejected = 0
  for (const [key, waiter] of pending) {
    if (waiter.lane !== lane || waiter.toolName !== toolName) continue
    if (waiter.status === 'committing') { const [requestId, toolUseId] = key.split('\0'); cancelReservedToolConfirm(requestId!, toolUseId!); rejected++; continue }
    clearTimeout(waiter.timeoutId)
    pending.delete(key)
    waiter.resolve('cancelled')
    rejected++
  }
  return rejected
}

export function rejectPendingConfirmsForToolAcrossLanes(toolName: string): number {
  return ['desktop', 'feishu', 'wechat'].reduce(
    (count, lane) => count + rejectPendingConfirmsForTool(lane, toolName),
    0
  )
}

/** 该 (requestId, toolUseId) 是否存在已登记的 pending 确认（H1：信任写入的前置校验）。 */
export function isPendingConfirm(requestId: string, toolUseId: string): boolean {
  const waiter = pending.get(confirmKey(requestId, toolUseId))
  return !!waiter && waiter.status !== 'cancelled'
}

export function getPendingConfirmToolName(requestId: string, toolUseId: string): string | undefined {
  return pending.get(confirmKey(requestId, toolUseId))?.toolName
}

export function getPendingConfirmSessionId(requestId: string, toolUseId: string): string | undefined {
  return pending.get(confirmKey(requestId, toolUseId))?.sessionId
}

export function getPendingConfirmGeneration(requestId: string, toolUseId: string): number | undefined {
  return pending.get(confirmKey(requestId, toolUseId))?.generation
}

export function getPendingConfirmRevision(requestId: string, toolUseId: string): number | undefined {
  return pending.get(confirmKey(requestId, toolUseId))?.revision
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

export function getPendingMemoryTiers(requestId: string, toolUseId: string): readonly MemoryTier[] {
  return pending.get(confirmKey(requestId, toolUseId))?.memoryTiers ?? []
}

export type ToolConfirmSubmitResult =
  | { accepted: true; outcome: 'approved' | 'rejected' }
  | { accepted: false; outcome: 'missing' }

export function submitToolConfirmResponse(requestId: string, toolUseId: string, approved: boolean): ToolConfirmSubmitResult {
  const key = confirmKey(requestId, toolUseId)
  const w = pending.get(key)
  if (!w || w.status === 'cancelled') return { accepted: false, outcome: 'missing' }
  clearTimeout(w.timeoutId)
  pending.delete(key)
  const outcome: ToolConfirmOutcome = approved ? 'approved' : 'rejected'
  // 推迟到下一事件循环，避免在 IPC handler 返回前同步续跑 toolChatLoop（浏览器启动等重活）
  setImmediate(() => w.resolve(outcome))
  return { accepted: true, outcome }
}

/** 独占确认项，写入期间超时/并发响应不得消费或撤销该项。 */
export function reserveToolConfirmResponse(requestId: string, toolUseId: string): boolean {
  const waiter = pending.get(confirmKey(requestId, toolUseId))
  if (!waiter || waiter.status === 'committing') return false
  waiter.status = 'committing'
  clearTimeout(waiter.timeoutId)
  const remaining = waiter.deadlineAt - Date.now()
  if (remaining <= 0) {
    waiter.status = 'cancelled'
    pending.delete(confirmKey(requestId, toolUseId))
    waiter.resolve('timeout')
    return false
  }
  waiter.timeoutId = setTimeout(() => expireReservedToolConfirm(requestId, toolUseId), remaining)
  return true
}

export function isToolConfirmCommitAllowed(requestId: string, toolUseId: string): boolean {
  const key = confirmKey(requestId, toolUseId)
  const waiter = pending.get(key)
  if (!waiter || waiter.status !== 'committing') return false
  if (Date.now() >= waiter.deadlineAt) {
    cancelReservedToolConfirm(requestId, toolUseId)
    return false
  }
  return true
}

export function cancelReservedToolConfirm(requestId: string, toolUseId: string): boolean {
  return settleReservedToolConfirm(requestId, toolUseId, 'cancelled')
}

/** 提交事务在 COMMIT 前回滚时恢复原确认项，允许用户重试同一授权。 */
export function restoreReservedToolConfirm(requestId: string, toolUseId: string): boolean {
  const key = confirmKey(requestId, toolUseId)
  const waiter = pending.get(key)
  if (!waiter || waiter.status !== 'committing' || Date.now() >= waiter.deadlineAt) return false
  // 同一确认项的第二次提交是新的 attempt revision；持久 receipt 不能把
  // 上一次已回滚的 action/memory 选择当成这一次提交的身份。
  waiter.revision += 1
  waiter.status = 'pending'
  clearTimeout(waiter.timeoutId)
  waiter.timeoutId = setTimeout(() => {
    pending.delete(key)
    waiter.resolve('timeout')
  }, waiter.deadlineAt - Date.now())
  return true
}

function expireReservedToolConfirm(requestId: string, toolUseId: string): boolean {
  return settleReservedToolConfirm(requestId, toolUseId, 'timeout')
}

function settleReservedToolConfirm(requestId: string, toolUseId: string, outcome: 'cancelled' | 'timeout' | 'unavailable'): boolean {
  const key = confirmKey(requestId, toolUseId)
  const waiter = pending.get(key)
  if (!waiter || waiter.status !== 'committing') return false
  clearTimeout(waiter.timeoutId)
  waiter.status = 'cancelled'
  pending.delete(key)
  waiter.resolve(outcome)
  return true
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
    if (w.status === 'committing') { const [requestId, toolUseId] = key.split('\0'); cancelReservedToolConfirm(requestId!, toolUseId!); continue }
    clearTimeout(w.timeoutId)
    pending.delete(key)
    w.resolve('cancelled')
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
    if (w.status === 'committing') { const [requestId, toolUseId] = key.split('\0'); cancelReservedToolConfirm(requestId!, toolUseId!); continue }
    clearTimeout(w.timeoutId)
    pending.delete(key)
    w.resolve('cancelled')
  }
  for (const [, ctrl] of cancelControllers) {
    ctrl.abort()
  }
  cancelControllers.clear()
}
