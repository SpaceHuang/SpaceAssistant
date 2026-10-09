export type DeferredApprovalNotificationSection = {
  kind: 'user-delegation' | 'untrusted-material' | 'action-summary'
  title: string
  text: string
}

export type DeferredApprovalNotificationDto = {
  channel: 'feishu' | 'wechat'
  todoId: string
  notificationVersion: number
  shortCode: string
  sections: DeferredApprovalNotificationSection[]
  text: string
}

function sanitizeDisplayText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:\\|\\\\[^\s]+|\/)(?:[^\s<>"'`]+[\\/])*[^\s<>"'`]*/g, '[路径已省略]')
    .replace(/\b(?:curl|wget|Invoke-WebRequest|irm|rm|del|sudo|chmod|chown|powershell|pwsh|bash|sh|npm|npx|python|node)\b[^\n]*/gi, '[命令已省略]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|Bearer\s+[^\s]+)\b/gi, '[凭据已省略]')
    .replace(/\b(?:api[_ -]?key|token|password|secret|credential)\s*[:=：]\s*[^\n]+/gi, '[凭据已省略]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function safeText(value: string, fallback: string): string {
  const cleaned = sanitizeDisplayText(value)
  return cleaned && cleaned !== '[命令已省略]' ? cleaned : fallback
}

export function buildDeferredApprovalNotification(input: {
  channel: 'feishu' | 'wechat'
  todoId: string
  notificationVersion: number
  shortCode: string
  expiresAt: number
  toolName: string
  safeActionSummary: string
  userDelegation: string
  untrustedMaterial: string
}): DeferredApprovalNotificationDto {
  if (!input.todoId.trim() || !/^(0[1-9]|[1-9][0-9])$/.test(input.shortCode) ||
    !Number.isInteger(input.notificationVersion) || input.notificationVersion <= 0 || !Number.isFinite(input.expiresAt)) {
    throw new TypeError('DEFERRED_APPROVAL_NOTIFICATION_BINDING_INVALID')
  }
  const sections: DeferredApprovalNotificationSection[] = [
    { kind: 'user-delegation', title: '用户委托', text: safeText(input.userDelegation, '（未提供安全摘要）') },
    { kind: 'untrusted-material', title: '待审查材料', text: '原始材料已隔离省略；请仅基于安全界面中的内容审查。' },
    { kind: 'action-summary', title: '待执行动作', text: safeText(input.safeActionSummary, '（动作摘要不可用，请拒绝）') }
  ]
  const text = [
    `异步审批待办 ${input.shortCode}`,
    `通知版本：${input.notificationVersion}`,
    ...sections.map((section) => `${section.title}：${section.text}`),
    `回复「批准 ${input.shortCode}」或「拒绝 ${input.shortCode}」。`
  ].join('\n\n')
  return { channel: input.channel, todoId: input.todoId, notificationVersion: input.notificationVersion,
    shortCode: input.shortCode, sections, text }
}
