import { summarizeLarkCliConfirmInput } from '../../../shared/larkCliDisplay'
import { formatBrowserToolLabel, formatBrowserToolLabelTitle } from '../Chat/browserConfirmDisplay'
import {
  formatToolLabel,
  formatToolLabelTitle,
  pathBasename,
  type ToolCallDisplayT
} from '../Chat/toolCallDisplay'

type NotificationT = (key: string, options?: Record<string, unknown>) => string

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? text
}

/** 与主界面确认卡片一致的操作对象描述 */
export function formatFloatingActionSummary(
  toolName: string,
  input: Record<string, unknown>,
  tChat: ToolCallDisplayT
): string {
  switch (toolName) {
    case 'write_file': {
      const fileName =
        typeof input.path === 'string' && input.path
          ? pathBasename(input.path)
          : tChat('confirm.write.writeFileFallback')
      return tChat('confirm.write.writeAction', { fileName })
    }
    case 'edit_file': {
      const fileName =
        typeof input.path === 'string' && input.path
          ? pathBasename(input.path)
          : tChat('confirm.write.editFileFallback')
      return tChat('confirm.write.editAction', { fileName })
    }
    case 'run_shell': {
      const cmd = typeof input.command === 'string' ? firstLine(input.command) : ''
      return cmd ? truncate(cmd, 72) : tChat('confirm.shell.executeTitle')
    }
    case 'run_script':
      return tChat('confirm.script.actionSummary')
    case 'run_lark_cli':
      return summarizeLarkCliConfirmInput(input).headline
    case 'browser':
      return formatBrowserToolLabel(input)
    default:
      return formatToolLabel(toolName, input, tChat)
  }
}

export function formatFloatingMainLabel(
  opts: {
    toolName: string
    input: Record<string, unknown>
    totalItems: number
  },
  tChat: ToolCallDisplayT,
  t: NotificationT
): string {
  const { toolName, input, totalItems } = opts
  let line: string

  if (toolName === 'run_shell') {
    const cmd = typeof input.command === 'string' ? firstLine(input.command) : ''
    line = cmd
      ? t('pendingConfirmShell', { command: truncate(cmd, 56) })
      : t('pendingConfirm', { action: tChat('confirm.shell.executeTitle') })
  } else {
    line = t('pendingConfirm', {
      action: formatFloatingActionSummary(toolName, input, tChat)
    })
  }

  if (totalItems > 1) {
    return `${line}${t('morePendingSuffix', { count: totalItems })}`
  }
  return line
}

export function formatFloatingDetailTitle(
  toolName: string,
  input: Record<string, unknown>,
  tChat: ToolCallDisplayT
): string | undefined {
  if (toolName === 'browser') {
    return formatBrowserToolLabelTitle(input)
  }
  return formatToolLabelTitle(toolName, input) ?? formatToolLabel(toolName, input, tChat)
}

export function formatFloatingHoverTitle(
  sessionName: string,
  toolName: string,
  input: Record<string, unknown>,
  totalItems: number,
  tChat: ToolCallDisplayT,
  t: NotificationT
): string {
  const parts: string[] = []
  const detail = formatFloatingDetailTitle(toolName, input, tChat)
  if (detail && detail !== formatFloatingActionSummary(toolName, input, tChat)) {
    parts.push(detail)
  }
  parts.push(t('sessionHint', { session: sessionName }))
  if (totalItems > 1) {
    parts.push(t('morePendingLine', { count: totalItems }))
  }
  return parts.join('\n')
}
