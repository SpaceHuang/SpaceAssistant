import { Alert, Button, Space, Typography } from 'antd'
import type { PlanApprovalSummary, PlanMeta } from '../../../shared/planTypes'

const { Text, Title } = Typography

type Props = {
  plan: PlanMeta
  summary: PlanApprovalSummary
  loading?: boolean
  onApprove: () => void
  onReject: (feedback: string) => void
}

export function PlanApprovalCard({ plan, summary, loading, onApprove, onReject }: Props) {
  return (
    <div className="plan-card plan-card--approval">
      <Title level={5} style={{ margin: 0 }}>
        计划待审批
      </Title>
      <Text type="secondary" style={{ fontSize: 12 }}>
        v{plan.version} · {summary.stepCount} 步 · 约 {summary.fileHintCount} 个文件引用
      </Text>
      <div className="plan-card-section">
        <Text strong>{summary.title}</Text>
        <div style={{ marginTop: 6 }}>{summary.goalSummary}</div>
      </div>
      {summary.acceptanceCriteria.length > 0 ? (
        <div className="plan-card-section">
          <Text type="secondary" style={{ fontSize: 12 }}>
            验收标准
          </Text>
          <ul className="plan-card-list">
            {summary.acceptanceCriteria.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.risks.length > 0 ? (
        <div className="plan-card-section">
          <Text type="secondary" style={{ fontSize: 12 }}>
            风险
          </Text>
          <ul className="plan-card-list plan-card-list--risk">
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
          message="关键字段含占位符"
          description={summary.placeholderWarnings.join('；')}
          style={{ marginTop: 8 }}
        />
      ) : null}
      <Space style={{ marginTop: 12 }} wrap>
        <Button type="primary" loading={loading} onClick={onApprove}>
          批准并执行
        </Button>
        <Button
          loading={loading}
          onClick={() => {
            const feedback = window.prompt('请输入修改意见（将用于迭代计划）')?.trim()
            if (feedback) onReject(feedback)
          }}
        >
          拒绝并反馈
        </Button>
      </Space>
    </div>
  )
}
