/**
 * 审批线索包任务声明摘要（对比分析 §4-D，可信证据）：来自用户当轮输入，
 * 供审批 Agent 判断「动作是否服务于任务」；折叠空白并截断，保持线索包有界。
 * 由 butlerInvoker（automation 任务 prompt）与桌面链路（当前 turn 用户消息，§6）共用。
 */

/** 审批线索包任务声明摘要上限（有界）：超长任务 prompt 只取前 N 字符。 */
export const APPROVAL_TASK_DIGEST_MAX_CHARS = 500

export function buildApprovalTaskDigest(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= APPROVAL_TASK_DIGEST_MAX_CHARS) return collapsed
  // 按 code point 切割（评审低项：避免劈裂 Unicode 代理对/组合字符）
  return Array.from(collapsed)
    .slice(0, APPROVAL_TASK_DIGEST_MAX_CHARS)
    .join('')
}
