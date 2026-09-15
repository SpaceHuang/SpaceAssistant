import type { Message } from '../../shared/domainTypes'
import type { TurnFailureReasons } from './turnFailureDisplay'

/** 只挑「已失败」的 assistant 消息：其它状态永远不该有失败原因。 */
export function collectFailureLookupIds(messages: readonly Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || message.status !== 'failed') continue
    if (!message.id || ids.includes(message.id)) continue
    ids.push(message.id)
  }
  return ids
}

/**
 * 重开页面 / 切换会话时，用显示中的失败消息 id 回查主进程终态错误。
 * 失败原因属于诊断增强：通道缺失、查询失败或没有记录都必须静默降级成通用提示，
 * 绝不能反过来影响消息加载本身。
 */
export async function loadTurnFailureReasons(messages: readonly Message[]): Promise<TurnFailureReasons> {
  const ids = collectFailureLookupIds(messages)
  if (ids.length === 0) return {}
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (typeof api?.chatGetTurnErrors !== 'function') return {}
  try {
    const errors = await api.chatGetTurnErrors({ assistantMessageIds: ids })
    const requested = new Set(ids)
    const reasons: TurnFailureReasons = {}
    for (const entry of errors ?? []) {
      const messageId = entry?.assistantMessageId
      const reason = entry?.message?.trim()
      if (!messageId || !reason || !requested.has(messageId)) continue
      reasons[messageId] = reason
    }
    return reasons
  } catch {
    return {}
  }
}
