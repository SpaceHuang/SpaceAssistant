import { CHAT_CANCELLED_MESSAGE } from '../src/shared/chatCancel'
import {
  cancelAllPendingToolConfirms,
  cancelAllToolConfirmsForRequest,
  cancelAllToolsForRequest
} from './toolConfirmRegistry'
import { getDefaultAgentRuntime } from './runtime/agentRuntime'

export { CHAT_CANCELLED_MESSAGE }

/**
 * 聊天取消注册表(A2,偏差 18):状态随实例走,一个进程可多实例并存
 * (经 createAgentRuntime);旧全局函数为兼容转发。
 * 工具确认联动依赖可注入(测试);缺省走 toolConfirmRegistry 现有全局口。
 */
export class ChatCancelledError extends Error {
  constructor(message = CHAT_CANCELLED_MESSAGE) {
    super(message)
    this.name = 'ChatCancelledError'
  }
}

export interface ChatCancelRegistryDeps {
  cancelToolConfirmsForRequest?(requestId: string): void
  cancelToolsForRequest?(requestId: string): void
  cancelAllPendingToolConfirms?(): void
}

export class ChatCancelRegistry {
  private readonly chatCancelControllers = new Map<string, AbortController>()

  constructor(private readonly deps: ChatCancelRegistryDeps = {}) {}

  register(requestId: string): AbortSignal {
    const prev = this.chatCancelControllers.get(requestId)
    prev?.abort()
    const ac = new AbortController()
    this.chatCancelControllers.set(requestId, ac)
    return ac.signal
  }

  signalChatCancel(requestId: string): void {
    this.chatCancelControllers.get(requestId)?.abort()
    ;(this.deps.cancelToolConfirmsForRequest ?? cancelAllToolConfirmsForRequest)(requestId)
    ;(this.deps.cancelToolsForRequest ?? cancelAllToolsForRequest)(requestId)
  }

  clear(requestId: string): void {
    this.chatCancelControllers.delete(requestId)
  }

  throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new ChatCancelledError()
  }

  /** 应用退出时中止全部进行中的聊天/远程 Agent，释放 HTTP 与工具等待。 */
  cancelAllActiveChats(): void {
    for (const [requestId, ac] of this.chatCancelControllers) {
      ac.abort()
      ;(this.deps.cancelToolConfirmsForRequest ?? cancelAllToolConfirmsForRequest)(requestId)
      ;(this.deps.cancelToolsForRequest ?? cancelAllToolsForRequest)(requestId)
    }
    this.chatCancelControllers.clear()
    ;(this.deps.cancelAllPendingToolConfirms ?? cancelAllPendingToolConfirms)()
  }
}

/** @deprecated 兼容转发(偏差 18,一个发布周期,P8 评估删除):经默认 runtime 实例。 */
export function registerChatCancel(requestId: string): AbortSignal {
  return getDefaultAgentRuntime().chatCancels.register(requestId)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function signalChatCancel(requestId: string): void {
  getDefaultAgentRuntime().chatCancels.signalChatCancel(requestId)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function clearChatCancel(requestId: string): void {
  getDefaultAgentRuntime().chatCancels.clear(requestId)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function throwIfChatCancelled(signal: AbortSignal): void {
  getDefaultAgentRuntime().chatCancels.throwIfCancelled(signal)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function cancelAllActiveChats(): void {
  getDefaultAgentRuntime().chatCancels.cancelAllActiveChats()
}
