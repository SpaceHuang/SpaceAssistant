export type DeferredApprovalNotificationSection = {
  kind: 'user-delegation' | 'untrusted-material' | 'target-summary' | 'impact-summary' | 'reason-summary' | 'action-summary'
  title: string
  text: string
}

export type DeferredApprovalAttachmentInfo = {
  fileName: string
  displayPath: string
  sha256: string
  byteSize: number
}

export type DeferredApprovalNotificationDto = {
  channel: 'feishu' | 'wechat'
  todoId: string
  notificationVersion: number
  shortCode: string
  sections: DeferredApprovalNotificationSection[]
  text: string
  attachmentInfo?: DeferredApprovalAttachmentInfo
}

function sanitizeDisplayText(value: string, options: { allowPath?: boolean } = {}): string {
  return value
    .replace(options.allowPath ? /$^/ : /(?:[A-Za-z]:\\|\\\\[^\s]+|\/)(?:[^\s<>"'`]+[\\/])*[^\s<>"'`]*/g, '[路径已省略]')
    .replace(/\b(?:curl|wget|Invoke-WebRequest|irm|rm|del|sudo|chmod|chown|powershell|pwsh|bash|sh|npm|npx|python|node)\b[^\n]*/gi, '[命令已省略]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|Bearer\s+[^\s]+)\b/gi, '[凭据已省略]')
    .replace(/\b(?:api[_ -]?key|token|password|secret|credential)\s*[:=：]\s*[^\n]+/gi, '[凭据已省略]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function safeText(value: string, fallback: string, options: { allowPath?: boolean } = {}): string {
  const cleaned = sanitizeDisplayText(value, options)
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
  safeTargetSummary?: string
  impactSummary?: string
  reasonSummary?: string
  userDelegation: string
  untrustedMaterial: string
  attachmentInfo?: DeferredApprovalAttachmentInfo
}): DeferredApprovalNotificationDto {
  if (!input.todoId.trim() || !/^(0[1-9]|[1-9][0-9])$/.test(input.shortCode) ||
    !Number.isInteger(input.notificationVersion) || input.notificationVersion <= 0 || !Number.isFinite(input.expiresAt)) {
    throw new TypeError('DEFERRED_APPROVAL_NOTIFICATION_BINDING_INVALID')
  }
  const sections: DeferredApprovalNotificationSection[] = [
    { kind: 'user-delegation', title: '用户委托', text: safeText(input.userDelegation, '（未提供安全摘要）') },
    { kind: 'untrusted-material', title: '待审查材料', text: '原始材料已隔离省略；请仅基于安全界面中的内容审查。' },
    { kind: 'target-summary', title: '作用目标', text: safeText(input.safeTargetSummary ?? '', '（目标摘要不可用）') },
    { kind: 'impact-summary', title: '动作影响', text: safeText(input.impactSummary ?? '', '（影响摘要不可用）') },
    { kind: 'reason-summary', title: '确认原因', text: safeText(input.reasonSummary ?? '', '（策略要求人工确认）') },
    { kind: 'action-summary', title: '待执行动作', text: safeText(input.safeActionSummary, '（动作摘要不可用，请拒绝）') }
  ]
  if (input.attachmentInfo && (!/^[a-f0-9]{64}$/i.test(input.attachmentInfo.sha256) ||
    !Number.isSafeInteger(input.attachmentInfo.byteSize) || input.attachmentInfo.byteSize < 0)) {
    throw new TypeError('DEFERRED_APPROVAL_ATTACHMENT_BINDING_INVALID')
  }
  if (input.attachmentInfo) sections.push({ kind: 'action-summary', title: '待发送文件',
    text: `${safeText(input.attachmentInfo.fileName, '文件名不可用')}，位于 ${safeText(input.attachmentInfo.displayPath, '目录不可用', { allowPath: true })}（${input.attachmentInfo.byteSize} 字节）。批准后发送给上面列出的目标；审批阶段不会传输文件。` })
  const text = [
    `异步审批待办 ${input.shortCode}`,
    `通知版本：${input.notificationVersion}`,
    ...sections.map((section) => `${section.title}：${section.text}`),
    `回复「批准 ${input.shortCode}」或「拒绝 ${input.shortCode}」。`
  ].join('\n\n')
  return { channel: input.channel, todoId: input.todoId, notificationVersion: input.notificationVersion,
    shortCode: input.shortCode, sections, text, ...(input.attachmentInfo ? { attachmentInfo: input.attachmentInfo } : {}) }
}
