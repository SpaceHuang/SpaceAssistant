import { useState } from 'react'
import { Button, Tag } from 'antd'
import { CheckCircle, XCircle } from 'lucide-react'
import type { PlanDisplayEntry } from '../../../shared/planTypes'
import { usePlanPanelActions } from './PlanPanelActionsContext'

type Props = {
  entry: PlanDisplayEntry
  activePlanId?: string | null
  readonly?: boolean
  onOpenPlanFile?: (relPath: string) => void
}

function statusTag(status: PlanDisplayEntry['status']) {
  switch (status) {
    case 'executing':
      return (
        <Tag className="plan-panel-status-tag" color="processing">
          执行中
        </Tag>
      )
    case 'completed':
      return (
        <Tag className="plan-panel-status-tag" color="success">
          已完成
        </Tag>
      )
    case 'cancelled':
      return <Tag className="plan-panel-status-tag">已取消</Tag>
    case 'approved':
      return (
        <Tag className="plan-panel-status-tag" color="blue">
          已批准
        </Tag>
      )
    default:
      return <Tag className="plan-panel-status-tag">{status}</Tag>
  }
}

export function PlanPlanCard({ entry, activePlanId, readonly, onOpenPlanFile }: Props) {
  const isActivePointer = Boolean(activePlanId && entry.planId === activePlanId)
  const showControls =
    !readonly &&
    isActivePointer &&
    (entry.status === 'executing' || entry.status === 'approved')
  const actions = usePlanPanelActions()
  const ui = actions?.planExecutionUiState
  const resumeBusy = ui?.resumeButtonBusy ?? false
  const resumeDisabled = ui?.resumeButtonDisabled ?? false
  const [expanded, setExpanded] = useState(entry.status !== 'completed')
  const isCompleted = entry.status === 'completed'
  const isCancelled = entry.status === 'cancelled'
  const step =
    entry.status === 'executing'
      ? Math.min(entry.currentStepIndex + 1, Math.max(entry.stepsTotal, 1))
      : null

  const cardClass = [
    'plan-panel-plan-card',
    isActivePointer ? 'plan-panel-plan-card--active' : '',
    isCompleted ? 'plan-panel-plan-card--completed' : '',
    isCancelled ? 'plan-panel-plan-card--cancelled' : '',
    isCompleted && !expanded ? 'plan-panel-plan-card--folded' : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (isCompleted && !expanded) {
    return (
      <div
        className={cardClass}
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => e.key === 'Enter' && setExpanded(true)}
      >
        <CheckCircle size={14} aria-hidden style={{ flexShrink: 0, color: 'var(--sa-primary)' }} />
        <span className="plan-panel-plan-card__title">{entry.title}</span>
        {statusTag(entry.status)}
      </div>
    )
  }

  return (
    <div className={cardClass}>
      <div className="plan-panel-plan-card__header">
        <div className="plan-panel-plan-card__meta-row">
          <div className="plan-panel-plan-card__meta">
            {isCompleted ? <CheckCircle size={14} aria-hidden style={{ color: 'var(--sa-primary)' }} /> : null}
            {isCancelled ? <XCircle size={14} aria-hidden style={{ color: 'var(--sa-text-tertiary)' }} /> : null}
            {statusTag(entry.status)}
            {step !== null ? (
              <span className="plan-panel-plan-card__step">
                第 {step}/{entry.stepsTotal || '?'} 步
              </span>
            ) : null}
          </div>
          {onOpenPlanFile && !readonly ? (
            <Button
              type="link"
              size="small"
              className="plan-panel-plan-card__link plan-panel-plan-card__open-file"
              onClick={() => onOpenPlanFile(entry.planFilePath)}
            >
              打开计划文件
            </Button>
          ) : null}
        </div>
        <span className="plan-panel-plan-card__title">{entry.title}</span>
      </div>
      {entry.summaryOneLine ? <span className="plan-panel-plan-card__summary">{entry.summaryOneLine}</span> : null}
      {showControls ? (
        <div className="plan-panel-plan-card__actions">
          <Button
            type="primary"
            size="small"
            loading={resumeBusy}
            disabled={resumeDisabled}
            onClick={() => void actions?.onPlanResume()}
          >
            {resumeBusy && entry.status === 'executing'
              ? '执行中…'
              : entry.status === 'approved'
                ? '开始执行'
                : '继续执行'}
          </Button>
          {entry.status === 'executing' ? (
            <Button
              size="small"
              danger
              loading={actions?.planActionLoading}
              onClick={() => void actions?.onPlanCancel()}
            >
              取消
            </Button>
          ) : null}
        </div>
      ) : null}
      {isCompleted && expanded ? (
        <Button type="link" size="small" className="plan-panel-plan-card__link" onClick={() => setExpanded(false)}>
          折叠
        </Button>
      ) : null}
    </div>
  )
}
