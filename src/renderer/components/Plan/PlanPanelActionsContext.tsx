import { useEffect, useState } from 'react'
import type { ChatMode } from '../../../shared/planTypes'
import { planPanelActionsStore } from '../../services/planPanelActionsStore'

export type ComposerFocusRequest = {
  prefill: string
  mode?: ChatMode
}

export type PlanPanelActions = {
  requestComposerFocus: (req: ComposerFocusRequest) => void
  onApproveAndExecute: (options?: { cancelExecuting?: boolean }) => Promise<void>
  onPlanResume: () => Promise<void>
  onPlanCancel: () => Promise<void>
  onPlanRejectWithFeedback: (feedback: string) => Promise<void>
  planActionLoading: boolean
}

export function usePlanPanelActions(): PlanPanelActions | null {
  const [actions, setActions] = useState<PlanPanelActions | null>(() => planPanelActionsStore.get())
  useEffect(() => planPanelActionsStore.subscribe(() => setActions(planPanelActionsStore.get())), [])
  return actions
}
