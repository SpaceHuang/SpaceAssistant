import { classifyLarkCliImpact, classifyLarkMessageTarget } from '../../feishu/larkCliImpactPolicy'
import type { EnvFacts, FactSignal } from '../../../src/shared/confirmation/types'

/** 出站目标提取器：wechat_send/reply 的接收者 → outbound-target 信号。 */
export function extractOutboundTarget(toolInput: Record<string, unknown>): {
  signals: FactSignal[]
  summary: string
} {
  const recipient =
    typeof toolInput.userId === 'string'
      ? toolInput.userId
      : typeof toolInput.text === 'string'
        ? undefined
        : undefined
  const signals: FactSignal[] = [{ kind: 'outbound-target', channel: 'wechat', recipient }]
  return { signals, summary: recipient ? `发送给 ${recipient}` : '发送会话内用户' }
}

/** lark 子命令提取器：lark-cli 子命令 → 读/写事实（复用 classifyLarkCliImpact）。 */
export function extractLarkSubcommand(toolInput: Record<string, unknown>, trustedActorOpenId?: string): {
  signals: FactSignal[]
  summary: string
} {
  const args = toolInput.args
  const argv = Array.isArray(args) ? args : []
  const classification = classifyLarkCliImpact(argv)
  const messageTarget = classification.category === 'group_message' || classification.category === 'multi_message'
    ? 'group-or-multiple'
    : classifyLarkMessageTarget(argv, trustedActorOpenId)
  const { impact } = classification
  const signals: FactSignal[] = [
    // 读/写分类信号（high_impact/unknown fail-closed 必确认，等价现 larkCliWriteNeedsConfirm）
    { kind: 'lark-subcommand', impact, category: classification.category, classificationReason: classification.reason, completeness: impact === 'unknown' ? 'partial' : 'complete',
      ...(classification.category === 'message' || classification.category === 'group_message' || classification.category === 'multi_message' ? { messageTarget } : {}) },
    {
      kind: 'outbound-target',
      channel: 'lark-cli',
      recipient: argv[0] ? String(argv[0]) : undefined
    }
  ]
  return {
    signals,
    summary: `lark-cli ${argv.slice(0, 3).join(' ')}（${impact === 'read' ? '读' : '写'}）`
  }
}
