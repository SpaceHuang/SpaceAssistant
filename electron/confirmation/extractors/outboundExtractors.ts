import { classifyLarkCliImpact, classifyLarkMessageTarget } from '../../feishu/larkCliImpactPolicy'
import type { FactSignal } from '../../../src/shared/confirmation/types'
import { inspectImOutboundContent } from '../../../src/shared/confirmation/imOutboundFacts'

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
  const isMessageOutbound = ['message', 'mail'].includes(String(argv[0] ?? '').toLowerCase()) &&
    ['send', 'create', 'reply'].includes(String(argv[1] ?? '').toLowerCase())
  const contentFlags = argv.flatMap((arg, index) => arg === '--text' || arg === '--content' ? [index] : [])
  let outboundContent: FactSignal[] = []
  if (isMessageOutbound) {
    const contentIndex = contentFlags.length === 1 ? contentFlags[0]! : -1
    const body = contentIndex >= 0 && typeof argv[contentIndex + 1] === 'string' ? String(argv[contentIndex + 1]) : undefined
    let assessment = body === undefined
      ? { inspectionCoverage: 'unavailable' as const, evidenceKinds: [] as string[] }
      : inspectImOutboundContent(body)
    const attachmentPresent = argv.some((arg) => ['--file', '--image', '--attachment'].includes(String(arg).toLowerCase()))
    if (attachmentPresent && assessment.inspectionCoverage === 'complete') {
      assessment = { ...assessment, inspectionCoverage: 'partial' }
    }
    outboundContent = [{ kind: 'outbound-content', ...assessment }]
  }
  const signals: FactSignal[] = [
    // 读/写分类信号（high_impact/unknown fail-closed 必确认，等价现 larkCliWriteNeedsConfirm）
    { kind: 'lark-subcommand', impact, category: classification.category, classificationReason: classification.reason, completeness: impact === 'unknown' ? 'partial' : 'complete',
      ...(classification.category === 'message' || classification.category === 'group_message' || classification.category === 'multi_message' ? { messageTarget } : {}) },
    ...outboundContent,
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
