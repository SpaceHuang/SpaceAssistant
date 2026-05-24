import { Typography } from 'antd'
import type { PlanAbortMeta } from '../../../shared/planTypes'
import { ChatMarkdown } from '../Chat/ChatMarkdown'

const { Title, Text } = Typography

type Props = {
  abort: PlanAbortMeta
}

export function PlanAbortCard({ abort }: Props) {
  return (
    <div className="plan-card plan-card--abort">
      <Title level={5} style={{ margin: 0 }}>
        探索已终止
      </Title>
      {abort.reason ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {abort.reason}
        </Text>
      ) : null}
      <div className="plan-card-section plan-card-markdown">
        <ChatMarkdown content={abort.report} />
      </div>
    </div>
  )
}
