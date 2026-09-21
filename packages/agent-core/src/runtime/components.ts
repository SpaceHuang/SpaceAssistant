/**
 * runtime 纯组件核(A2/A3,偏差 18+19):confirmId 空间、聊天取消注册表、工具撤回注册表。
 * 无宿主依赖;宿主侧(electron)经组合注入联动实现。
 */

/** Crockford Base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface ConfirmIdSpaceLike {
  allocate(maxAttempts?: number): string
  release(id: string): void
  isInUse(id: string): boolean
  clear(): void
}

export class ConfirmIdSpace implements ConfirmIdSpaceLike {
  private readonly ids = new Set<string>()

  allocate(maxAttempts = 32): string {
    for (let i = 0; i < maxAttempts; i++) {
      const buf = randomBytes(3)
      let id = ''
      // 4 chars from 20 bits
      let n = ((buf[0]! << 16) | (buf[1]! << 8) | buf[2]!) >>> 0
      for (let c = 0; c < 4; c++) {
        id = CROCKFORD[n & 31]! + id
        n >>>= 5
      }
      const upper = id.toUpperCase()
      if (!this.ids.has(upper)) {
        this.ids.add(upper)
        return upper
      }
    }
    throw new Error('confirmId collision exhausted')
  }

  release(id: string): void {
    this.ids.delete(id.toUpperCase())
  }

  isInUse(id: string): boolean {
    return this.ids.has(id.toUpperCase())
  }

  clear(): void {
    this.ids.clear()
  }
}

import { randomBytes } from 'crypto'

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

export const TOOL_REQUEST_LANES = ['desktop', 'feishu', 'wechat'] as const

type RequestState = { lane: string; revoked: Set<string> }

export interface ToolRevocationRegistryLike {
  registerToolRevocationRequest(requestId: string, lane: string): void
  revokeToolForLane(lane: string, toolName: string): number
  revokeToolForAllLanes(toolName: string): number
  isToolRevoked(requestId: string, toolName: string): boolean
  clearToolRevocationRequest(requestId: string): void
}

export class ToolRevocationRegistry implements ToolRevocationRegistryLike {
  private readonly active = new Map<string, RequestState>()

  registerToolRevocationRequest(requestId: string, lane: string): void {
    this.active.set(requestId, { lane, revoked: new Set() })
  }

  revokeToolForLane(lane: string, toolName: string): number {
    let count = 0
    for (const state of this.active.values()) {
      if (state.lane !== lane) continue
      state.revoked.add(toolName)
      count++
    }
    return count
  }

  revokeToolForAllLanes(toolName: string): number {
    let count = 0
    for (const lane of TOOL_REQUEST_LANES) count += this.revokeToolForLane(lane, toolName)
    return count
  }

  isToolRevoked(requestId: string, toolName: string): boolean {
    return this.active.get(requestId)?.revoked.has(toolName) ?? false
  }

  clearToolRevocationRequest(requestId: string): void {
    this.active.delete(requestId)
  }
}
