/**
 * runtime 纯组件核(A2/A3,偏差 18+19):confirmId 空间、聊天取消注册表、工具撤回注册表。
 * 无宿主依赖;宿主侧(electron)经组合注入联动实现。
 */

import { randomInt } from 'crypto'

/** Opaque capability returned for one active two-digit confirmation allocation. */
export interface ConfirmCodeLease {
  readonly code: string
  /** Identity token: release succeeds only while this exact token owns code. */
  readonly allocationToken: object
}

export interface ConfirmIdSpaceLike {
  allocate(): ConfirmCodeLease
  release(lease: ConfirmCodeLease): void
  isInUse(id: string): boolean
  clear(): void
}

export class ConfirmIdSpace implements ConfirmIdSpaceLike {
  private readonly leases = new Map<string, ConfirmCodeLease>()

  allocate(): ConfirmCodeLease {
    const start = randomInt(100)
    for (let offset = 0; offset < 100; offset++) {
      const code = String((start + offset) % 100).padStart(2, '0')
      if (!this.leases.has(code)) {
        const lease = Object.freeze({ code, allocationToken: Object.freeze({}) })
        this.leases.set(code, lease)
        return lease
      }
    }
    throw new Error('CONFIRM_ID_SPACE_EXHAUSTED')
  }

  release(lease: ConfirmCodeLease): void {
    if (!lease || typeof lease !== 'object' || typeof lease.code !== 'string') return
    const current = this.leases.get(lease.code)
    if (current?.allocationToken === lease.allocationToken) this.leases.delete(lease.code)
  }

  isInUse(id: string): boolean {
    return this.leases.has(id)
  }

  clear(): void {
    this.leases.clear()
  }
}

export const CHAT_CANCELLED_MESSAGE = 'CHAT_CANCELLED'

export class ChatCancelledError extends Error {
  constructor(message = CHAT_CANCELLED_MESSAGE) {
    super(message)
    this.name = 'ChatCancelledError'
  }
}

/** 取消联动(工具确认 / 工具撤销的中止广播):宿主注入;SDK 纯核缺省 no-op。 */
export interface ChatCancelLinks {
  cancelToolConfirmsForRequest?(requestId: string): void
  cancelToolsForRequest?(requestId: string): void
  cancelAllPendingToolConfirms?(): void
}

export interface ChatCancelRegistryLike {
  register(requestId: string): AbortSignal
  signalChatCancel(requestId: string): void
  clear(requestId: string): void
  throwIfCancelled(signal: AbortSignal): void
  cancelAllActiveChats(): void
}

export class ChatCancelRegistry implements ChatCancelRegistryLike {
  private readonly chatCancelControllers = new Map<string, AbortController>()

  constructor(private readonly links: ChatCancelLinks = {}) {}

  register(requestId: string): AbortSignal {
    const prev = this.chatCancelControllers.get(requestId)
    prev?.abort()
    const ac = new AbortController()
    this.chatCancelControllers.set(requestId, ac)
    return ac.signal
  }

  signalChatCancel(requestId: string): void {
    this.chatCancelControllers.get(requestId)?.abort()
    this.links.cancelToolConfirmsForRequest?.(requestId)
    this.links.cancelToolsForRequest?.(requestId)
  }

  clear(requestId: string): void {
    this.chatCancelControllers.delete(requestId)
  }

  throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new ChatCancelledError()
  }

  cancelAllActiveChats(): void {
    for (const [requestId, ac] of this.chatCancelControllers) {
      ac.abort()
      this.links.cancelToolConfirmsForRequest?.(requestId)
      this.links.cancelToolsForRequest?.(requestId)
    }
    this.chatCancelControllers.clear()
    this.links.cancelAllPendingToolConfirms?.()
  }
}

export const TOOL_REQUEST_LANES = ['desktop', 'feishu', 'wechat', 'automation'] as const

type RequestState = { requestId: string; lane: string; revoked: Set<string> }
export type ToolRevocationEvent = { requestId: string; executionId: string; lane: string; toolName: string }

export interface ToolRevocationRegistryLike {
  registerToolRevocationRequest(requestId: string, lane: string, executionId: string): void
  revokeToolForLane(lane: string, toolName: string): number
  revokeToolForAllLanes(toolName: string): number
  isToolRevoked(requestId: string, toolName: string, executionId?: string): boolean
  clearToolRevocationRequest(requestId: string, executionId?: string): void
  onRevocation(listener: (event: ToolRevocationEvent) => void): () => void
}

export class ToolRevocationRegistry implements ToolRevocationRegistryLike {
  private readonly active = new Map<string, RequestState>()
  private readonly listeners = new Set<(event: ToolRevocationEvent) => void>()

  onRevocation(listener: (event: ToolRevocationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  registerToolRevocationRequest(requestId: string, lane: string, executionId: string): void {
    if (!executionId.trim()) throw new Error('tool revocation executionId required')
    this.active.set(executionId, { requestId, lane, revoked: new Set() })
  }

  revokeToolForLane(lane: string, toolName: string): number {
    return this.revoke(toolName, lane)
  }

  revokeToolForAllLanes(toolName: string): number {
    return this.revoke(toolName)
  }

  private revoke(toolName: string, lane?: string): number {
    const events: ToolRevocationEvent[] = []
    const knownLanes: ReadonlySet<string> = new Set(TOOL_REQUEST_LANES)
    for (const [executionId, state] of this.active) {
      if (lane !== undefined ? state.lane !== lane : !knownLanes.has(state.lane)) continue
      state.revoked.add(toolName)
      events.push({ requestId: state.requestId, executionId, lane: state.lane, toolName })
    }

    const failures: unknown[] = []
    for (const event of events) {
      for (const listener of this.listeners) {
        try { listener(event) } catch (error) { failures.push(error) }
      }
    }
    if (failures.length) throw new AggregateError(failures, `tool revocation listeners failed for ${lane ?? 'all lanes'}:${toolName}`)
    return events.length
  }

  isToolRevoked(requestId: string, toolName: string, executionId?: string): boolean {
    if (executionId !== undefined) {
      const state = this.active.get(executionId)
      return state?.requestId === requestId && state.revoked.has(toolName)
    }
    return [...this.active.values()].some((state) => state.requestId === requestId && state.revoked.has(toolName))
  }

  clearToolRevocationRequest(requestId: string, executionId?: string): void {
    if (executionId !== undefined) {
      const state = this.active.get(executionId)
      if (state?.requestId === requestId) this.active.delete(executionId)
      return
    }
    const matches = [...this.active].filter(([, state]) => state.requestId === requestId)
    if (matches.length > 1) throw new Error('ambiguous tool revocation request')
    if (matches[0]) this.active.delete(matches[0][0])
  }
}
