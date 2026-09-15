import type { Message } from '../../shared/domainTypes'

/** assistantMessageId → 主进程 turn 终态错误文本；id 全局唯一，天然不会跨气泡串原因 */
export type TurnFailureReasons = Record<string, string>

/**
 * 失败气泡要展示的「真实原因」只属于产生它的那条 assistant 消息，所以按 messageId 精确匹配：
 * 同一会话可以有多条失败消息，各自保留自己的原因，也不会串到后续新气泡。
 */
export function resolveFailureReasonForMessage(
  turnFailures: TurnFailureReasons,
  message: Message
): string | undefined {
  if (message.status !== 'failed') return undefined
  return turnFailures[message.id]?.trim() || undefined
}
