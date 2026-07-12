import type { ToolCallRecord } from '../../src/shared/domainTypes'
import type { RemoteProgressSnapshot } from '../../src/shared/remoteProgressTypes'
import { firstProgressLine } from '../../src/shared/resolveRemoteProgressSnapshot'
import { updateRemoteProgressSnapshot } from './remoteProgressStore'

export type RemoteProgressHookContext = {
  sessionId: string
  formatToolLabel: (toolName: string, input: Record<string, unknown>) => string
  t: (key: string, options?: Record<string, unknown>) => string
}

export function onRemoteToolStateChange(
  ctx: RemoteProgressHookContext,
  tool: Pick<ToolCallRecord, 'toolName' | 'input' | 'status' | 'progressOutput'>
): void {
  if (tool.status === 'confirming') {
    const action = ctx.formatToolLabel(tool.toolName, tool.input)
    updateRemoteProgressSnapshot(ctx.sessionId, {
      kind: 'confirm',
      label: ctx.t('streaming.awaitingConfirm', { action }),
      publishable: true
    })
    return
  }

  if (tool.status === 'calling' || tool.status === 'executing') {
    const label = ctx.formatToolLabel(tool.toolName, tool.input)
    const detail =
      firstProgressLine(tool.progressOutput) ??
      (tool.status === 'calling' ? ctx.t('streaming.preparing') : undefined)
    updateRemoteProgressSnapshot(ctx.sessionId, {
      kind: 'tool',
      label,
      detail,
      publishable: true
    })
    return
  }

  updateRemoteProgressSnapshot(ctx.sessionId, {
    kind: 'idle',
    label: '',
    publishable: false
  })
}

export function onRemoteToolProgress(
  ctx: RemoteProgressHookContext,
  tool: Pick<ToolCallRecord, 'toolName' | 'input' | 'status' | 'progressOutput'>,
  message?: string
): void {
  if (tool.status !== 'calling' && tool.status !== 'executing') return
  const label = ctx.formatToolLabel(tool.toolName, tool.input)
  const detail = firstProgressLine(message ?? tool.progressOutput) ?? undefined
  updateRemoteProgressSnapshot(ctx.sessionId, {
    kind: 'tool',
    label,
    detail,
    publishable: true
  })
}

export function onRemoteTextSegmentClosed(ctx: RemoteProgressHookContext, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const first = lines[0] ?? ''
  const label = first.length > 72 ? `${first.slice(0, 71)}…` : first
  const secondLine = lines.slice(1).find((l) => l.trim())
  const detail = secondLine ? firstProgressLine(secondLine) : undefined
  updateRemoteProgressSnapshot(ctx.sessionId, {
    kind: 'text',
    label,
    detail,
    publishable: true
  })
}

export function onRemoteThinkingActive(ctx: RemoteProgressHookContext): void {
  updateRemoteProgressSnapshot(ctx.sessionId, {
    kind: 'idle',
    label: ctx.t('streaming.thinking'),
    publishable: false
  })
}

export function formatConfirmHeartbeatLabel(
  ctx: RemoteProgressHookContext,
  toolName: string,
  input: Record<string, unknown>
): string {
  const action = ctx.formatToolLabel(toolName, input)
  return ctx.t('streaming.awaitingConfirm', { action })
}

export function buildConfirmInstantPrompt(args: {
  progressPrefix?: string
  toolName: string
  summary: string
  timeoutMinutes: number
}): string {
  const prefix = args.progressPrefix?.trim()
  const header = prefix ? `${prefix}\n` : ''
  return `${header}${args.summary}\n回复 Y 确认，N 取消（${args.timeoutMinutes} 分钟内有效）`
}

export function buildConfirmHeartbeatText(label: string, maxChars = 400): string {
  const body = label.startsWith('【进度】') ? label : `【进度】${label}`
  return body.length > maxChars ? `${body.slice(0, maxChars - 1)}…` : body
}

export type { RemoteProgressSnapshot }
