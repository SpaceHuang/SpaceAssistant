import { useMemo } from 'react'
import type { PendingConfirmItem } from '../services/pendingConfirmStore'
import type { Session } from '../../shared/domainTypes'

export function shouldShowToolConfirm(
  item: PendingConfirmItem,
  ctx: {
    sessions: Session[]
    activeRequestIds: Set<string>
  }
): boolean {
  const session = ctx.sessions.find((s) => s.id === item.sessionId)
  if (!session) return false
  return ctx.activeRequestIds.has(item.requestId)
}

export function useActionablePendingConfirms(
  items: PendingConfirmItem[],
  sessions: Session[],
  runningSessions: Record<string, { requestId: string }>
): PendingConfirmItem[] {
  return useMemo(() => {
    const activeRequestIds = new Set<string>()
    for (const meta of Object.values(runningSessions)) {
      activeRequestIds.add(meta.requestId)
    }
    return items.filter((item) => shouldShowToolConfirm(item, { sessions, activeRequestIds }))
  }, [items, sessions, runningSessions])
}

export function labelForPendingConfirmItem(
  item: PendingConfirmItem,
  sessionName: string
): string {
  if (item.toolName === 'run_script') {
    return `${sessionName} · 待确认 · 运行已有脚本`
  }
  if (item.toolName === 'run_shell') {
    return `${sessionName} · 待确认 · Shell 命令`
  }
  if (item.toolName === 'run_lark_cli') {
    return `${sessionName} · 待确认 · 飞书 CLI`
  }
  return `${sessionName} · ${item.toolName}`
}
