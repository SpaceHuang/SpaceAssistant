/**
 * 审批线索包任务声明摘要（对比分析 §4-D，可信证据）：来自用户当轮输入，
 * 供审批 Agent 判断「动作是否服务于任务」；折叠空白并截断，保持线索包有界。
 * 同时返回截断标记：有损摘要不得单独作为中高风险授权证据。
 * 由 butlerInvoker（automation 任务 prompt）与桌面链路（当前 turn 用户消息，§6）共用。
 */

/** 审批线索包任务声明摘要上限（有界）：超长任务 prompt 只取前 N 字符并标记不完整。 */
export const APPROVAL_TASK_DIGEST_MAX_CHARS = 500

export interface ApprovalTaskEvidence {
  digest: string
  truncated: boolean
}

export interface ApprovalConversationMessage {
  id: string
  role: string
  content: string
}

/**
 * 前序对话只作为不可信的指代解析材料传给审批器，不构成额外授权。
 * 保留最近一条助手回复及其前一条用户请求，覆盖“移除该页”→“标记为废弃吧”一类选择，避免拼入更早任务。
 */
export function buildApprovalConversationContext(
  messages: readonly ApprovalConversationMessage[],
  currentUserMessageId: string,
  maxMessageChars = 1200
): string | undefined {
  const currentIndex = messages.findIndex(message => message.id === currentUserMessageId)
  if (currentIndex < 0) return undefined

  const preceding = messages.slice(0, currentIndex)
  let assistantIndex = -1
  for (let index = preceding.length - 1; index >= 0; index -= 1) {
    if (preceding[index]!.role === 'assistant' && preceding[index]!.content.trim()) { assistantIndex = index; break }
  }
  const priorAssistant = assistantIndex >= 0 ? preceding[assistantIndex] : undefined
  let userIndex = -1
  for (let index = (assistantIndex >= 0 ? assistantIndex - 1 : preceding.length - 1); index >= 0; index -= 1) {
    if (preceding[index]!.role === 'user' && preceding[index]!.content.trim()) { userIndex = index; break }
  }
  const priorUser = userIndex >= 0 ? preceding[userIndex] : undefined
  const selected = [...new Set([...(priorUser ? [priorUser] : []), ...(priorAssistant ? [priorAssistant] : [])])]
    .sort((a, b) => preceding.indexOf(a) - preceding.indexOf(b))
  if (!selected.length) return undefined

  return selected.map(message => {
    const content = message.content.replace(/\s+/g, ' ').trim()
    const clipped = Array.from(content)
    const bounded = clipped.length <= maxMessageChars
      ? content
      : message.role === 'assistant'
        ? `…[较早的助手内容已截断]… ${clipped.slice(-maxMessageChars).join('')}`
        : `${clipped.slice(0, Math.ceil(maxMessageChars * 0.75)).join('')} …[该条消息已截断]… ${clipped.slice(-Math.floor(maxMessageChars * 0.25)).join('')}`
    return `[${message.role === 'user' ? '用户' : '助手'}] ${bounded}`
  }).join('\n')
}

export function buildApprovalTaskEvidence(prompt: string): ApprovalTaskEvidence {
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  const codePoints = Array.from(collapsed)
  if (codePoints.length <= APPROVAL_TASK_DIGEST_MAX_CHARS) return { digest: collapsed, truncated: false }
  // 按 code point 切割（评审低项：避免劈裂 Unicode 代理对/组合字符）
  return {
    digest: codePoints.slice(0, APPROVAL_TASK_DIGEST_MAX_CHARS).join(''),
    truncated: true
  }
}

export function buildApprovalTaskDigest(prompt: string): string {
  return buildApprovalTaskEvidence(prompt).digest
}
