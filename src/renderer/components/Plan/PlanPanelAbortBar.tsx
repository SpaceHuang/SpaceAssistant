import { Alert, Button } from 'antd'
import type { PlanAbortMeta } from '../../../shared/planTypes'

type Props = {
  abort: PlanAbortMeta
  compact?: boolean
  onDismiss: () => void
}

export function PlanPanelAbortBar({ abort, compact, onDismiss }: Props) {
  return (
    <Alert
      type="warning"
      showIcon
      className={compact ? 'plan-panel-abort-bar plan-panel-abort-bar--compact' : 'plan-panel-abort-bar'}
      message="探索已终止"
      description={
        <div>
          <div className="plan-panel-abort-bar__report">{abort.report.slice(0, compact ? 120 : 400)}</div>
          <Button type="link" size="small" onClick={onDismiss} style={{ padding: 0, marginTop: 4 }}>
            知道了
          </Button>
        </div>
      }
    />
  )
}
