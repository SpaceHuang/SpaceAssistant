import { useRef } from 'react'
import { Alert, Button, Collapse, Modal } from 'antd'
import type { PlanApprovalSummary, PlanDisplayEntry, PlanMeta } from '../../../shared/planTypes'
import { buildPlanApprovalImpactText } from './planPanelState'
import { usePlanPanelActions } from './PlanPanelActionsContext'
import { PlanPlanCard } from './PlanPlanCard'

type Props = {
  pendingPlan: PlanMeta
  summary: PlanApprovalSummary
  displayPlans: PlanDisplayEntry[]
  onOpenPlanFile: (relPath: string) => void
}

export function PlanPanelApproval({ pendingPlan, summary, displayPlans, onOpenPlanFile }: Props) {
  const actions = usePlanPanelActions()
  const approvalRef = useRef<HTMLDivElement>(null)

  const handleApprove = () => {
    if (!actions) return
    const executing = displayPlans.find((p) => p.status === 'executing')
    if (executing) {
      const step = Math.min(executing.currentStepIndex + 1, Math.max(executing.stepsTotal, 1))
      Modal.confirm({
        title: '确认批准新计划',
        content: `当前计划「${executing.title}」执行到第 ${step}/${executing.stepsTotal || '?'} 步。批准新计划后，旧计划将标记为已取消，新计划加入列表且不会自动开始执行。是否继续？`,
        okText: '继续批准',
        cancelText: '取消',
        onOk: () => actions.onApproveAndExecute({ cancelExecuting: true })
      })
      return
    }
    void actions.onApproveAndExecute()
  }

  const collapseItems =
    displayPlans.length > 0
      ? [
          {
            key: 'list',
            label: `当前计划（${displayPlans.length}）`,
            children: (
              <div className="plan-panel-readonly-list">
                {displayPlans.map((p) => (
                  <PlanPlanCard key={p.planId} entry={p} readonly />
                ))}
              </div>
            )
          }
        ]
      : undefined

  return (
    <div ref={approvalRef} className="plan-panel-approval" data-plan-focus>
      <div className="plan-panel-approval__scroll">
        <h3 className="plan-panel-approval__title">{summary.title}</h3>
        <p className="plan-panel-approval__meta">
          v{pendingPlan.version} · {summary.stepCount} 步
          {summary.fileHintCount > 0 ? ` · 约 ${summary.fileHintCount} 个文件` : ''}
        </p>
        {summary.goalSummary ? <p className="plan-panel-approval__goal">{summary.goalSummary}</p> : null}

        {summary.acceptanceCriteria.length > 0 ? (
          <div className="plan-panel-section">
            <span className="plan-panel-section__label">验收标准</span>
            <ul className="plan-panel-section__list">
              {summary.acceptanceCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {summary.risks.length > 0 ? (
          <div className="plan-panel-section">
            <span className="plan-panel-section__label">风险</span>
            <ul className="plan-panel-section__list plan-panel-section__list--risk">
              {summary.risks.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {summary.placeholderWarnings.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message="含占位符"
            description={summary.placeholderWarnings.join('；')}
            style={{ fontSize: 12 }}
          />
        ) : null}

        <div className="plan-panel-impact">
          <span className="plan-panel-section__label">当前计划影响</span>
          <p className="plan-panel-impact__text">{buildPlanApprovalImpactText(displayPlans)}</p>
        </div>

        {collapseItems ? (
          <Collapse
            size="small"
            className="plan-panel-impact-collapse"
            items={collapseItems}
          />
        ) : null}
      </div>

      <div className="plan-panel-approval__footer">
        <div className="plan-panel-approval__actions">
          <Button type="primary" size="small" loading={actions?.planActionLoading} onClick={handleApprove}>
            批准
          </Button>
          <Button
            size="small"
            loading={actions?.planActionLoading}
            onClick={() =>
              actions?.requestComposerFocus({ prefill: '请描述你对计划的修改意见：', mode: 'plan' })
            }
          >
            修改
          </Button>
          <Button
            size="small"
            loading={actions?.planActionLoading}
            onClick={() =>
              actions?.requestComposerFocus({ prefill: '请说明拒绝原因或修改方向：', mode: 'plan' })
            }
          >
            拒绝
          </Button>
        </div>
        <div className="plan-panel-approval__advanced">
          <Button type="link" size="small" onClick={() => onOpenPlanFile(pendingPlan.planFilePath)}>
            在编辑器中打开（高级）
          </Button>
          <span className="plan-panel-approval__advanced-hint">手改可能破坏结构，建议通过对话迭代</span>
        </div>
      </div>
    </div>
  )
}
