import { Card, Col, Row, Tooltip } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { UsageSummary } from '../../../shared/usageStatsTypes'
import { formatCount, formatInteger, formatPercent, formatRatio } from './format'

type Props = {
  summary: UsageSummary | null
  loading?: boolean
}

function NumericValue({ label, value }: { label: string; value: number }) {
  return (
    <Tooltip title={`${label}: ${formatInteger(value)}`}>
      <span data-testid="usage-kpi-value">{formatCount(value)}</span>
    </Tooltip>
  )
}

/** KPI 卡片行（§5.3）：M1–M7 全指标；缓存写入仅在 > 0 时条件展示（M3b / C1）。 */
export function UsageStatsKpiCards({ summary, loading }: Props) {
  const { t } = useTypedTranslation('usageStats')
  if (!summary) return null
  const cacheWriteVisible = summary.cacheCreationTokens > 0

  return (
    <div data-testid="usage-kpi-cards">
      <Row gutter={[12, 12]}>
        <Col span={cacheWriteVisible ? 4 : 5}>
          <Card size="small" loading={loading}>
            <div className="ant-statistic-title">{t('kpi.totalTokens')}</div>
            <div className="ant-statistic-content">
              <NumericValue label={t('kpi.totalTokens')} value={summary.totalTokens} />
            </div>
          </Card>
        </Col>
        <Col span={cacheWriteVisible ? 4 : 5}>
          <Card size="small" loading={loading}>
            <div className="ant-statistic-title">{t('kpi.inputTokens')}</div>
            <div className="ant-statistic-content">
              <NumericValue label={t('kpi.inputTokens')} value={summary.inputTokens} />
            </div>
          </Card>
        </Col>
        <Col span={cacheWriteVisible ? 4 : 5}>
          <Card size="small" loading={loading}>
            <div className="ant-statistic-title">{t('kpi.outputTokens')}</div>
            <div className="ant-statistic-content">
              <NumericValue label={t('kpi.outputTokens')} value={summary.outputTokens} />
            </div>
          </Card>
        </Col>
        <Col span={cacheWriteVisible ? 4 : 5}>
          <Card size="small" loading={loading}>
            <div className="ant-statistic-title">{t('kpi.cacheRead')}</div>
            <div className="ant-statistic-content">
              <NumericValue label={t('kpi.cacheRead')} value={summary.cacheReadTokens} />
            </div>
          </Card>
        </Col>
        <Col span={cacheWriteVisible ? 4 : 4}>
          <Card size="small" loading={loading}>
            <div className="ant-statistic-title">{t('kpi.hitRate')}</div>
            <div className="ant-statistic-content" data-testid="usage-kpi-hit-rate">
              {formatPercent(summary.hitRate)}
            </div>
          </Card>
        </Col>
        <Col span={cacheWriteVisible ? 4 : 5}>
          <Card size="small" loading={loading}>
            <div className="ant-statistic-title">
              <Tooltip title={t('kpi.toolErrorRate')}>
                <span>{t('kpi.toolCalls')}</span>
              </Tooltip>
            </div>
            <div className="ant-statistic-content" data-testid="usage-kpi-tool-calls">
              <Tooltip title={`${t('kpi.toolErrorRate')}: ${formatPercent(summary.toolErrorRate)}`}>
                <span>
                  {formatInteger(summary.toolCallCount)} / {formatInteger(summary.toolErrorCount)}
                </span>
              </Tooltip>
              <span style={{ marginLeft: 8, fontSize: 12 }} data-testid="usage-kpi-tool-skipped">
                {t('kpi.toolSkipped')} {formatInteger(summary.toolSkippedCount)}
              </span>
            </div>
          </Card>
        </Col>
        {cacheWriteVisible && (
          <Col span={4}>
            <Card size="small">
              <div className="ant-statistic-title">{t('kpi.cacheWrite')}</div>
              <div className="ant-statistic-content">
                <NumericValue label={t('kpi.cacheWrite')} value={summary.cacheCreationTokens} />
              </div>
            </Card>
          </Col>
        )}
      </Row>
      <Row style={{ marginTop: 8 }}>
        <Col span={24}>
          <Card size="small" loading={loading}>
            <span data-testid="usage-steps-proof">
              {t('kpi.avgStepsPerTurn')}：{formatRatio(summary.avgStepsPerTurn)}
              （{t('kpi.turns')} {formatInteger(summary.turnCount)} / {t('kpi.steps')} {formatInteger(summary.stepCount)}）
            </span>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
