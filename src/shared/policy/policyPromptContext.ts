export interface ImPolicyPromptSnapshot {
  domain: 'im'
  policyBehaviorVersion: string
  revision: number
  snapshot: Record<string, unknown>
}

const KNOWN_VERSIONS = new Set(['im-v1.6', 'im-standard-v2'])
const KNOWN_PACKAGES = new Set(['strict', 'standard', 'loose', 'custom'])

/** Render only validated common IM policy metadata; never infer enablement from channel config. */
export function formatImPolicyPromptContext(policy?: ImPolicyPromptSnapshot): string {
  if (!policy || policy.domain !== 'im' || !KNOWN_VERSIONS.has(policy.policyBehaviorVersion) ||
      !Number.isSafeInteger(policy.revision) || policy.revision < 0 ||
      !policy.snapshot || typeof policy.snapshot !== 'object' || Array.isArray(policy.snapshot)) {
    return '共享 IM 安全策略状态不可读取；按人工确认和禁止规则处理，不要推断自动审核或异步审批通知已启用。'
  }

  const selectedPackage = policy.snapshot.selectedPackage
  const policyPackage = typeof selectedPackage === 'string' && KNOWN_PACKAGES.has(selectedPackage)
    ? selectedPackage : '未知'
  const autoReviewRulesConfigured = policy.policyBehaviorVersion === 'im-standard-v2'
  return `共享 IM 安全策略：行为版本 ${policy.policyBehaviorVersion}，套餐 ${policyPackage}；自动审核规则${autoReviewRulesConfigured ? '已配置，具体操作仍须经过策略判定' : '未确认配置'}；需要人工确认的操作须由原 IM 渠道人工确认。异步人工审批通知由独立安全门禁控制，本策略不改变该门禁。`
}
