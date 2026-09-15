import type { Message } from '../../shared/domainTypes'

/** 会话内最近一次失败的 assistant 消息与真实原因（主进程 turn 终态错误） */
export type TurnFailureEntry = { messageId: string; reason: string }

/**
 * 失败气泡要展示的「真实原因」只属于产生它的那条 assistant 消息：
 * 同一个会话再次失败会覆盖记录，所以必须同时比对 messageId，避免旧原因串到新气泡。
 */
export function resolveFailureReasonForMessage(
  turnFailures: Record<string, TurnFailureEntry>,
  message: Message
): string | undefined {
  if (message.status !== 'failed') return undefined
  const entry = turnFailures[message.sessionId]
  if (!entry || entry.messageId !== message.id) return undefined
  return entry.reason
}
