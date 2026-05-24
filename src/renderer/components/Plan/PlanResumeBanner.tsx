import { Alert, Button, Space } from 'antd'
import type { PlanMeta } from '../../../shared/planTypes'

type Props = {
  plan: PlanMeta
  staleWarning?: string
  loading?: boolean
  onResume: () => void
  onCancel: () => void
  onViewPlan?: () => void
}

export function PlanResumeBanner({ plan, staleWarning, loading, onResume, onCancel, onViewPlan }: Props) {
  const step = Math.min(plan.currentStepIndex + 1, Math.max(plan.stepsTotal, 1))
  return (
    <Alert
      type="info"
      showIcon
      className="plan-resume-banner"
      message={`未完成的计划：第 ${step}/${plan.stepsTotal || '?'} 步`}
      description={
        <>
          {staleWarning ? <div style={{ marginBottom: 8 }}>{staleWarning}</div> : null}
          <Space wrap>
            <Button type="primary" size="small" loading={loading} onClick={onResume}>
              继续执行
            </Button>
            {onViewPlan ? (
              <Button size="small" onClick={onViewPlan}>
                查看计划
              </Button>
            ) : null}
            <Button size="small" danger loading={loading} onClick={onCancel}>
              取消计划
            </Button>
          </Space>
        </>
      }
    />
  )
}
