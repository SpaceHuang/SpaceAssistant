import { useEffect, useRef } from 'react'
import { App } from 'antd'
import type { PlanApprovalSummary, PlanMeta } from '../../../shared/planTypes'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import {
  derivePlanPanelMainState,
  planPanelBadgeLabel,
  PLAN_PANEL_HEIGHT_BY_STATE
} from './planPanelState'
import { usePlanPanelState } from './usePlanPanelState'
import { PlanPanelEmpty } from './PlanPanelEmpty'
import { PlanPanelDraftingBar } from './PlanPanelDraftingBar'
import { PlanPanelAbortBar } from './PlanPanelAbortBar'
import { PlanPanelApproval } from './PlanPanelApproval'
import { PlanPlanCard } from './PlanPlanCard'
import './planPanel.css'

type Props = {
  sessionId: string | null
}

function fallbackPlanApprovalSummary(plan: PlanMeta): PlanApprovalSummary {
  return {
    title: '计划',
    goalSummary: '',
    stepCount: plan.stepsTotal,
    fileHintCount: 0,
    acceptanceCriteria: [],
    risks: [],
    placeholderWarnings: []
  }
}

export function PlanPanel({ sessionId }: Props) {
  const { message } = App.useApp()
  const { openFile, setReferencedFilesHeight } = useDetailPanel()
  const { planData } = usePlanPanelState(sessionId)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevMainRef = useRef<string | null>(null)

  const mainState = derivePlanPanelMainState(
    planData
      ? {
          pending_plan: planData.pendingPlan ?? undefined,
          display_plans: planData.displayPlans,
          plan_drafting: planData.planDrafting
        }
      : undefined
  )

  useEffect(() => {
    setReferencedFilesHeight(PLAN_PANEL_HEIGHT_BY_STATE[mainState])
    if (mainState === 'pending_approval' && prevMainRef.current !== 'pending_approval') {
      panelRef.current?.classList.add('plan-panel--highlight')
      const t = window.setTimeout(() => panelRef.current?.classList.remove('plan-panel--highlight'), 2400)
      return () => window.clearTimeout(t)
    }
    prevMainRef.current = mainState
  }, [mainState, setReferencedFilesHeight])

  useEffect(() => {
    const onFocus = () => {
      panelRef.current?.querySelector('[data-plan-focus]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    window.addEventListener('plan-focus', onFocus)
    return () => window.removeEventListener('plan-focus', onFocus)
  }, [])

  const handleOpenPlanFile = (relPath: string) => {
    void openFile(relPath).catch((e) => {
      message.error(e instanceof Error ? e.message : String(e))
    })
  }

  const handleDismissAbort = () => {
    if (!sessionId) return
    void window.api.planDismissAbort({ sessionId }).catch((e) => {
      message.error(e instanceof Error ? e.message : String(e))
    })
  }

  const showDraftingOverlay = planData?.planDrafting && mainState !== 'pending_approval'
  const showAbort = planData?.abort && !planData.planAbortDismissed

  return (
    <div ref={panelRef} className={`plan-panel plan-panel--${mainState}`}>
      <div className="referenced-files-header">
        <span className="referenced-files-title">执行计划</span>
        <span className="referenced-files-count">{planPanelBadgeLabel(mainState)}</span>
      </div>
      <div className="plan-panel__body">
        {showAbort ? (
          <PlanPanelAbortBar
            abort={planData.abort}
            compact={mainState === 'pending_approval'}
            onDismiss={handleDismissAbort}
          />
        ) : null}
        {showDraftingOverlay ? <PlanPanelDraftingBar /> : null}
        {mainState === 'pending_approval' && planData?.pendingPlan ? (
          <PlanPanelApproval
            pendingPlan={planData.pendingPlan}
            summary={planData.summary ?? fallbackPlanApprovalSummary(planData.pendingPlan)}
            displayPlans={planData.displayPlans}
            onOpenPlanFile={handleOpenPlanFile}
          />
        ) : null}
        {mainState === 'plans' ? (
          <div className="plan-panel-list">
            {planData?.displayPlans.map((entry) => (
              <PlanPlanCard
                key={entry.planId}
                entry={entry}
                activePlanId={planData.plan?.planId}
                onOpenPlanFile={handleOpenPlanFile}
              />
            ))}
          </div>
        ) : null}
        {mainState === 'empty' ? <PlanPanelEmpty /> : null}
      </div>
    </div>
  )
}
