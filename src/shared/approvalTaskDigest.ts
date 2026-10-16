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
