import { useMemo } from 'react'
import type { PendingConfirmItem } from '../services/pendingConfirmStore'
import type { Session } from '../../shared/domainTypes'
import { getPlanExecutionMeta, getPlanMeta } from '../../shared/planTypes'
import { DEFAULT_PLAN_CONFIG } from '../../shared/domainTypes'

export function shouldShowToolConfirm(
  item: PendingConfirmItem,
  ctx: {
    sessions: Session[]
    activeRequestIds: Set<string>
  }
): boolean {
  const session = ctx.sessions.find((s) => s.id === item.sessionId)
  if (!session) return false

  if (!ctx.activeRequestIds.has(item.requestId)) return false

  const planMeta = getPlanMeta(session.metadata)
  const planExec = getPlanExecutionMeta(session.metadata)
  const toolConfirmPolicy = planExec?.toolConfirmPolicy ?? DEFAULT_PLAN_CONFIG.toolConfirmPolicy
  const planRunState = planExec?.runState ?? 'idle'
  const planStatus = planMeta?.status

  if (planRunState === 'running' && toolConfirmPolicy !== 'always_confirm') {
    if (item.toolName === 'run_lark_cli') return true
    if (item.toolName === 'run_script') return true
    if (item.toolName !== 'run_script' && item.toolName !== 'run_lark_cli') return false
  }

  if (planStatus === 'executing' && planRunState !== 'running') {
    return false
  }

  return true
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
  if (item.toolName === 'run_lark_cli') {
    return `${sessionName} · 待确认 · 飞书 CLI`
  }
  return `${sessionName} · ${item.toolName}`
}
